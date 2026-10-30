import type {
  CreateResult,
  DigestResult,
  FileStoreFailureKind,
  ListResult,
  ReplaceResult,
} from '../../src/core/ports';
import {
  fileStoreContractCases,
  runFileStoreContract,
  runFileStoreContractCase,
  type FileStoreContractHarness,
} from '../support/file-store-contract';
import { FILE_STORE_OPERATIONS, MemoryFileStore, sha256Hex } from '../support/memory-file-store';

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (text: string) => sha256Hex(bytes(text));

const harness: FileStoreContractHarness = {
  open: async (files) => ({ store: new MemoryFileStore(files) }),
};

function listedPaths(result: ListResult): string[] {
  return result.entries.map((entry) => entry.path);
}

describe('FileStore contract: MemoryFileStore', () => {
  test.each(fileStoreContractCases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await runFileStoreContractCase(c, harness);
  });
});

describe('FileStore contract: catches broken stores', () => {
  class OverwritingCreate extends MemoryFileStore {
    async createExclusive(path: string, content: Uint8Array): Promise<CreateResult> {
      this.writeFile(path, content);
      return { status: 'created', path };
    }
  }
  class UncheckedReplace extends MemoryFileStore {
    async replaceFile(path: string, content: Uint8Array): Promise<ReplaceResult> {
      this.writeFile(path, content);
      return { status: 'replaced', hash: sha256Hex(content) };
    }
  }
  class UppercaseDigest extends MemoryFileStore {
    async digest(path: string): Promise<DigestResult> {
      const result = await super.digest(path);
      return result.ok ? { ok: true, hash: result.hash.toUpperCase() } : result;
    }
  }
  class ListsHidden extends MemoryFileStore {
    async list(): Promise<ListResult> {
      const result = await super.list();
      const entry = { name: '.git', path: '.git', size: 0, mtime: 1, isDir: true };
      return { ...result, entries: [...result.entries, { ...entry, downloaded: true, writable: true }] };
    }
  }

  test.each([
    ['createExclusive overwrites', OverwritingCreate, 'createExclusive never replaces'],
    ['replaceFile skips the check', UncheckedReplace, 'replaceFile leaves the file untouched'],
    ['digest is uppercase', UppercaseDigest, 'digest is lowercase'],
    ['list shows hidden entries', ListsHidden, 'list returns visible files'],
  ])('%s', async (_name, Store, expectedFailure) => {
    const results = await runFileStoreContract({
      open: async (files) => ({ store: new Store(files) }),
    });
    const failed = results.filter((result) => result.error !== undefined).map((result) => result.name);
    expect(failed.some((name) => name.startsWith(expectedFailure))).toBe(true);
  });

  test('every case passes, and the library is disposed of each time', async () => {
    let disposed = 0;
    const results = await runFileStoreContract({
      open: async (files) => ({
        store: new MemoryFileStore(files),
        dispose: async () => {
          disposed += 1;
        },
      }),
    });
    expect(results.filter((result) => result.error !== undefined)).toEqual([]);
    expect(results).toHaveLength(fileStoreContractCases.length);
    expect(disposed).toBe(fileStoreContractCases.length);
  });
});

