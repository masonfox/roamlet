import {
  conflictCopies,
  createNote,
  isConflictCopyPath,
  isNotePath,
  openNote,
  saveConflictCopy,
  saveNote,
  type EditableNote,
  type Note,
  type NoteEdit,
} from '../../src/core/library';
import type { NewNote } from '../../src/core/org';
import type { Clock, CreateResult, DigestResult, FileStoreFailureKind } from '../../src/core/ports';
import { MemoryFileStore, sha256Hex } from '../support/memory-file-store';

// Scenarios from specs/note-capture-editing/spec.md and specs/library-storage/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const ORIGINAL = `:PROPERTIES:\n:ID:   ${ID}\n:END:\n#+TITLE:   Old\n\nFirst line.\n`;
const EDIT: NoteEdit = { body: '\nEdited line.\n' };
const EDITED = `:PROPERTIES:\n:ID:   ${ID}\n:END:\n#+TITLE:   Old\n\nEdited line.\n`;
const CLOCK: Clock = { now: () => new Date(2026, 0, 15, 9, 30, 0) };
const NEW_NOTE: NewNote = {
  id: ID,
  title: 'Café Notes!',
  fileName: '20260115093000-cafe_notes.org',
  content: `:PROPERTIES:\n:ID:       ${ID}\n:END:\n#+title: Café Notes!\n`,
};
const FAILURE_KINDS: FileStoreFailureKind[] = [
  'access_denied',
  'not_found',
  'not_downloaded',
  'provider_error',
];

async function open(store: MemoryFileStore, path = 'note.org'): Promise<Note> {
  const result = await openNote(store, path);
  if (result.status !== 'opened') throw new Error(`could not open ${path}`);
  return result.note;
}

async function openEditable(store: MemoryFileStore, path = 'note.org'): Promise<EditableNote> {
  const note = await open(store, path);
  if (!note.editable) throw new Error(`${path} is not editable`);
  return note;
}

function writes(store: MemoryFileStore) {
  return store.calls.filter((call) => call.op === 'replaceFile' || call.op === 'createExclusive');
}

describe('Stale edit protection', () => {
  describe('External change during editing', () => {
    it('leaves a file changed after opening, and offers the edit back', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.writeFile('note.org', 'Changed by a sync tool.\n');

      const result = await saveNote(store, note, EDIT);

      expect(result).toEqual({ status: 'stale', edit: EDIT, currentHash: sha256Hex(store.peek('note.org')!) });
      expect(store.peekText('note.org')).toBe('Changed by a sync tool.\n');
    });

    it('leaves a file that changes just before the replace', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.changeBeforeNextReplace('note.org', 'Changed at the last moment.\n');

      const result = await saveNote(store, note, EDIT);

      expect(result.status).toBe('stale');
      expect(store.peekText('note.org')).toBe('Changed at the last moment.\n');
    });

    it('offers the reload choice: opening again gives the current file, and saves apply to it', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.writeFile('note.org', ORIGINAL.replace('First', 'Second'));
      expect((await saveNote(store, note, EDIT)).status).toBe('stale');

      const reloaded = await openEditable(store);
      expect(reloaded.text).toBe(ORIGINAL.replace('First', 'Second'));
      expect((await saveNote(store, reloaded, { body: 'Merged.\n' })).status).toBe('saved');
      expect(store.peekText('note.org')).toContain('Merged.');
    });

    it('still protects a change that lands between hashing and reading at open', async () => {
      class ChangesAfterDigest extends MemoryFileStore {
        async digest(path: string): Promise<DigestResult> {
          const result = await super.digest(path);
          this.writeFile(path, 'Changed between the calls.\n');
          return result;
        }
      }
      const store = new ChangesAfterDigest({ 'note.org': ORIGINAL });
      const note = await open(store);

      expect((await saveNote(store, note, EDIT)).status).toBe('stale');
      expect(store.peekText('note.org')).toBe('Changed between the calls.\n');
    });
  });

  describe('Saving a conflict copy', () => {
    it('creates note.org.conflict-<timestamp> beside the note, with the note unchanged', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await openEditable(store);
      store.writeFile('note.org', 'Changed by a sync tool.\n');

      const result = await saveConflictCopy(store, CLOCK, note, EDIT);

      expect(result).toEqual({ status: 'created', path: 'note.org.conflict-20260115093000' });
      expect(store.peekText('note.org.conflict-20260115093000')).toBe(EDITED);
      expect(store.peekText('note.org')).toBe('Changed by a sync tool.\n');
    });

    it('stays beside a note in a subfolder', async () => {
      const store = new MemoryFileStore({ 'daily/note.org': ORIGINAL });
      const note = await openEditable(store, 'daily/note.org');

      const result = await saveConflictCopy(store, CLOCK, note, EDIT);

      expect(result).toEqual({ status: 'created', path: 'daily/note.org.conflict-20260115093000' });
    });

    it('is not a note, and is listed in diagnostics', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await openEditable(store);
      await saveConflictCopy(store, CLOCK, note, EDIT);

      const { entries } = await store.list();
      const copies = conflictCopies(entries).map((entry) => entry.path);

      expect(copies).toEqual(['note.org.conflict-20260115093000']);
      expect(isNotePath(copies[0])).toBe(false);
      expect(isConflictCopyPath(copies[0])).toBe(true);
      expect(isConflictCopyPath('note.org')).toBe(false);
    });

    it('never replaces an earlier copy from the same second', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await openEditable(store);
      const first = await saveConflictCopy(store, CLOCK, note, { body: 'One.\n' });
      const second = await saveConflictCopy(store, CLOCK, note, { body: 'Two.\n' });

      expect(first).toEqual({ status: 'created', path: 'note.org.conflict-20260115093000' });
      expect(second).toEqual({ status: 'created', path: 'note.org.conflict-20260115093000-2' });
      expect(store.peekText('note.org.conflict-20260115093000')).toContain('One.');
      expect(isConflictCopyPath('note.org.conflict-20260115093000-2')).toBe(true);
      expect(isNotePath('note.org.conflict-20260115093000-2')).toBe(false);
    });

    it('keeps the edit available when the copy fails', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await openEditable(store);
      store.failOperation('createExclusive');

      const result = await saveConflictCopy(store, CLOCK, note, EDIT);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'provider_error' } });
      expect(store.paths()).toEqual(['note.org']);
    });
  });
});

