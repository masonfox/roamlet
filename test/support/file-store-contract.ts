import type { FileEntry, FileStore, FileStoreFailureKind } from '../../src/core/ports';

// Behavior every FileStore must share, for the in-memory store in Node and the native adapter on a
// device (task 5.4). This file stays free of Jest and Node so a device test screen can run it.

export interface OpenedFileStore {
  store: FileStore;
  dispose?: () => Promise<void>;
}

export interface FileStoreContractHarness {
  /**
   * Opens a store over a new, empty, writable library holding exactly `files`, all on the device.
   * Each case gets its own library. Parent folders are created as needed.
   */
  open(files: Record<string, Uint8Array>): Promise<OpenedFileStore>;
}

export interface FileStoreContractCase {
  name: string;
  files: Record<string, Uint8Array>;
  run(store: FileStore): Promise<void>;
}

export interface FileStoreContractResult {
  name: string;
  /** Undefined when the case passed. */
  error?: unknown;
}

const encode = (text: string) => new TextEncoder().encode(text);

// NIST SHA-256 test vectors, so a store cannot pass by agreeing with itself.
const ABC = encode('abc');
const ABC_HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const LONG = encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
const LONG_HASH = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const OTHER_HASH = 'f'.repeat(64);

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

async function assertBytes(store: FileStore, path: string, expected: Uint8Array): Promise<void> {
  const result = await store.readBytes(path);
  assertEqual(result.ok && [...result.bytes], [...expected], `bytes of ${path}`);
}

async function assertFailure(
  result: Promise<{ failure: { kind: FileStoreFailureKind } } | object>,
  kind: FileStoreFailureKind,
  label: string,
): Promise<void> {
  const settled = await result;
  assertEqual('failure' in settled && settled.failure.kind, kind, label);
}

async function listed(store: FileStore): Promise<FileEntry[]> {
  const { entries, failures } = await store.list();
  assertEqual(failures, [], 'listing failures');
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function listedPaths(store: FileStore): Promise<string[]> {
  return (await listed(store)).map((entry) => entry.path);
}

async function entryAt(store: FileStore, path: string): Promise<FileEntry> {
  const entry = (await listed(store)).find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`${path} is not listed`);
  return entry;
}

