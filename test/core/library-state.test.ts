import {
  ANDROID_FOLDER_GUIDANCE,
  LibraryManager,
  openNote,
  saveNote,
  whyNotWritable,
  type Note,
} from '../../src/core/library';
import type {
  ExternalLibraryRoot,
  FileStore,
  LibraryAccess,
  LibraryRecordStore,
  LibraryRoot,
  PickFolderResult,
  RecordReadResult,
  RecordWriteResult,
  RecoverResult,
  RestoreResult,
} from '../../src/core/ports';
import { MemoryFileStore } from '../support/memory-file-store';

// Scenarios from specs/library-storage/spec.md. "App-owned folder on iOS" and "Restricted Android
// location" depend on the platform, so only the guidance is covered here.
const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const OTHER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-2',
  name: 'other',
  reference: 'bookmark-2',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });

class FakeRecords implements LibraryRecordStore {
  writes: string[] = [];
  readFails = false;
  writeFails = false;

  constructor(public text: string | null = null) {}

  async read(): Promise<RecordReadResult> {
    if (this.readFails) return { ok: false, failure: { kind: 'provider_error', message: 'read' } };
    return { ok: true, text: this.text };
  }

  async write(text: string): Promise<RecordWriteResult> {
    if (this.writeFails) return { ok: false, failure: { kind: 'provider_error', message: 'write' } };
    this.writes.push(text);
    this.text = text;
    return { ok: true };
  }
}

class FakeAccess implements LibraryAccess {
  readonly stores = new Map<string, MemoryFileStore>();
  /** What `restore` answers per library, when not plainly usable. */
  readonly restoreAnswers = new Map<string, RestoreResult>();
  picks: PickFolderResult[] = [];
  /** Answers for `recover`, oldest first. Empty means success. */
  recoverAnswers: RecoverResult[] = [];
  recovered: string[] = [];
  log: string[] = [];

  storeFor(id: string): MemoryFileStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new MemoryFileStore();
      this.stores.set(id, store);
    }
    return store;
  }

  async pickFolder(): Promise<PickFolderResult> {
    const pick = this.picks.shift();
    if (!pick) throw new Error('unexpected pick');
    return pick;
  }

  async restore(root: LibraryRoot): Promise<RestoreResult> {
    return this.restoreAnswers.get(idOf(root)) ?? { status: 'ok', writable: true };
  }

  async recover(root: LibraryRoot): Promise<RecoverResult> {
    this.recovered.push(idOf(root));
    this.log.push(`recover ${idOf(root)}`);
    return this.recoverAnswers.shift() ?? { ok: true };
  }

  openStore(root: LibraryRoot): FileStore {
    this.log.push(`open ${idOf(root)}`);
    return this.storeFor(idOf(root));
  }
}

function idOf(root: LibraryRoot): string {
  return root.kind === 'app_owned' ? 'app-owned' : root.id;
}

function setup(recordText: string | null = null) {
  const access = new FakeAccess();
  const records = new FakeRecords(recordText);
  return { access, records, manager: new LibraryManager(access, records) };
}

function available(manager: LibraryManager) {
  const state = manager.getState();
  if (state.status !== 'available') throw new Error(`library is ${state.status}`);
  return state;
}

async function opened(store: FileStore, path = 'note.org'): Promise<Note> {
  const result = await openNote(store, path);
  if (result.status !== 'opened') throw new Error(`could not open ${path}`);
  return result.note;
}

function writeCalls(store: MemoryFileStore) {
  return store.calls.filter((call) => call.op === 'replaceFile' || call.op === 'createExclusive');
}

