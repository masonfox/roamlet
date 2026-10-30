import { LibraryIndex } from '../../src/core/index';
import { FILE_STORE_OPERATIONS, MemoryFileStore, sha256Hex } from '../support/memory-file-store';
import { useIndexHost } from './index-helpers';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_H = '00000000-0000-4000-8000-00000000000c';

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

function opsOf(store: MemoryFileStore, op: string): string[] {
  return store.calls.filter((call) => call.op === op).map((call) => call.path as string);
}

describe('reconcile', () => {
  const env = useIndexHost();
  let index: LibraryIndex;

  beforeEach(async () => {
    index = await LibraryIndex.open(env.host, 'lib');
  });
  afterEach(() => index.close());

  it('Scenario: Note and relationship data — a file with both node kinds and links', async () => {
    const store = new MemoryFileStore({
      'a.org': `${note(ID_A, 'File A', `See [[id:${ID_B}][B]].`)}* Heading :tag:\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\nTo [[id:${ID_A}]].\n`,
      'b.org': note(ID_B, 'File B', `Back to [[id:${ID_H}][the heading]].`),
    });

    const result = await index.reconcile(store);

    expect(result.listing).toBe('complete');
    expect(result.added).toEqual(['a.org', 'b.org']);
    const nodes = await index.nodesInFile('a.org');
    expect(nodes.map((node) => [node.id, node.level, node.title, node.tags])).toEqual([
      [ID_A, 0, 'File A', []],
      [ID_H, 1, 'Heading', ['tag']],
    ]);
    expect(nodes[1].startOffset).toBeGreaterThan(0);
    expect((await index.backlinks(ID_B)).map((link) => link.source.id)).toEqual([ID_A]);
    expect((await index.backlinks(ID_A)).map((link) => link.source.id)).toEqual([ID_H]);
    expect((await index.backlinks(ID_H)).map((link) => link.source.id)).toEqual([ID_B]);
    expect((await index.outgoingLinks('a.org')).map((link) => link.targetId)).toEqual([ID_B, ID_A]);
  });

  it('Added: a new file enters the index, and only it is read', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A') });
    await index.reconcile(store);
    store.calls = [];
    store.writeFile('b.org', note(ID_B, 'B'));

    const result = await index.reconcile(store);

    expect(result.added).toEqual(['b.org']);
    expect(result.changed).toEqual([]);
    expect(opsOf(store, 'readBytes')).toEqual(['b.org']);
    expect(await index.resolveLink(ID_B)).toMatchObject({ filePath: 'b.org', title: 'B' });
  });

  it('Scenario: File changed externally — the index reflects the new content', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'Old', 'old words') });
    await index.reconcile(store);
    store.writeFile('a.org', note(ID_A, 'New', `new words [[id:${ID_B}]]`));

    const result = await index.reconcile(store);

    expect(result.changed).toEqual(['a.org']);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'New' });
    expect(await index.search('old')).toEqual([]);
    expect((await index.search('new')).map((hit) => hit.title)).toEqual(['New']);
    expect((await index.outgoingLinks('a.org')).map((link) => link.targetId)).toEqual([ID_B]);
    expect(await index.counts()).toEqual({ files: 1, nodes: 1, links: 1 });
  });

  it('notices a change that keeps the size', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'Aaa') });
    await index.reconcile(store);
    store.writeFile('a.org', note(ID_A, 'Bbb'));

    await index.reconcile(store);

    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'Bbb' });
  });

  it('Scenario: File removed externally — nodes and links leave, links to it become unresolved', async () => {
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A', `Link [[id:${ID_B}][to b]]`),
      'b.org': note(ID_B, 'B', `Link [[id:${ID_A}][to a]]`),
    });
    await index.reconcile(store);
    expect((await index.outgoingLinks('a.org'))[0].target?.id).toBe(ID_B);
    store.remove('b.org');

    const result = await index.reconcile(store);

    expect(result.removed).toEqual(['b.org']);
    expect(await index.resolveLink(ID_B)).toBeNull();
    expect(await index.getFile('b.org')).toBeNull();
    expect(await index.backlinks(ID_A)).toEqual([]);
    expect(await index.outgoingLinks('b.org')).toEqual([]);
    expect((await index.search('B')).map((hit) => hit.filePath)).toEqual(['a.org']);
    expect((await index.outgoingLinks('a.org'))[0].target).toBeNull();
    expect((await index.problems()).unresolvedLinks).toEqual([
      { filePath: 'a.org', sourceId: ID_A, targetId: ID_B, description: 'to b', startOffset: expect.any(Number) },
    ]);
  });

  it('Scenario: File renamed externally — IDs stay the same and links still resolve', async () => {
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A', `Link [[id:${ID_B}]]`),
      'old.org': note(ID_B, 'B'),
    });
    await index.reconcile(store);
    store.rename('old.org', 'moved/new.org');

    const result = await index.reconcile(store);

    expect(result.removed).toEqual(['old.org']);
    expect(result.added).toEqual(['moved/new.org']);
    expect(await index.resolveLink(ID_B)).toMatchObject({ id: ID_B, filePath: 'moved/new.org' });
    expect((await index.outgoingLinks('a.org'))[0].target?.filePath).toBe('moved/new.org');
    expect((await index.listFolder('moved')).files.map((file) => file.path)).toEqual(['moved/new.org']);
  });

  it('updates a title taken from the file name when the file is renamed', async () => {
    const store = new MemoryFileStore({ 'old-name.org': `:PROPERTIES:\n:ID: ${ID_A}\n:END:\nBody\n` });
    await index.reconcile(store);
    store.rename('old-name.org', 'new-name.org');

    await index.reconcile(store);

    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'new-name' });
  });

  it('Scenario: Timestamp changed without a content change — not reprocessed', async () => {
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A', `Link [[id:${ID_B}]]`),
      'b.org': note(ID_B, 'B'),
    });
    await index.reconcile(store);
    const rowids = async () => {
      const db = await env.host.open('index-lib.db');
      const rows = await db.all('SELECT rowid FROM nodes ORDER BY rowid');
      await db.close();
      return rows;
    };
    const before = await rowids();
    store.setMtime('a.org', Date.UTC(2027, 0, 1));
    store.calls = [];

    const result = await index.reconcile(store);

    expect(opsOf(store, 'digest')).toEqual(['a.org']);
    expect(opsOf(store, 'readBytes')).toEqual([]);
    expect(result.changed).toEqual([]);
    expect(await rowids()).toEqual(before);
    expect(await index.getFile('a.org')).toMatchObject({ mtime: Date.UTC(2027, 0, 1) });

    store.calls = [];
    await index.reconcile(store);
    expect(opsOf(store, 'digest')).toEqual([]);
  });

  it('does not hash or read anything when no listed file changed', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A'), 'b.org': note(ID_B, 'B') });
    await index.reconcile(store);
    store.calls = [];

    const result = await index.reconcile(store);

    expect(store.calls).toEqual([{ op: 'list' }]);
    expect(result).toMatchObject({ added: [], changed: [], removed: [] });
  });

  it('indexes only files ending in .org', async () => {
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A'),
      'image.png': 'bytes',
      'a.org.gpg': 'secret',
      'a.org~': 'backup',
      '#a.org#': 'lock',
      '.hidden.org': note(ID_B, 'Hidden'),
      '.git/config.org': note(ID_B, 'Git'),
    });
    store.mkdir('folder.org');
    store.writeFile('folder.org/inner.org', note(ID_H, 'Inner'));

    await index.reconcile(store);

    expect((await index.listFolder('')).files.map((file) => file.path)).toEqual(['a.org']);
    expect((await index.listFolder('')).folders.map((folder) => folder.path)).toEqual(['folder.org']);
    expect(await index.counts()).toMatchObject({ files: 2, nodes: 2 });
    expect(opsOf(store, 'readBytes')).toEqual(['a.org', 'folder.org/inner.org']);
  });

  it('keeps BOM-relative offsets the same as the scanner reports', async () => {
    const store = new MemoryFileStore({ 'a.org': `﻿${note(ID_A, 'A')}* H\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\n` });
    await index.reconcile(store);

    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(store.peek('a.org'));
    const heading = (await index.nodesInFile('a.org'))[1];

    expect(text.slice(heading.startOffset, heading.startOffset + 3)).toBe('* H');
  });

  it('records the line ending and hash of each file', async () => {
    const store = new MemoryFileStore({ 'a.org': '#+title: A\r\nBody\r\n' });
    await index.reconcile(store);

    const db = await env.host.open('index-lib.db');
    const row = await db.get<{ eol: string; hash: string; status: string }>(
      'SELECT eol, hash, status FROM files',
    );
    await db.close();
    expect(row).toEqual({ eol: 'crlf', hash: sha256Hex(store.peek('a.org') as Uint8Array), status: 'ok' });
  });

  it('keeps each file consistent when a file transaction fails', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'Old', `[[id:${ID_B}]]`) });
    await index.reconcile(store);
    await index.close();

    let inserts = 0;
    const host = {
      open: async (name: string) => {
        const db = await env.host.open(name);
        return new Proxy(db, {
          get(target, property) {
            if (property !== 'transaction') {
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            }
            return <T>(work: (tx: typeof db) => Promise<T>) =>
              target.transaction((tx) =>
                work({
                  ...tx,
                  exec: tx.exec.bind(tx),
                  all: tx.all.bind(tx),
                  get: tx.get.bind(tx),
                  run: (sql: string, params?: never[]) => {
                    if (sql.startsWith('INSERT INTO links') && inserts++ === 0) {
                      throw new Error('disk full');
                    }
                    return tx.run(sql, params);
                  },
                } as typeof db),
              );
          },
        });
      },
      delete: (name: string) => env.host.delete(name),
    };
    index = await LibraryIndex.open(host, 'lib');
    store.writeFile('a.org', note(ID_A, 'New', `[[id:${ID_H}]]`));

    await expect(index.reconcile(store)).rejects.toThrow('disk full');

    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'Old' });
    expect((await index.outgoingLinks('a.org')).map((link) => link.targetId)).toEqual([ID_B]);
    expect((await index.search('old')).length).toBe(1);

    await index.reconcile(store);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'New' });
    expect((await index.outgoingLinks('a.org')).map((link) => link.targetId)).toEqual([ID_H]);
  });

  it('reports progress and lets queries see files as they commit', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A'), 'b.org': note(ID_B, 'B') });
    const progress: unknown[] = [];
    const visible: (string | undefined)[] = [];
    const checks: Promise<void>[] = [];

    await index.reconcile(store, {
      onProgress: (step) => {
        progress.push(step);
        checks.push(index.getFile('a.org').then((file) => void visible.push(file?.path)));
      },
    });
    await Promise.all(checks);

    expect(progress).toEqual([
      { processed: 1, total: 2 },
      { processed: 2, total: 2 },
    ]);
    expect(visible[0]).toBe('a.org');
  });

  it('runs one at a time, and shares one follow-up among overlapping calls', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A') });

    const first = index.reconcile(store);
    await Promise.resolve();
    const second = index.reconcile(store);
    const third = index.reconcile(store);
    await Promise.all([first, second, third]);

    expect(second).toBe(third);
    expect(store.calls.filter((call) => call.op === 'list')).toHaveLength(2);
  });

  it('a call made during a run picks up a change the run missed', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'One') });
    await index.reconcile(store);
    store.writeFile('a.org', note(ID_A, 'Two'));
    const running = index.reconcile(store);
    await Promise.resolve();
    const following = index.reconcile(store);
    store.writeFile('a.org', note(ID_A, 'Three'));

    await Promise.all([running, following]);

    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'Three' });
  });
});