describe('MemoryFileStore faults', () => {
  const failureKinds: FileStoreFailureKind[] = [
    'not_found',
    'access_denied',
    'not_downloaded',
    'provider_error',
    'name_changed',
  ];

  describe('provider error at each operation', () => {
    const originalHash = hash('old');

    test('list', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.failOperation('list');
      const result = await store.list();
      expect(result.entries).toEqual([]);
      expect(result.failures).toEqual([
        { path: '', failure: { kind: 'provider_error', message: expect.any(String) } },
      ]);
    });

    test('readBytes', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.failOperation('readBytes');
      expect(await store.readBytes('a.org')).toMatchObject({
        ok: false,
        failure: { kind: 'provider_error' },
      });
    });

    test('digest', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.failOperation('digest');
      expect(await store.digest('a.org')).toMatchObject({
        ok: false,
        failure: { kind: 'provider_error' },
      });
    });

    test('createExclusive writes nothing', async () => {
      const store = new MemoryFileStore();
      store.failOperation('createExclusive');
      expect(await store.createExclusive('a.org', bytes('new'))).toMatchObject({
        status: 'failed',
        failure: { kind: 'provider_error' },
      });
      expect(store.paths()).toEqual([]);
    });

    test('replaceFile keeps the old content', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.failOperation('replaceFile');
      expect(await store.replaceFile('a.org', bytes('new'), originalHash)).toMatchObject({
        status: 'failed',
        failure: { kind: 'provider_error' },
      });
      expect(store.peekText('a.org')).toBe('old');
    });

    test('replaceFile can fail after the new content landed', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.failOperation('replaceFile', { afterWrite: true });
      expect(await store.replaceFile('a.org', bytes('new'), originalHash)).toMatchObject({
        status: 'failed',
        failure: { kind: 'provider_error' },
      });
      expect(store.peekText('a.org')).toBe('new');
    });

    test('requestDownload reports only the failing path', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old', 'b.org': 'old' });
      store.failOperation('requestDownload', { path: 'a.org' });
      const result = await store.requestDownload(['a.org', 'b.org']);
      expect(result.failures.map((entry) => entry.path)).toEqual(['a.org']);
      expect(result.failures[0].failure.kind).toBe('provider_error');
    });
  });

  test('a fault can target one path, use any kind, and run out', async () => {
    const store = new MemoryFileStore({ 'a.org': 'a', 'b.org': 'b' });
    for (const kind of failureKinds) {
      store.failOperation('readBytes', { path: 'a.org', kind, times: 1 });
      expect(await store.readBytes('b.org')).toMatchObject({ ok: true });
      expect(await store.readBytes('a.org')).toMatchObject({ ok: false, failure: { kind } });
      expect(await store.readBytes('a.org')).toMatchObject({ ok: true });
    }
  });

  test('clearFaults ends failures, stale changes, and name alterations', async () => {
    const store = new MemoryFileStore({ 'a.org': 'old' });
    for (const op of FILE_STORE_OPERATIONS) store.failOperation(op);
    store.changeBeforeNextReplace('a.org', 'theirs');
    store.alterCreatedNames((name) => `${name}.txt`);
    store.clearFaults();

    expect((await store.list()).failures).toEqual([]);
    expect(await store.readBytes('a.org')).toMatchObject({ ok: true });
    expect(await store.digest('a.org')).toMatchObject({ ok: true });
    expect(await store.requestDownload(['a.org'])).toEqual({ failures: [] });
    expect(await store.createExclusive('b.org', bytes('x'))).toEqual({
      status: 'created',
      path: 'b.org',
    });
    expect(await store.replaceFile('a.org', bytes('new'), hash('old'))).toMatchObject({
      status: 'replaced',
    });
  });

  describe('failed listing', () => {
    const library = {
      'a.org': 'a',
      'daily/b.org': 'b',
      'daily/deep/c.org': 'c',
      'other/d.org': 'd',
    };

    test('of the root lists nothing and says so', async () => {
      const store = new MemoryFileStore(library);
      store.failOperation('list', { kind: 'access_denied' });
      const result = await store.list();
      expect(result.entries).toEqual([]);
      expect(result.failures).toEqual([
        { path: '', failure: { kind: 'access_denied', message: expect.any(String) } },
      ]);
    });

    test('of a subfolder keeps the folder and everything else, and hides only its contents', async () => {
      const store = new MemoryFileStore(library);
      store.failOperation('list', { path: 'daily' });
      const result = await store.list();
      expect(listedPaths(result)).toEqual(['a.org', 'daily', 'other', 'other/d.org']);
      expect(result.failures.map((entry) => entry.path)).toEqual(['daily']);
    });

    test('of a nested subfolder reports that folder', async () => {
      const store = new MemoryFileStore(library);
      store.failOperation('list', { path: 'daily/deep' });
      const result = await store.list();
      expect(listedPaths(result)).toContain('daily/b.org');
      expect(listedPaths(result)).not.toContain('daily/deep/c.org');
      expect(result.failures.map((entry) => entry.path)).toEqual(['daily/deep']);
    });

    test('recovers once the fault runs out', async () => {
      const store = new MemoryFileStore(library);
      store.failOperation('list', { path: 'daily', times: 1 });
      expect((await store.list()).failures).toHaveLength(1);
      const second = await store.list();
      expect(second.failures).toEqual([]);
      expect(listedPaths(second)).toContain('daily/deep/c.org');
    });
  });

  describe('stale hash', () => {
    test('a change just before the write makes replaceFile stale', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      const digest = await store.digest('a.org');
      if (!digest.ok) throw new Error('digest failed');
      store.changeBeforeNextReplace('a.org', 'theirs');

      expect(await store.replaceFile('a.org', bytes('mine'), digest.hash)).toEqual({
        status: 'stale',
        currentHash: hash('theirs'),
      });
      expect(store.peekText('a.org')).toBe('theirs');
    });

    test('applies once', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.changeBeforeNextReplace('a.org', 'theirs');
      await store.replaceFile('a.org', bytes('mine'), hash('old'));
      expect(await store.replaceFile('a.org', bytes('mine'), hash('theirs'))).toMatchObject({
        status: 'replaced',
      });
    });

    test('an outside write between digest and replace is stale too', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.writeFile('a.org', 'theirs');
      expect(await store.replaceFile('a.org', bytes('mine'), hash('old'))).toMatchObject({
        status: 'stale',
      });
    });
  });

  describe('provider altering a created name', () => {
    test('reports name_changed and leaves nothing by default', async () => {
      const store = new MemoryFileStore();
      store.alterCreatedNames((name) => `${name}.txt`);
      expect(await store.createExclusive('a.org', bytes('x'))).toMatchObject({
        status: 'failed',
        failure: { kind: 'name_changed' },
      });
      expect(store.paths()).toEqual([]);
    });

    test('can leave the altered file behind, in a subfolder too', async () => {
      const store = new MemoryFileStore({ 'daily/old.org': 'x' });
      store.alterCreatedNames((name) => `${name}.txt`, { leaveBehind: true });
      expect(await store.createExclusive('daily/a.org', bytes('x'))).toMatchObject({
        status: 'failed',
        failure: { kind: 'name_changed' },
      });
      expect(store.paths()).toEqual(['daily/a.org.txt', 'daily/old.org']);
    });

    test('does not overwrite a file already at the altered name', async () => {
      const store = new MemoryFileStore({ 'a.org.txt': 'keep' });
      store.alterCreatedNames((name) => `${name}.txt`, { leaveBehind: true });
      await store.createExclusive('a.org', bytes('x'));
      expect(store.peekText('a.org.txt')).toBe('keep');
    });

    test('still reports exists first', async () => {
      const store = new MemoryFileStore({ 'a.org': 'keep' });
      store.alterCreatedNames((name) => `${name}.txt`);
      expect(await store.createExclusive('a.org', bytes('x'))).toEqual({ status: 'exists' });
    });
  });

  describe('not-downloaded files', () => {
    function evicted(): MemoryFileStore {
      const store = new MemoryFileStore();
      store.writeFile('a.org', 'cloud', { downloaded: false });
      return store;
    }

    test('are listed with their size and flagged', async () => {
      const [entry] = (await evicted().list()).entries;
      expect(entry).toMatchObject({ path: 'a.org', size: 5, downloaded: false });
    });

    test('cannot be read, hashed, or replaced', async () => {
      const store = evicted();
      const failed = { failure: { kind: 'not_downloaded' } };
      expect(await store.readBytes('a.org')).toMatchObject({ ok: false, ...failed });
      expect(await store.digest('a.org')).toMatchObject({ ok: false, ...failed });
      expect(await store.replaceFile('a.org', bytes('x'), hash('cloud'))).toMatchObject({
        status: 'failed',
        ...failed,
      });
      expect(store.peekText('a.org')).toBe('cloud');
    });

    test('arrive only when the test says so', async () => {
      const store = evicted();
      expect(await store.requestDownload(['a.org'])).toEqual({ failures: [] });
      expect(await store.readBytes('a.org')).toMatchObject({ ok: false });

      store.setDownloaded('a.org', true);
      expect(await store.readBytes('a.org')).toEqual({ ok: true, bytes: bytes('cloud') });
    });

    test('keep their bytes and mtime when evicted', async () => {
      const store = new MemoryFileStore({ 'a.org': 'local' });
      const before = (await store.list()).entries[0].mtime;
      store.setDownloaded('a.org', false);
      expect((await store.list()).entries[0]).toMatchObject({ mtime: before, downloaded: false });
      store.setDownloaded('a.org', true);
      expect(await store.digest('a.org')).toEqual({ ok: true, hash: hash('local') });
    });

    test('requesting an unknown path fails for that path', async () => {
      const result = await evicted().requestDownload(['missing.org']);
      expect(result.failures[0]).toMatchObject({
        path: 'missing.org',
        failure: { kind: 'not_found' },
      });
    });
  });

  describe('read-only', () => {
    test('root flags every entry, refuses writes, and still reads', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old', 'daily/b.org': 'b' });
      store.setReadOnly();

      const { entries } = await store.list();
      expect(entries.map((entry) => entry.writable)).toEqual([false, false, false]);
      expect(await store.readBytes('a.org')).toMatchObject({ ok: true });
      expect(await store.createExclusive('new.org', bytes('x'))).toMatchObject({
        status: 'failed',
        failure: { kind: 'access_denied' },
      });
      expect(await store.replaceFile('a.org', bytes('x'), hash('old'))).toMatchObject({
        status: 'failed',
        failure: { kind: 'access_denied' },
      });
      expect(store.paths()).toEqual(['a.org', 'daily/b.org']);
      expect(store.peekText('a.org')).toBe('old');
    });

    test('can be lifted', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old' });
      store.setReadOnly();
      store.setReadOnly('', false);
      expect(await store.replaceFile('a.org', bytes('x'), hash('old'))).toMatchObject({
        status: 'replaced',
      });
    });

    test('can apply to one folder or file', async () => {
      const store = new MemoryFileStore({ 'a.org': 'old', 'locked/b.org': 'b', 'c.org': 'c' });
      store.setReadOnly('locked');
      store.setReadOnly('c.org');

      const writable = (await store.list()).entries.filter((entry) => entry.writable);
      expect(writable.map((entry) => entry.path)).toEqual(['a.org']);
      expect(await store.createExclusive('locked/new.org', bytes('x'))).toMatchObject({
        failure: { kind: 'access_denied' },
      });
      expect(await store.replaceFile('c.org', bytes('x'), hash('c'))).toMatchObject({
        failure: { kind: 'access_denied' },
      });
      expect(await store.createExclusive('new.org', bytes('x'))).toMatchObject({
        status: 'created',
      });
    });
  });
});

