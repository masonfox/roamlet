import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';

import type { LibraryIndex } from '../core/index';
import type { ExternalLibraryRoot } from '../core/ports';
import { LibraryProvider, useLibrary } from './library-context';
import { LibraryController } from './library-controller';
import { createTestLibrary, type TestLibrary } from './test-library';

const NOTE = ':PROPERTIES:\n:ID:       aaaaaaaa-0000-4000-8000-000000000001\n:END:\n#+title: Alpha\n';
const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });

let library: TestLibrary;

function setUp(options: Parameters<typeof createTestLibrary>[0] = {}): TestLibrary {
  library = createTestLibrary(options);
  return library;
}

afterEach(async () => {
  await library.dispose();
  jest.restoreAllMocks();
});

async function pathsIn(index: LibraryIndex | null, folder = ''): Promise<string[]> {
  const listing = await index!.listFolder(folder);
  return listing.files.map((file) => file.path);
}

/** Each step's first appearance. A new database goes through extra opens and a delete. */
function firstSteps(log: string[]): string[] {
  return [...new Set(log)].filter((step) => step !== 'index.delete');
}

/** Lets work that callers don't wait for, such as a recheck after a failed listing, finish. */
async function settle(controller: LibraryController): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.refresh();
}

describe('startup', () => {
  it('restores access, recovers, then reconciles', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();

    expect(firstSteps(lib.log)).toEqual(['records.read', 'restore', 'recover', 'index.open', 'list']);
    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.state.status).toBe('available');
    expect(snapshot.store).not.toBeNull();
    expect(snapshot.refreshing).toBe(false);
    expect(snapshot.progress).toBeNull();
    expect(snapshot.failure).toBeNull();
    expect(snapshot.lastRefreshAt).toEqual(lib.services.clock.now());
    expect(snapshot.lastResult?.added).toEqual(['a.org']);
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
  });

  it('runs once however often it is started', async () => {
    const lib = setUp();
    await Promise.all([lib.controller.start(), lib.controller.start()]);
    expect(lib.log.filter((step) => step === 'restore')).toHaveLength(1);
  });

  it('lists nothing when access was revoked, and keeps the index for browsing', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.setRestore({ status: 'revoked' });
    await lib.controller.start();

    expect(firstSteps(lib.log)).toEqual(['records.read', 'restore', 'index.open']);
    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.state.status).toBe('unavailable');
    expect(snapshot.store).toBeNull();
    expect(snapshot.index).not.toBeNull();
  });

  it('does not list a folder whose recovery could not finish', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.setRecover({ ok: false, failure: { kind: 'access_denied', message: 'gone' } });
    await lib.controller.start();

    expect(lib.log).not.toContain('list');
    const { state } = lib.controller.getSnapshot();
    expect(state.status === 'unavailable' && state.reason).toBe('recovery_pending');
  });

  it('reports a startup failure when the services cannot load', async () => {
    setUp();
    const broken = new LibraryController(async () => {
      throw new Error('native module missing');
    });
    await broken.start();

    expect(broken.getSnapshot().state.status).toBe('starting');
    expect(broken.getSnapshot().failure).toMatchObject({
      stage: 'startup',
      detail: 'native module missing',
    });
    expect((await broken.chooseFolder()).status).toBe('refused');
    await broken.close();
  });
});

describe('a failed listing', () => {
  it('removes nothing, keeps the last refresh time, and shows the reconnect state', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const firstRefresh = lib.controller.getSnapshot().lastRefreshAt;
    const { deletes } = lib.databases;

    lib.store.failOperation('list');
    lib.setRestore({ status: 'revoked' });
    await lib.controller.refresh();
    await settle(lib.controller);

    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.lastResult?.listing).toBe('failed');
    expect(snapshot.lastResult?.removed).toEqual([]);
    expect(snapshot.lastRefreshAt).toBe(firstRefresh);
    expect(snapshot.state.status).toBe('unavailable');
    expect(snapshot.store).toBeNull();
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
    expect(lib.databases.deletes).toBe(deletes);
  });

  it('at startup keeps what an earlier run indexed', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    await lib.controller.close();

    const relaunched = new LibraryController(async () => lib.services);
    lib.store.failOperation('list');
    await relaunched.start();

    const snapshot = relaunched.getSnapshot();
    expect(lib.log.slice(-5)).toEqual(['records.read', 'restore', 'recover', 'index.open', 'list']);
    expect(snapshot.lastResult?.listing).toBe('failed');
    expect(snapshot.lastRefreshAt).toBeNull();
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
    await relaunched.close();
  });

  it('keeps entries under one failed folder and refreshes the rest', async () => {
    const lib = setUp({ files: { 'a.org': NOTE, 'daily/b.org': NOTE } });
    await lib.controller.start();

    lib.store.remove('a.org');
    lib.store.failOperation('list', { path: 'daily' });
    await lib.controller.refresh();

    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.lastResult?.listing).toBe('partial');
    expect(snapshot.lastResult?.removed).toEqual(['a.org']);
    expect(await pathsIn(snapshot.index, 'daily')).toEqual(['daily/b.org']);
  });

  it('stops a requested rebuild from deleting the index', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const { deletes } = lib.databases;

    lib.store.failOperation('list');
    await lib.controller.rebuild();

    const snapshot = lib.controller.getSnapshot();
    expect(lib.databases.deletes).toBe(deletes);
    expect(snapshot.lastResult?.listing).toBe('failed');
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
  });
});