describe('index never changes the library', () => {
  const env = useIndexHost();

  it('Scenario: Files untouched by indexing — only read operations reach the store, bytes unchanged', async () => {
    const invalid = new Uint8Array([0x23, 0xff, 0xfe, 0x0a]);
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A', `[[id:${ID_B}]]`),
      'daily/b.org': `﻿${note(ID_B, 'B').replace(/\n/g, '\r\n')}`,
      'copy.org': note(ID_A, 'Conflict copy'),
      'invalid.org': invalid,
      'cloud.org': note(ID_H, 'Cloud'),
      'daily/a.org.conflict-20260115093000': 'text',
      'image.png': 'bytes',
    });
    store.setDownloaded('cloud.org', false);
    const before = new Map(store.paths().map((path) => [path, store.peek(path)]));

    const index = await LibraryIndex.open(env.host, 'lib');
    await index.reconcile(store);
    store.setMtime('a.org', Date.UTC(2027, 0, 1));
    store.writeFile('daily/new.org', note(ID_H, 'New'));
    before.set('daily/new.org', store.peek('daily/new.org'));
    await index.reconcile(store);
    store.failOperation('readBytes', { path: 'copy.org' });
    await index.rebuild(store);
    store.clearFaults();
    await index.listFolder('');
    await index.problems();
    await index.search('a');
    await index.conflictCopies();
    await index.close();

    expect(store.paths()).toEqual([...before.keys()].sort());
    for (const [path, bytes] of before) expect(store.peek(path)).toEqual(bytes);
    const ops = new Set(store.calls.map((call) => call.op));
    expect(ops.has('createExclusive')).toBe(false);
    expect(ops.has('replaceFile')).toBe(false);
    for (const op of ops) expect(FILE_STORE_OPERATIONS).toContain(op);
    expect(ops).toEqual(new Set(['list', 'digest', 'readBytes', 'requestDownload']));
  });
});