describe('Interruption-safe writes', () => {
  describe('Failed write', () => {
    it.each(FAILURE_KINDS)('keeps the file and the edit, and shows an error: %s', async (kind) => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.failOperation('replaceFile', { kind });

      const result = await saveNote(store, note, EDIT);

      expect(result).toMatchObject({ status: 'failed', edit: EDIT, problem: { kind } });
      if (result.status === 'failed') expect(result.problem.message).not.toBe('');
      expect(store.peekText('note.org')).toBe(ORIGINAL);
    });

    it('succeeds on a retry of the same note once the fault clears', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.failOperation('replaceFile', { times: 1 });

      expect((await saveNote(store, note, EDIT)).status).toBe('failed');
      expect((await saveNote(store, note, EDIT)).status).toBe('saved');
      expect(store.peekText('note.org')).toBe(EDITED);
    });

    it('counts a retry as saved when the failed write had landed', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.failOperation('replaceFile', { afterWrite: true, times: 1 });

      expect((await saveNote(store, note, EDIT)).status).toBe('failed');
      expect(store.peekText('note.org')).toBe(EDITED);

      const retry = await saveNote(store, note, EDIT);
      expect(retry.status).toBe('saved');
      if (retry.status === 'saved') expect(retry.note.hash).toBe(sha256Hex(store.peek('note.org')!));
    });

    it('stays stale when the bytes that landed are not the edit', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.failOperation('replaceFile', { afterWrite: true, times: 1 });
      await saveNote(store, note, EDIT);

      expect((await saveNote(store, note, { body: 'Something else.\n' })).status).toBe('stale');
      expect(store.peekText('note.org')).toBe(EDITED);
    });

    it('stays stale when the current file cannot be read to compare', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await open(store);
      store.writeFile('note.org', EDITED);
      store.failOperation('readBytes');

      expect((await saveNote(store, note, EDIT)).status).toBe('stale');
    });
  });
});