describe('a corrupt database', () => {
  it('falls back to rebuild when reconcile rejects', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    lib.store.writeFile('b.org', NOTE);

    lib.log.length = 0;
    lib.databases.damage();
    await lib.controller.refresh();

    // Reconcile lists and then fails on the database, and the rebuild lists again afterwards.
    expect(lib.log[0]).toBe('list');
    expect(lib.log[1]).toBe('index.delete');
    expect(lib.log.at(-1)).toBe('list');
    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.failure).toBeNull();
    expect(snapshot.lastResult?.added.sort()).toEqual(['a.org', 'b.org']);
    expect(await pathsIn(snapshot.index)).toEqual(['a.org', 'b.org']);
  });

  it('reports a failure when rebuild rejects too, and recovers on a later refresh', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();

    lib.databases.damage({ permanent: true });
    await lib.controller.refresh();

    const failed = lib.controller.getSnapshot();
    expect(failed.failure?.stage).toBe('index');
    expect(failed.index).toBeNull();
    expect(failed.refreshing).toBe(false);
    expect(failed.state.status).toBe('available');

    lib.databases.repair();
    await lib.controller.refresh();

    const recovered = lib.controller.getSnapshot();
    expect(recovered.failure).toBeNull();
    expect(await pathsIn(recovered.index)).toEqual(['a.org']);
  });
});

describe('refreshing', () => {
  it('picks up a file changed by a sync tool', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const { revision } = lib.controller.getSnapshot();

    lib.store.writeFile('b.org', NOTE);
    await lib.controller.refresh();

    const snapshot = lib.controller.getSnapshot();
    expect(await pathsIn(snapshot.index)).toEqual(['a.org', 'b.org']);
    expect(snapshot.revision).toBeGreaterThan(revision);
  });

  it('shares one follow-up run between calls made during a run', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();

    lib.log.length = 0;
    await Promise.all([lib.controller.refresh(), lib.controller.refresh(), lib.controller.refresh()]);
    expect(lib.log).toEqual(['list']);
  });

  it('reports progress while running and clears it afterwards', async () => {
    const lib = setUp({ files: { 'a.org': NOTE, 'b.org': NOTE } });
    const seen: { refreshing: boolean; processed?: number; total?: number }[] = [];
    lib.controller.subscribe(() => {
      const { refreshing, progress } = lib.controller.getSnapshot();
      seen.push({ refreshing, processed: progress?.processed, total: progress?.total });
    });
    await lib.controller.start();

    expect(seen).toContainEqual({ refreshing: true, processed: 2, total: 2 });
    expect(seen.at(-1)).toEqual({ refreshing: false });
  });

  it('rebuilds on request', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const { deletes } = lib.databases;
    await lib.controller.rebuild();

    const snapshot = lib.controller.getSnapshot();
    expect(lib.databases.deletes).toBeGreaterThan(deletes);
    expect(snapshot.lastResult?.added).toEqual(['a.org']);
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
  });
});

describe('a broken native call', () => {
  it('still refreshes on return to the foreground when the recheck rejects', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();

    lib.services.access.restore = () => Promise.reject(new Error('module bug'));
    await lib.controller.foreground();

    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.failure).toBeNull();
    expect(snapshot.state.status).toBe('available');
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
  });

  it('reports a rejected recheck that nothing clears afterwards', async () => {
    const lib = setUp();
    await lib.controller.start();

    lib.services.access.restore = () => Promise.reject(new Error('module bug'));
    await lib.controller.recheckAccess();

    expect(lib.controller.getSnapshot().failure).toMatchObject({
      stage: 'access',
      detail: 'module bug',
    });
  });

  it('turns a rejected picker into a refusal and keeps the library', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const before = lib.controller.getSnapshot();

    lib.services.access.pickFolder = () => Promise.reject(new Error('module bug'));
    expect((await lib.controller.chooseFolder()).status).toBe('refused');

    expect(lib.controller.getSnapshot().store).toBe(before.store);
    expect(lib.controller.getSnapshot().index).toBe(before.index);
  });
});

describe('access coming back', () => {
  it('indexes a folder that was unavailable at launch, on return to the foreground', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.storeFor(FOLDER).writeFile('a.org', NOTE);
    lib.setRestore({ status: 'revoked' });
    await lib.controller.start();
    expect(lib.controller.getSnapshot().state.status).toBe('unavailable');

    lib.setRestore({ status: 'ok', writable: true });
    await lib.controller.foreground();

    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.state.status).toBe('available');
    expect(await pathsIn(snapshot.index)).toEqual(['a.org']);
  });

  it('finishes recovery before listing once the folder is back', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.setRecover({ ok: false, failure: { kind: 'access_denied', message: 'gone' } });
    await lib.controller.start();

    lib.setRecover({ ok: true });
    lib.log.length = 0;
    await lib.controller.foreground();

    expect(firstSteps(lib.log)).toEqual(['restore', 'recover', 'list']);
  });
});