describe('Library location', () => {
  describe('First launch', () => {
    it('activates the app-owned folder, usable at once, and offers a choice', async () => {
      const { manager, records } = setup();

      await manager.start();

      const state = available(manager);
      expect(state.root).toEqual({ kind: 'app_owned' });
      expect(state.libraryId).toBe('app-owned');
      expect(state.writable).toBe(true);
      expect(state.offerFolderChoice).toBe(true);
      expect(whyNotWritable(state)).toBeNull();
      expect(records.text).toBe(JSON.stringify({ version: 1, root: { kind: 'app_owned' } }));
    });

    it('does not offer the choice as a first launch again', async () => {
      const { manager, access, records } = setup();
      await manager.start();

      const next = new LibraryManager(access, records);
      await next.start();

      expect(available(next).offerFolderChoice).toBe(false);
    });

    it('notes can be captured without further setup', async () => {
      const { manager, access } = setup();
      await manager.start();

      const created = await available(manager).store.createExclusive('a.org', new Uint8Array([0x61]));

      expect(created.status).toBe('created');
      expect(access.storeFor('app-owned').paths()).toEqual(['a.org']);
    });
  });

  describe('Choosing a folder', () => {
    it('makes that folder active, with nothing copied, added, or changed', async () => {
      const { manager, access, records } = setup();
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];
      const before = folder.paths();

      const result = await manager.chooseFolder();

      expect(result).toEqual({ status: 'activated', reconnected: false });
      const state = available(manager);
      expect(state.root).toEqual(FOLDER);
      expect(state.offerFolderChoice).toBe(false);
      expect(records.text).toBe(FOLDER_RECORD);
      expect(folder.calls).toEqual([]);
      expect(folder.paths()).toEqual(before);
      expect(access.storeFor('app-owned').paths()).toEqual([]);
    });

    it('its notes are readable through the new store', async () => {
      const { manager, access } = setup();
      access.storeFor('folder-1').writeFile('daily/2026-01-02.org', 'Hello\n');
      await manager.start();
      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];
      await manager.chooseFolder();

      const { entries } = await available(manager).store.list();

      expect(entries.map((entry) => entry.path)).toEqual(['daily', 'daily/2026-01-02.org']);
    });

    it('a cancelled picker changes nothing', async () => {
      const { manager, access, records } = setup();
      await manager.start();
      const before = manager.getState();
      const writes = records.writes.length;
      access.picks = [{ status: 'cancelled' }];

      expect(await manager.chooseFolder()).toEqual({ status: 'cancelled' });

      expect(manager.getState()).toBe(before);
      expect(records.writes).toHaveLength(writes);
    });

    it('stays on the current library when the choice cannot be remembered', async () => {
      const { manager, access, records } = setup();
      await manager.start();
      records.writeFails = true;
      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];

      expect(await manager.chooseFolder()).toMatchObject({ status: 'refused' });

      expect(available(manager).root).toEqual({ kind: 'app_owned' });
    });
  });

  describe('Switching library', () => {
    it('shows the new library, leaving the previous one untouched and available', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      const folderBytes = folder.peek('note.org');

      expect(await manager.useAppOwnedFolder()).toEqual({ status: 'activated', reconnected: false });
      expect(available(manager).root).toEqual({ kind: 'app_owned' });
      expect(folder.peek('note.org')).toEqual(folderBytes);
      expect(writeCalls(folder)).toEqual([]);

      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];
      await manager.chooseFolder();
      const note = await opened(available(manager).store);
      expect(note.text).toBe('Hello\n');
    });

    it('moves between two chosen folders', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      await manager.start();
      access.picks = [{ status: 'picked', root: OTHER, writable: true }];

      expect(await manager.chooseFolder()).toEqual({ status: 'activated', reconnected: false });

      expect(available(manager).libraryId).toBe('folder-2');
    });

    it('a store from the previous library can no longer write or list', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      const previous = available(manager).store;
      const note = await opened(previous);

      await manager.useAppOwnedFolder();
      folder.calls = [];

      const save = await saveNote(previous, note, { title: 'New' });
      const listing = await previous.list();

      expect(save).toMatchObject({ status: 'failed', problem: { kind: 'access_denied' } });
      expect(listing.failures.map((failed) => failed.path)).toEqual(['']);
      expect(folder.calls).toEqual([]);
      expect(folder.peekText('note.org')).toBe('Hello\n');
    });

    it('can leave a folder that has become unavailable', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.start();

      expect((await manager.useAppOwnedFolder()).status).toBe('activated');

      expect(available(manager).root).toEqual({ kind: 'app_owned' });
    });
  });

  it('keeps the current library when the app-owned folder cannot be opened', async () => {
    const { manager, access } = setup(FOLDER_RECORD);
    await manager.start();
    access.restoreAnswers.set('app-owned', { status: 'missing' });

    expect(await manager.useAppOwnedFolder()).toMatchObject({ status: 'refused' });

    expect(available(manager).root).toEqual(FOLDER);
  });

  it('falls back to the app-owned folder, and says so, when the record is unusable', async () => {
    const cases: (string | null)[] = ['not json', 'null', '{"version":99,"root":{"kind":"app_owned"}}', '{"version":1,"root":{"kind":"external"}}'];
    for (const text of cases) {
      const { manager, records } = setup(text);

      await manager.start();

      const state = available(manager);
      expect(state.root).toEqual({ kind: 'app_owned' });
      expect(state.notice).not.toBeNull();
      expect(state.offerFolderChoice).toBe(true);
      expect(records.writes).toEqual([]);
    }
  });

  it('falls back the same way when the record cannot be read', async () => {
    const { manager, records } = setup(FOLDER_RECORD);
    records.readFails = true;

    await manager.start();

    expect(available(manager).notice).not.toBeNull();
    expect(records.text).toBe(FOLDER_RECORD);
  });
});