describe('MemoryFileStore test hooks', () => {
  test('setMtime changes only the mtime', async () => {
    const store = new MemoryFileStore({ 'a.org': 'same' });
    store.setMtime('a.org', 12345);
    const [entry] = (await store.list()).entries;
    expect(entry).toMatchObject({ mtime: 12345, size: 4 });
    expect(await store.digest('a.org')).toEqual({ ok: true, hash: hash('same') });
  });

  test('each write gets a later mtime, unless one is given', async () => {
    const store = new MemoryFileStore({ 'a.org': 'one' });
    const first = (await store.list()).entries[0].mtime;
    store.writeFile('a.org', 'two');
    const second = (await store.list()).entries[0].mtime;
    expect(second).toBeGreaterThan(first);
    store.writeFile('a.org', 'three', { mtime: 7 });
    expect((await store.list()).entries[0].mtime).toBe(7);
  });

  test('replaceFile moves the mtime forward', async () => {
    const store = new MemoryFileStore({ 'a.org': 'one' });
    const first = (await store.list()).entries[0].mtime;
    await store.replaceFile('a.org', bytes('two'), hash('one'));
    expect((await store.list()).entries[0].mtime).toBeGreaterThan(first);
  });

  test('rename keeps bytes and mtime', async () => {
    const store = new MemoryFileStore({ 'a.org': 'x' });
    store.setMtime('a.org', 99);
    store.rename('a.org', 'sub/b.org');
    expect(listedPaths(await store.list())).toEqual(['sub', 'sub/b.org']);
    expect((await store.list()).entries[1].mtime).toBe(99);
    expect(store.peekText('sub/b.org')).toBe('x');
  });

  test('remove takes a file or a whole folder', () => {
    const store = new MemoryFileStore({ 'a.org': 'x', 'sub/b.org': 'x', 'sub/c/d.org': 'x', 'subway.org': 'x' });
    store.remove('a.org');
    store.remove('sub');
    expect(store.paths()).toEqual(['subway.org']);
  });

  test('mkdir adds an empty folder that lists and can be created in', async () => {
    const store = new MemoryFileStore();
    store.mkdir('empty/inner');
    expect(listedPaths(await store.list())).toEqual(['empty', 'empty/inner']);
    expect(await store.createExclusive('empty/inner/a.org', bytes('x'))).toMatchObject({
      status: 'created',
    });
  });

  test('calls logs store use but not hooks', async () => {
    const store = new MemoryFileStore({ 'a.org': 'x', 'b.org': 'x' });
    store.setMtime('a.org', 1);
    await store.list();
    await store.digest('a.org');
    await store.requestDownload(['a.org', 'b.org']);
    expect(store.calls).toEqual([
      { op: 'list' },
      { op: 'digest', path: 'a.org' },
      { op: 'requestDownload', path: 'a.org' },
      { op: 'requestDownload', path: 'b.org' },
    ]);
  });

  test('paths are exact: case and normalization differences are separate files', async () => {
    const nfc = 'café.org';
    const nfd = 'café.org';
    const store = new MemoryFileStore({ 'Note.org': 'a', 'note.org': 'b', [nfc]: 'c', [nfd]: 'd' });
    expect((await store.list()).entries).toHaveLength(4);
    expect(store.peekText(nfd)).toBe('d');
  });

  test('hidden files stay readable by exact path, though unlisted', async () => {
    const store = new MemoryFileStore({ '.roamlet-1.tmp': 'x' });
    expect((await store.list()).entries).toEqual([]);
    expect(store.paths()).toEqual(['.roamlet-1.tmp']);
    expect(await store.readBytes('.roamlet-1.tmp')).toMatchObject({ ok: true });
  });

  test.each(['', '/a.org', 'a/', 'a//b.org', '../a.org', 'a/./b.org'])(
    'malformed path %j rejects as a caller bug',
    async (path) => {
      const store = new MemoryFileStore();
      await expect(store.readBytes(path)).rejects.toThrow('Malformed library path');
    },
  );

  test('hooks throw on misuse', () => {
    const store = new MemoryFileStore({ 'a.org': 'x', 'sub/b.org': 'x' });
    expect(() => store.setMtime('missing.org', 1)).toThrow();
    expect(() => store.setDownloaded('missing.org', false)).toThrow();
    expect(() => store.remove('missing.org')).toThrow();
    expect(() => store.rename('a.org', 'sub/b.org')).toThrow();
    expect(() => store.writeFile('sub', 'x')).toThrow();
    expect(() => store.writeFile('a.org/c.org', 'x')).toThrow();
    expect(() => store.changeBeforeNextReplace('missing.org', 'x')).toThrow();
  });
});