describe('switching library', () => {
  it('moves the index and store to the chosen folder, and indexes it', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const before = lib.controller.getSnapshot();
    lib.storeFor(FOLDER).writeFile('picked.org', NOTE);
    lib.setPick({ status: 'picked', root: FOLDER, writable: true });

    const result = await lib.controller.chooseFolder();
    expect(result).toEqual({ status: 'activated', reconnected: false });
    expect(lib.controller.getSnapshot().index).not.toBe(before.index);
    await lib.controller.refresh();

    const snapshot = lib.controller.getSnapshot();
    expect(snapshot.state.status === 'available' && snapshot.state.libraryId).toBe('folder-1');
    expect(await pathsIn(snapshot.index)).toEqual(['picked.org']);
  });

  it('leaves everything alone when the picker gives nothing', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await lib.controller.start();
    const before = lib.controller.getSnapshot();
    lib.setPick({ status: 'picker_failed', message: 'activity' });

    expect((await lib.controller.chooseFolder()).status).toBe('refused');
    expect(lib.controller.getSnapshot().index).toBe(before.index);
    expect(lib.controller.getSnapshot().store).toBe(before.store);
  });

  it('reconnecting the same folder keeps its index and refreshes it', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.storeFor(FOLDER).writeFile('a.org', NOTE);
    await lib.controller.start();
    const { deletes } = lib.databases;

    lib.setRestore({ status: 'revoked' });
    await lib.controller.recheckAccess();
    const lost = lib.controller.getSnapshot();
    expect(lost.state.status).toBe('unavailable');
    expect(await pathsIn(lost.index)).toEqual(['a.org']);

    lib.storeFor(FOLDER).writeFile('b.org', NOTE);
    lib.setPick({ status: 'picked', root: FOLDER, writable: true });
    expect(await lib.controller.chooseFolder()).toEqual({ status: 'activated', reconnected: true });
    await lib.controller.refresh();

    const back = lib.controller.getSnapshot();
    expect(back.index).toBe(lost.index);
    expect(await pathsIn(back.index)).toEqual(['a.org', 'b.org']);
    expect(lib.databases.deletes).toBe(deletes);
  });

  it('switches back to the app-owned folder', async () => {
    const lib = setUp({ record: FOLDER_RECORD, files: { 'own.org': NOTE } });
    await lib.controller.start();

    await lib.controller.switchToAppOwnedFolder();
    await lib.controller.refresh();

    expect(await pathsIn(lib.controller.getSnapshot().index)).toEqual(['own.org']);
  });
});

describe('LibraryProvider', () => {
  function Status() {
    const { state, lastResult } = useLibrary();
    return (
      <Text>
        {state.status}:{lastResult?.added.join(',') ?? 'none'}
      </Text>
    );
  }

  function captureAppState() {
    let listener: ((next: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler as (next: AppStateStatus) => void;
      return { remove };
    });
    AppState.currentState = 'active';
    return { emit: (next: AppStateStatus) => listener?.(next), remove };
  }

  it('throws when useLibrary has no provider', async () => {
    setUp();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(render(<Status />)).rejects.toThrow('LibraryProvider');
  });

  it('starts the library and passes updates to screens', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    await render(
      <LibraryProvider controller={lib.controller}>
        <Status />
      </LibraryProvider>,
    );
    await act(() => lib.controller.start());
    expect(screen.getByText('available:a.org')).toBeTruthy();
  });

  it('rechecks access then reconciles on return from the background only', async () => {
    const lib = setUp({ files: { 'a.org': NOTE } });
    const appState = captureAppState();
    const view = await render(
      <LibraryProvider controller={lib.controller}>
        <Status />
      </LibraryProvider>,
    );
    await act(() => lib.controller.start());

    lib.log.length = 0;
    await act(async () => {
      appState.emit('inactive');
      appState.emit('active');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(lib.log).toEqual([]);

    lib.store.writeFile('b.org', NOTE);
    await act(async () => {
      appState.emit('background');
      appState.emit('active');
      await settle(lib.controller);
    });
    expect(lib.log.slice(0, 2)).toEqual(['restore', 'list']);
    expect(await pathsIn(lib.controller.getSnapshot().index)).toEqual(['a.org', 'b.org']);

    await view.unmount();
    expect(appState.remove).toHaveBeenCalled();
  });

  it('shows the reconnect state when access is lost in the background', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.storeFor(FOLDER).writeFile('a.org', NOTE);
    const appState = captureAppState();
    await render(
      <LibraryProvider controller={lib.controller}>
        <Status />
      </LibraryProvider>,
    );
    await act(() => lib.controller.start());

    lib.setRestore({ status: 'revoked' });
    lib.log.length = 0;
    await act(async () => {
      appState.emit('background');
      appState.emit('active');
      await settle(lib.controller);
    });

    expect(screen.getByText('unavailable:a.org')).toBeTruthy();
    expect(lib.log).toEqual(['restore']);
  });
});