export const fileStoreContractCases: FileStoreContractCase[] = [
  {
    name: 'list returns visible files of any type and skips everything hidden',
    files: {
      'note.org': ABC,
      'image.png': ABC,
      'secret.org.gpg': ABC,
      'note.org~': ABC,
      'daily/2026-01-02.org': ABC,
      'daily/deep/er.org': ABC,
      '.#note.org': ABC,
      '.roamlet-1.tmp': ABC,
      'daily/.hidden.org': ABC,
      '.git/config': ABC,
      '.git/nested/visible.org': ABC,
      '.stfolder/marker.org': ABC,
    },
    async run(store) {
      assertEqual(
        await listedPaths(store),
        [
          'daily',
          'daily/2026-01-02.org',
          'daily/deep',
          'daily/deep/er.org',
          'image.png',
          'note.org',
          'note.org~',
          'secret.org.gpg',
        ],
        'listed paths',
      );
    },
  },
  {
    name: 'list describes files and folders',
    files: { 'daily/note.org': ABC },
    async run(store) {
      const file = await entryAt(store, 'daily/note.org');
      assertEqual(
        [file.name, file.size, file.isDir, file.downloaded, file.writable],
        ['note.org', ABC.length, false, true, true],
        'file entry',
      );
      assertEqual(Number.isFinite(file.mtime) && file.mtime > 0, true, 'file mtime');

      const folder = await entryAt(store, 'daily');
      assertEqual(
        [folder.name, folder.size, folder.isDir],
        ['daily', 0, true],
        'folder entry',
      );
    },
  },
  {
    name: 'list of an empty library is complete and empty',
    files: {},
    async run(store) {
      assertEqual(await store.list(), { entries: [], failures: [] }, 'listing');
    },
  },
  {
    name: 'readBytes returns exact bytes, including BOM, CRLF, NUL, and invalid UTF-8',
    files: {
      'bom.org': new Uint8Array([0xef, 0xbb, 0xbf, 0x61]),
      'crlf.org': encode('a\r\nb\n'),
      'nul.org': new Uint8Array([0x61, 0x00, 0x62]),
      'invalid.org': new Uint8Array([0xc3, 0x28, 0xff]),
      'empty.org': new Uint8Array(),
    },
    async run(store) {
      await assertBytes(store, 'bom.org', new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
      await assertBytes(store, 'crlf.org', encode('a\r\nb\n'));
      await assertBytes(store, 'nul.org', new Uint8Array([0x61, 0x00, 0x62]));
      await assertBytes(store, 'invalid.org', new Uint8Array([0xc3, 0x28, 0xff]));
      await assertBytes(store, 'empty.org', new Uint8Array());
    },
  },
  {
    name: 'readBytes of a missing file reports not_found',
    files: {},
    async run(store) {
      await assertFailure(store.readBytes('missing.org'), 'not_found', 'read');
    },
  },
  {
    name: 'digest is lowercase hexadecimal SHA-256 of the bytes',
    files: { 'abc.org': ABC, 'empty.org': new Uint8Array() },
    async run(store) {
      assertEqual(await store.digest('abc.org'), { ok: true, hash: ABC_HASH }, 'abc');
      assertEqual(await store.digest('empty.org'), { ok: true, hash: EMPTY_HASH }, 'empty');
    },
  },
  {
    name: 'digest of a missing file reports not_found',
    files: {},
    async run(store) {
      await assertFailure(store.digest('missing.org'), 'not_found', 'digest');
    },
  },
  {
    name: 'reading and listing leave the library unchanged',
    files: { 'note.org': ABC, 'daily/a.org': LONG },
    async run(store) {
      const before = await listed(store);
      await store.readBytes('note.org');
      await store.digest('daily/a.org');
      await store.requestDownload(['note.org']);
      assertEqual(await listed(store), before, 'entries');
    },
  },
  {
    name: 'createExclusive writes a new file with the exact path and bytes',
    files: { 'daily/old.org': ABC },
    async run(store) {
      assertEqual(
        await store.createExclusive('new.org', LONG),
        { status: 'created', path: 'new.org' },
        'root create',
      );
      assertEqual(
        await store.createExclusive('daily/new.org', ABC),
        { status: 'created', path: 'daily/new.org' },
        'subfolder create',
      );
      await assertBytes(store, 'new.org', LONG);
      await assertBytes(store, 'daily/new.org', ABC);
      assertEqual((await entryAt(store, 'new.org')).size, LONG.length, 'listed size');
    },
  },
  {
    name: 'createExclusive keeps non-ASCII names and unusual suffixes exact',
    files: {},
    async run(store) {
      const names = ['日本語 ノート.org', 'café 🎉.org', 'note.sync-conflict-1.org', 'copy.conflict'];
      for (const name of names) {
        assertEqual(
          await store.createExclusive(name, ABC),
          { status: 'created', path: name },
          `create ${name}`,
        );
      }
      assertEqual((await listed(store)).map((entry) => entry.name).sort(), [...names].sort(), 'names');
    },
  },
  {
    name: 'createExclusive never replaces an existing file',
    files: { 'note.org': ABC },
    async run(store) {
      assertEqual(await store.createExclusive('note.org', LONG), { status: 'exists' }, 'create');
      await assertBytes(store, 'note.org', ABC);
    },
  },
  {
    name: 'createExclusive treats a folder with that name as existing',
    files: { 'daily/note.org': ABC },
    async run(store) {
      assertEqual(await store.createExclusive('daily', LONG), { status: 'exists' }, 'create');
      await assertBytes(store, 'daily/note.org', ABC);
    },
  },
  {
    name: 'createExclusive in a missing folder reports not_found and adds nothing',
    files: {},
    async run(store) {
      await assertFailure(store.createExclusive('gone/note.org', ABC), 'not_found', 'create');
      assertEqual(await listedPaths(store), [], 'listed paths');
    },
  },
  {
    name: 'replaceFile swaps in the bytes when the hash matches',
    files: { 'note.org': ABC, 'other.org': ABC },
    async run(store) {
      const before = await entryAt(store, 'note.org');
      assertEqual(
        await store.replaceFile('note.org', LONG, ABC_HASH),
        { status: 'replaced', hash: LONG_HASH },
        'replace',
      );
      await assertBytes(store, 'note.org', LONG);
      assertEqual(await store.digest('note.org'), { ok: true, hash: LONG_HASH }, 'digest');
      await assertBytes(store, 'other.org', ABC);

      const after = await entryAt(store, 'note.org');
      assertEqual(after.size, LONG.length, 'listed size');
      assertEqual(after.mtime >= before.mtime, true, 'mtime does not go backward');
      assertEqual(await listedPaths(store), ['note.org', 'other.org'], 'listed paths');
    },
  },
  {
    name: 'replaceFile leaves the file untouched and reports its hash when stale',
    files: { 'note.org': ABC },
    async run(store) {
      assertEqual(
        await store.replaceFile('note.org', LONG, OTHER_HASH),
        { status: 'stale', currentHash: ABC_HASH },
        'replace',
      );
      await assertBytes(store, 'note.org', ABC);
    },
  },
  {
    name: 'replaceFile of a missing file reports not_found and creates nothing',
    files: {},
    async run(store) {
      await assertFailure(store.replaceFile('missing.org', ABC, ABC_HASH), 'not_found', 'replace');
      assertEqual(await listedPaths(store), [], 'listed paths');
    },
  },
  {
    name: 'requestDownload succeeds for files already on the device, and for no files',
    files: { 'note.org': ABC },
    async run(store) {
      assertEqual(await store.requestDownload(['note.org']), { failures: [] }, 'one path');
      assertEqual(await store.requestDownload([]), { failures: [] }, 'no paths');
    },
  },
  {
    name: 'changing bytes after a call does not reach the stored file',
    files: { 'note.org': ABC },
    async run(store) {
      const read = await store.readBytes('note.org');
      if (read.ok) read.bytes.fill(0);
      await assertBytes(store, 'note.org', ABC);

      const created = LONG.slice();
      await store.createExclusive('new.org', created);
      created.fill(0);
      await assertBytes(store, 'new.org', LONG);

      const replacement = LONG.slice();
      await store.replaceFile('note.org', replacement, ABC_HASH);
      replacement.fill(0);
      await assertBytes(store, 'note.org', LONG);
    },
  },
];

/** Runs one case against its own library, always disposing of the library afterward. */
export async function runFileStoreContractCase(
  contractCase: FileStoreContractCase,
  harness: FileStoreContractHarness,
): Promise<void> {
  const { store, dispose } = await harness.open(contractCase.files);
  try {
    await contractCase.run(store);
  } finally {
    await dispose?.();
  }
}

/** Runs every case and reports each outcome, for a runner without a test framework. */
export async function runFileStoreContract(
  harness: FileStoreContractHarness,
): Promise<FileStoreContractResult[]> {
  const results: FileStoreContractResult[] = [];
  for (const contractCase of fileStoreContractCases) {
    try {
      await runFileStoreContractCase(contractCase, harness);
      results.push({ name: contractCase.name });
    } catch (error) {
      results.push({ name: contractCase.name, error });
    }
  }
  return results;
}