describe('Lasting folder access', () => {
  it('Restart', async () => {
    const { manager, access, records } = setup();
    await manager.start();
    access.picks = [{ status: 'picked', root: FOLDER, writable: true }];
    await manager.chooseFolder();

    const relaunched = new LibraryManager(access, records);
    await relaunched.start();

    expect(available(relaunched).root).toEqual(FOLDER);
    expect(access.picks).toEqual([]);
  });

  it('Reference needs refreshing', async () => {
    const { manager, access, records } = setup(FOLDER_RECORD);
    const refreshed = { ...FOLDER, reference: 'bookmark-1b' };
    access.restoreAnswers.set('folder-1', { status: 'stale', root: refreshed, writable: true });

    await manager.start();

    expect(available(manager).root).toEqual(refreshed);
    expect(records.text).toBe(JSON.stringify({ version: 1, root: refreshed }));
  });

  it('still opens the folder when the refreshed reference cannot be saved', async () => {
    const { manager, access, records } = setup(FOLDER_RECORD);
    const refreshed = { ...FOLDER, reference: 'bookmark-1b' };
    access.restoreAnswers.set('folder-1', { status: 'stale', root: refreshed, writable: true });
    records.writeFails = true;

    await manager.start();

    expect(available(manager).root).toEqual(refreshed);
  });

  it('refreshes a reference that goes stale during a foreground recheck', async () => {
    const { manager, access, records } = setup(FOLDER_RECORD);
    await manager.start();
    const refreshed = { ...FOLDER, reference: 'bookmark-1b' };
    access.restoreAnswers.set('folder-1', { status: 'stale', root: refreshed, writable: true });

    await manager.recheck();

    expect(available(manager).root).toEqual(refreshed);
    expect(records.text).toContain('bookmark-1b');
  });
});

describe('Loss of folder access', () => {
  describe('Access revoked', () => {
    it.each(['revoked', 'missing'] as const)(
      'explains the loss at launch and keeps the library: %s',
      async (status) => {
        const { manager, access, records } = setup(FOLDER_RECORD);
        access.restoreAnswers.set('folder-1', { status });

        await manager.start();

        const state = manager.getState();
        expect(state).toMatchObject({ status: 'unavailable', reason: status, root: FOLDER });
        expect(whyNotWritable(state)).toMatch(/Choose the folder again/);
        expect(records.text).toBe(FOLDER_RECORD);
        expect(access.stores.has('folder-1')).toBe(false);
      },
    );

    it('does not fall back to another library', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'revoked' });

      await manager.start();

      expect(access.log).toEqual([]);
    });

    it('takes effect during use: no writes, and a failed listing rather than an empty one', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      const { store } = available(manager);
      const note = await opened(store);

      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.recheck();
      folder.calls = [];

      expect(manager.getState().status).toBe('unavailable');
      expect(await saveNote(store, note, { title: 'New' })).toMatchObject({
        status: 'failed',
        problem: { kind: 'access_denied', accessMayBeLost: true },
      });
      expect(await store.createExclusive('new.org', new Uint8Array())).toMatchObject({ status: 'failed' });
      // Reconcile removes nothing after a failed listing (Decision 5).
      const listing = await store.list();
      expect(listing.entries).toEqual([]);
      expect(listing.failures[0].path).toBe('');
      expect(folder.calls).toEqual([]);
      expect(folder.peekText('note.org')).toBe('Hello\n');
    });

    it('a save that fails on lost access leads to the unavailable state through recheck', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      const note = await opened(available(manager).store);
      folder.failOperation('replaceFile', { kind: 'access_denied' });
      access.restoreAnswers.set('folder-1', { status: 'revoked' });

      const result = await saveNote(available(manager).store, note, { title: 'New' });
      expect(result).toMatchObject({ status: 'failed', problem: { accessMayBeLost: true } });
      await manager.recheck();

      expect(manager.getState()).toMatchObject({ status: 'unavailable', reason: 'revoked' });
      expect(folder.peekText('note.org')).toBe('Hello\n');
    });
  });

  describe('Reconnecting', () => {
    it('makes the same folder available again, and the unsaved text can still be saved', async () => {
      const { manager, access, records } = setup(FOLDER_RECORD);
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      const note = await opened(available(manager).store);
      const lostStore = available(manager).store;

      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.recheck();
      const edit = { body: 'Unsaved text.\n' };
      const refused = await saveNote(lostStore, note, edit);
      expect(refused).toMatchObject({ status: 'failed', edit });

      access.restoreAnswers.delete('folder-1');
      const renewed = { ...FOLDER, reference: 'bookmark-new' };
      access.picks = [{ status: 'picked', root: renewed, writable: true }];
      expect(await manager.chooseFolder()).toEqual({ status: 'activated', reconnected: true });

      expect(available(manager).root).toEqual(renewed);
      expect(records.text).toContain('bookmark-new');
      expect(refused.status === 'failed' && refused.edit).toEqual(edit);
      const saved = await saveNote(available(manager).store, note, edit);
      expect(saved.status).toBe('saved');
      expect(folder.peekText('note.org')).toBe('Unsaved text.\n');
    });

    it('does not report a different folder as a reconnection', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.start();
      access.picks = [{ status: 'picked', root: OTHER, writable: true }];

      expect(await manager.chooseFolder()).toEqual({ status: 'activated', reconnected: false });
    });

    it('comes back without a prompt if access returns by itself', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'missing' });
      await manager.start();

      access.restoreAnswers.delete('folder-1');
      await manager.recheck();

      expect(available(manager).root).toEqual(FOLDER);
    });

    it('a cancelled reconnect leaves the library unavailable', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.start();
      access.picks = [{ status: 'cancelled' }];

      await manager.chooseFolder();

      expect(manager.getState()).toMatchObject({ status: 'unavailable', reason: 'revoked' });
    });
  });
});