describe('Plain-text editing', () => {
  it('Provider rejects a save', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await open(store);
    store.failOperation('replaceFile', { kind: 'provider_error' });

    const result = await saveNote(store, note, EDIT);

    expect(result).toMatchObject({ status: 'failed', edit: EDIT });
    if (result.status === 'failed') {
      expect(result.problem.message).toContain('weren’t saved');
      expect(result.problem.accessMayBeLost).toBe(false);
    }
    expect(store.peekText('note.org')).toBe(ORIGINAL);
  });

  it('Provider rejects a save: access is lost while editing', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await open(store);
    store.setReadOnly();

    const result = await saveNote(store, note, EDIT);

    expect(result).toMatchObject({
      status: 'failed',
      edit: EDIT,
      problem: { kind: 'access_denied', accessMayBeLost: true },
    });
    expect(store.peekText('note.org')).toBe(ORIGINAL);
  });

  it('reports a note deleted during editing without recreating it', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL, 'other.org': 'x\n' });
    const note = await open(store);
    store.remove('note.org');

    const result = await saveNote(store, note, EDIT);

    expect(result).toMatchObject({
      status: 'failed',
      edit: EDIT,
      problem: { kind: 'not_found', accessMayBeLost: true },
    });
    expect(store.paths()).toEqual(['other.org']);
  });

  it('reports a note that cannot be opened instead of showing it empty', async () => {
    const store = new MemoryFileStore();
    store.writeFile('note.org', ORIGINAL, { downloaded: false });

    const result = await openNote(store, 'note.org');

    expect(result).toMatchObject({ status: 'failed', problem: { kind: 'not_downloaded' } });
  });
});

describe('Non-destructive save', () => {
  it('Save without changes', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await openEditable(store);
    store.calls = [];

    const body = ORIGINAL.slice(ORIGINAL.indexOf('First'));
    const result = await saveNote(store, note, { title: 'Old', body: `\n${body}` });

    expect(result).toEqual({ status: 'unchanged', note });
    expect(store.calls).toEqual([]);
  });

  it('Body edit', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await open(store);

    const result = await saveNote(store, note, EDIT);

    expect(result.status).toBe('saved');
    expect(store.peekText('note.org')).toBe(EDITED);
  });

  it('Title edit', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await open(store);

    await saveNote(store, note, { title: 'New' });

    expect(store.peekText('note.org')).toBe(ORIGINAL.replace('#+TITLE:   Old', '#+TITLE:   New'));
    expect(store.paths()).toEqual(['note.org']);
  });

  it('applies a title and body edit together', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const note = await open(store);

    await saveNote(store, note, { title: 'New', body: '\nEdited line.\n' });

    expect(store.peekText('note.org')).toBe(EDITED.replace('#+TITLE:   Old', '#+TITLE:   New'));
  });

  it('adds a title to a file without one when the body also changes', async () => {
    const store = new MemoryFileStore({ 'note.org': 'Only text.\n' });
    const note = await open(store);

    await saveNote(store, note, { title: 'New', body: 'Changed text.\n' });

    expect(store.peekText('note.org')).toBe('#+title: New\nChanged text.\n');
  });

  it('CRLF file', async () => {
    const store = new MemoryFileStore({ 'note.org': `#+title: T\r\n\r\nOne\r\nTwo\r\n` });
    const note = await open(store);

    await saveNote(store, note, { body: '\nOne\nInserted\nTwo\n' });

    expect(store.peekText('note.org')).toBe('#+title: T\r\n\r\nOne\r\nInserted\r\nTwo\r\n');
  });

  it('saves again from the note a save returned', async () => {
    const store = new MemoryFileStore({ 'note.org': ORIGINAL });
    const first = await saveNote(store, await open(store), EDIT);
    if (first.status !== 'saved') throw new Error('expected a save');

    const second = await saveNote(store, first.note, { body: 'Again.\n' });

    expect(second.status).toBe('saved');
    expect(store.peekText('note.org')).toContain('Again.');
  });
});