describe('library switching and rebuild', () => {
  const env = useIndexHost();

  it('Scenario: Switching library — the index reflects only the newly active library', async () => {
    const first = new MemoryFileStore({ 'first.org': note(ID_A, 'First') });
    const second = new MemoryFileStore({ 'second.org': note(ID_B, 'Second') });

    const index = await LibraryIndex.open(env.host, 'first');
    await index.reconcile(first);
    await index.close();

    const switched = await LibraryIndex.open(env.host, 'second');
    await switched.reconcile(second);
    expect((await switched.listFolder('')).files.map((file) => file.path)).toEqual(['second.org']);
    expect(await switched.resolveLink(ID_A)).toBeNull();
    expect(await switched.search('first')).toEqual([]);
    await switched.close();

    // Coming back doesn't need a rebuild, and still shows only that library.
    const back = await LibraryIndex.open(env.host, 'first');
    expect((await back.listFolder('')).files.map((file) => file.path)).toEqual(['first.org']);
    await back.close();
  });

  it('Scenario: Index missing — a new database fills from the files without user action', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A') });
    const before = await LibraryIndex.open(env.host, 'lib');
    await before.reconcile(store);
    await before.close();
    await env.host.delete('index-lib.db');

    const index = await LibraryIndex.open(env.host, 'lib');
    expect(await index.counts()).toEqual({ files: 0, nodes: 0, links: 0 });
    await index.reconcile(store);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'A' });
    await index.close();
    expect(store.paths()).toEqual(['a.org']);
  });

  it('Scenario: Index format change — no user data is lost and the index comes back', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A') });
    const before = await LibraryIndex.open(env.host, 'lib');
    await before.reconcile(store);
    await before.close();
    const raw = await env.host.open('index-lib.db');
    await raw.exec('PRAGMA user_version = 999');
    await raw.close();

    const index = await LibraryIndex.open(env.host, 'lib');
    await index.reconcile(store);

    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'A' });
    expect(store.peekText('a.org')).toBe(note(ID_A, 'A'));
    await index.close();
  });

  it('Scenario: Requested rebuild — regenerated from every file, matching the files', async () => {
    const store = new MemoryFileStore({
      'a.org': note(ID_A, 'A', `[[id:${ID_B}][b]] findable`),
      'sub/b.org': note(ID_B, 'B'),
    });
    const index = await LibraryIndex.open(env.host, 'lib');
    await index.reconcile(store);
    store.calls = [];
    const db = await env.host.open('index-lib.db');
    await db.run(`UPDATE nodes SET title = 'Wrong'`);
    await db.close();

    const result = await index.rebuild(store);

    expect(result.added).toEqual(['a.org', 'sub/b.org']);
    expect(store.calls.filter((call) => call.op === 'readBytes')).toHaveLength(2);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'A' });
    expect((await index.listFolder('')).folders.map((folder) => folder.name)).toEqual(['sub']);
    expect((await index.backlinks(ID_B)).map((link) => link.source.id)).toEqual([ID_A]);
    expect((await index.search('findable')).map((hit) => hit.filePath)).toEqual(['a.org']);
    await index.close();
  });
});