describe('Provider limits', () => {
  it('Provider doesn’t allow folder access', async () => {
    const { manager, access, records } = setup();
    await manager.start();
    const before = manager.getState();
    const writes = records.writes.length;
    access.picks = [{ status: 'unsupported_provider' }];

    const result = await manager.chooseFolder();

    expect(result).toMatchObject({ status: 'refused', message: expect.stringContaining('provider') });
    expect(manager.getState()).toBe(before);
    expect(records.writes).toHaveLength(writes);
  });

  it('Restricted Android location', async () => {
    const { manager, access } = setup();
    await manager.start();
    const before = manager.getState();
    access.picks = [{ status: 'restricted_location' }];

    expect(await manager.chooseFolder()).toEqual({ status: 'refused', message: ANDROID_FOLDER_GUIDANCE });
    expect(ANDROID_FOLDER_GUIDANCE).toContain('subfolder');
    expect(manager.getState()).toBe(before);
  });

  it('Picker failure', async () => {
    const { manager, access } = setup();
    await manager.start();
    const before = manager.getState();
    access.picks = [{ status: 'picker_failed', message: 'relaunch' }];

    const result = await manager.chooseFolder();

    expect(result).toMatchObject({ status: 'refused', message: expect.stringContaining('Restarting') });
    expect(manager.getState()).toBe(before);
  });

  describe('Read-only location', () => {
    it('reads work, and writes are refused with an explanation', async () => {
      const { manager, access } = setup();
      const folder = access.storeFor('folder-1');
      folder.writeFile('note.org', 'Hello\n');
      await manager.start();
      access.picks = [{ status: 'picked', root: FOLDER, writable: false }];

      await manager.chooseFolder();

      const state = available(manager);
      expect(state.writable).toBe(false);
      expect(whyNotWritable(state)).toMatch(/editing and capture are unavailable/);

      const read = await openNote(state.store, 'note.org', { writable: state.writable });
      expect(read).toMatchObject({ status: 'opened', note: { editable: false, text: 'Hello\n' } });

      const note = await opened(state.store);
      folder.calls = [];
      expect(await saveNote(state.store, note, { title: 'New' })).toMatchObject({
        status: 'failed',
        problem: { kind: 'access_denied' },
      });
      expect(await state.store.createExclusive('new.org', new Uint8Array())).toMatchObject({
        status: 'failed',
      });
      expect(writeCalls(folder)).toEqual([]);
      expect(folder.peekText('note.org')).toBe('Hello\n');
    });

    it('moves to read-only and back when the location changes', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      await manager.start();

      access.restoreAnswers.set('folder-1', { status: 'ok', writable: false });
      await manager.recheck();
      expect(available(manager).writable).toBe(false);

      access.restoreAnswers.set('folder-1', { status: 'ok', writable: true });
      await manager.recheck();
      expect(available(manager).writable).toBe(true);
    });
  });
});