describe('New note format', () => {
  it('Capture to a chosen folder: written in the root', async () => {
    const store = new MemoryFileStore({ 'daily/a.org': 'a\n' });

    const result = await createNote(store, NEW_NOTE);

    expect(result).toEqual({ status: 'created', path: NEW_NOTE.fileName });
    expect(store.peekText(NEW_NOTE.fileName)).toBe(NEW_NOTE.content);
  });

  describe('Filename collision', () => {
    it('picks a different name when the exact name exists, and leaves that file', async () => {
      const store = new MemoryFileStore({ [NEW_NOTE.fileName]: 'existing\n' });

      const result = await createNote(store, NEW_NOTE);

      expect(result).toEqual({ status: 'created', path: '20260115093000-cafe_notes_2.org' });
      expect(store.peekText(NEW_NOTE.fileName)).toBe('existing\n');
    });

    it.each([
      ['a different case', '20260115093000-CAFE_NOTES.org', NEW_NOTE],
      [
        'a different Unicode normalization',
        '20260115093000-café.org',
        { ...NEW_NOTE, fileName: '20260115093000-café.org' },
      ],
      ['a folded character', '20260115093000-STRASSE.org', { ...NEW_NOTE, fileName: '20260115093000-straße.org' }],
    ])('treats %s as a collision', async (_name, existing, note) => {
      const store = new MemoryFileStore({ [existing]: 'existing\n' });

      const result = await createNote(store, note);

      expect(result).toEqual({
        status: 'created',
        path: note.fileName.replace('.org', '_2.org'),
      });
      expect(store.peekText(existing)).toBe('existing\n');
    });

    it('counts a folder with that name, and an undownloaded file', async () => {
      const store = new MemoryFileStore();
      store.mkdir('20260115093000-cafe_notes.org');
      store.writeFile('20260115093000-cafe_notes_2.org', 'x\n', { downloaded: false });

      const result = await createNote(store, NEW_NOTE);

      expect(result).toEqual({ status: 'created', path: '20260115093000-cafe_notes_3.org' });
    });

    it('ignores a same-named file in a subfolder', async () => {
      const store = new MemoryFileStore({ [`daily/${NEW_NOTE.fileName}`]: 'x\n' });

      expect(await createNote(store, NEW_NOTE)).toEqual({ status: 'created', path: NEW_NOTE.fileName });
    });

    it('moves on when a create finds the name taken after the listing', async () => {
      class CreatedSinceListing extends MemoryFileStore {
        async createExclusive(path: string, bytes: Uint8Array): Promise<CreateResult> {
          if (path === NEW_NOTE.fileName) return { status: 'exists' };
          return super.createExclusive(path, bytes);
        }
      }
      const store = new CreatedSinceListing();

      expect(await createNote(store, NEW_NOTE)).toEqual({
        status: 'created',
        path: '20260115093000-cafe_notes_2.org',
      });
    });

    it('fails rather than looping when every name is taken', async () => {
      class AlwaysExists extends MemoryFileStore {
        async createExclusive(): Promise<CreateResult> {
          return { status: 'exists' };
        }
      }

      const result = await createNote(new AlwaysExists(), NEW_NOTE);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'name_taken' } });
    });

    it('writes nothing when the folder cannot be listed to check for collisions', async () => {
      const store = new MemoryFileStore();
      store.failOperation('list');

      const result = await createNote(store, NEW_NOTE);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'provider_error' } });
      expect(writes(store)).toEqual([]);
    });

    it('is not blocked by a failure in an unrelated subfolder', async () => {
      const store = new MemoryFileStore({ 'daily/a.org': 'a\n' });
      store.failOperation('list', { path: 'daily' });

      expect(await createNote(store, NEW_NOTE)).toEqual({ status: 'created', path: NEW_NOTE.fileName });
    });
  });

  it('Capture when the library can’t be written: reports the failure and creates nothing', async () => {
    const store = new MemoryFileStore();
    store.setReadOnly();

    const result = await createNote(store, NEW_NOTE);

    expect(result).toMatchObject({ status: 'failed', problem: { kind: 'access_denied' } });
    expect(store.paths()).toEqual([]);
  });
});

describe('Filename integrity', () => {
  describe('Provider alters a new file’s name', () => {
    it('reports the failure and does not report the note as saved', async () => {
      const store = new MemoryFileStore();
      store.alterCreatedNames((name) => `${name}.txt`);

      const result = await createNote(store, NEW_NOTE);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'name_changed' } });
      expect(store.paths()).toEqual([]);
    });

    it('reports the failure when the adapter could not clean up', async () => {
      const store = new MemoryFileStore();
      store.alterCreatedNames((name) => `${name}.txt`, { leaveBehind: true });

      const result = await createNote(store, NEW_NOTE);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'name_changed' } });
    });

    it('does not trust a created result for a different path', async () => {
      class WrongPath extends MemoryFileStore {
        async createExclusive(path: string): Promise<CreateResult> {
          return { status: 'created', path: `${path}.txt` };
        }
      }

      const result = await createNote(new WrongPath(), NEW_NOTE);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'name_changed' } });
    });

    it('applies to conflict copies too', async () => {
      const store = new MemoryFileStore({ 'note.org': ORIGINAL });
      const note = await openEditable(store);
      store.alterCreatedNames((name) => `${name}.txt`);

      const result = await saveConflictCopy(store, CLOCK, note, EDIT);

      expect(result).toMatchObject({ status: 'failed', problem: { kind: 'name_changed' } });
      expect(store.paths()).toEqual(['note.org']);
    });
  });
});