describe('New note format', () => {
  it('Capture when the library can’t be written: there is an explanation to keep the draft under', async () => {
    const { manager, access } = setup(FOLDER_RECORD);
    expect(whyNotWritable(manager.getState())).not.toBeNull();

    access.restoreAnswers.set('folder-1', { status: 'revoked' });
    await manager.start();
    expect(whyNotWritable(manager.getState())).not.toBeNull();
  });
});

describe('Interruption-safe writes', () => {
  describe('Recovery while the folder is unavailable', () => {
    it('finishes recovery before the library can be used', async () => {
      const { manager, access } = setup(FOLDER_RECORD);

      await manager.start();

      expect(access.log).toEqual(['recover folder-1', 'open folder-1']);
    });

    it('waits while access is lost, and runs once access returns', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.restoreAnswers.set('folder-1', { status: 'revoked' });
      await manager.start();
      expect(access.recovered).toEqual([]);

      access.restoreAnswers.delete('folder-1');
      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];
      await manager.chooseFolder();

      expect(access.log).toEqual(['recover folder-1', 'open folder-1']);
    });

    it('keeps the library closed while recovery fails, then finishes it on a later check', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      access.recoverAnswers = [{ ok: false, failure: { kind: 'provider_error', message: 'flaky' } }];

      await manager.start();

      expect(manager.getState()).toMatchObject({ status: 'unavailable', reason: 'recovery_pending' });
      expect(access.log).toEqual(['recover folder-1']);

      await manager.recheck();

      expect(available(manager).root).toEqual(FOLDER);
      expect(access.log).toEqual(['recover folder-1', 'recover folder-1', 'open folder-1']);
    });

    it('does not run recovery again on a recheck that finds nothing changed', async () => {
      const { manager, access } = setup(FOLDER_RECORD);
      await manager.start();
      const before = manager.getState();

      await manager.recheck();

      expect(access.recovered).toEqual(['folder-1']);
      expect(manager.getState()).toBe(before);
    });

    it('recovers a newly chosen folder before activating it', async () => {
      const { manager, access } = setup();
      await manager.start();
      access.log = [];
      access.picks = [{ status: 'picked', root: FOLDER, writable: true }];

      await manager.chooseFolder();

      expect(access.log).toEqual(['recover folder-1', 'open folder-1']);
    });
  });
});

describe('LibraryManager', () => {
  it('tells subscribers about each change until they unsubscribe', async () => {
    const { manager, access } = setup(FOLDER_RECORD);
    const statuses: string[] = [];
    const unsubscribe = manager.subscribe(() => statuses.push(manager.getState().status));

    await manager.start();
    access.restoreAnswers.set('folder-1', { status: 'revoked' });
    await manager.recheck();
    unsubscribe();
    await manager.useAppOwnedFolder();

    expect(statuses).toEqual(['available', 'unavailable']);
  });

  it('runs operations one at a time, so a recheck cannot overlap a switch', async () => {
    const { manager, access } = setup(FOLDER_RECORD);
    await manager.start();
    let releasePick: (pick: PickFolderResult) => void = () => undefined;
    access.pickFolder = () => new Promise((resolve) => (releasePick = resolve));

    const choosing = manager.chooseFolder();
    const rechecking = manager.recheck();
    await new Promise((resolve) => setImmediate(resolve));
    releasePick({ status: 'picked', root: OTHER, writable: true });
    await Promise.all([choosing, rechecking]);

    expect(available(manager).root).toEqual(OTHER);
  });

  it('keeps working after an operation rejects', async () => {
    const { manager, access } = setup(FOLDER_RECORD);
    await manager.start();
    access.pickFolder = async () => {
      throw new Error('broken adapter');
    };

    await expect(manager.chooseFolder()).rejects.toThrow('broken adapter');
    await manager.useAppOwnedFolder();

    expect(available(manager).root).toEqual({ kind: 'app_owned' });
  });

  it('recheck before start does nothing', async () => {
    const { manager } = setup();

    await manager.recheck();

    expect(manager.getState()).toEqual({ status: 'starting' });
  });
});
