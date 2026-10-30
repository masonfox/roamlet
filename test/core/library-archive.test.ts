import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { unzipSync } from 'fflate';

import { buildArchive, type ArchiveResult } from '../../src/core/library';
import type { ListResult } from '../../src/core/ports';
import { MemoryFileStore } from '../support/memory-file-store';

// Scenarios from specs/library-storage/spec.md, "Export".
const UTF8_NAME_FLAG = 0x0800;
const utf8 = (text: string) => new TextEncoder().encode(text);

type Built = Extract<ArchiveResult, { status: 'ok' }>;

async function build(store: MemoryFileStore): Promise<Built> {
  const result = await buildArchive(store);
  if (result.status !== 'ok') throw new Error(`export failed: ${result.problem.detail}`);
  return result;
}

function extract(result: Built): Record<string, Uint8Array> {
  return unzipSync(result.archive);
}

function sortedNames(result: Built): string[] {
  return Object.keys(extract(result)).sort();
}

/** Reads the central directory directly, so this doesn't rest on fflate reading its own output. */
function centralDirectory(archive: Uint8Array): { name: string; flags: number }[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const records: { name: string; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    records.push({ name, flags });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

describe('Export', () => {
  describe('Retrieving notes from the app-owned folder', () => {
    it('keeps subdirectories and contents exactly', async () => {
      const store = new MemoryFileStore({
        'a.org': 'A\n',
        'daily/2026-01-02.org': 'B\n',
        'daily/deep/er/c.org': 'C\n',
      });

      const result = await build(store);

      expect(sortedNames(result)).toEqual(['a.org', 'daily/2026-01-02.org', 'daily/deep/er/c.org']);
      expect(result.included.sort()).toEqual(sortedNames(result));
      expect(result.omitted).toEqual([]);
      expect(extract(result)['daily/deep/er/c.org']).toEqual(utf8('C\n'));
    });

    it('keeps every fixture byte for byte, including BOMs, CRLF, and invalid UTF-8', async () => {
      const dir = join(__dirname, '../fixtures');
      const store = new MemoryFileStore();
      const originals: Record<string, Uint8Array> = {};
      for (const name of readdirSync(dir).filter((file) => file.endsWith('.org'))) {
        originals[name] = new Uint8Array(readFileSync(join(dir, name)));
        store.writeFile(name, originals[name]);
      }
      originals['latin1.org'] = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
      store.writeFile('latin1.org', originals['latin1.org']);

      expect(extract(await build(store))).toEqual(originals);
    });

    it('keeps arbitrary bytes and a large file', async () => {
      const random = new Uint8Array(300_000);
      for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) >>> 24;
      const store = new MemoryFileStore({ 'big.org': random, 'empty.org': '' });

      const files = extract(await build(store));

      expect(files['big.org']).toEqual(random);
      expect(files['empty.org']).toEqual(new Uint8Array());
    });

    it('does not change the library', async () => {
      const store = new MemoryFileStore({ 'a.org': 'A\n' });

      await build(store);

      expect(store.calls.map((call) => call.op)).toEqual(['list', 'readBytes']);
    });
  });

  describe('UTF-8 names', () => {
    const NAMES = ['日本語/メモ.org', 'café.org', 'café.org', '🎉 party.org', "note (Laptop's conflicted copy 2026-01-15).org"];

    it('keeps names exactly, without normalizing them', async () => {
      const store = new MemoryFileStore(Object.fromEntries(NAMES.map((name) => [name, name])));

      const result = await build(store);

      expect(sortedNames(result)).toEqual([...NAMES].sort());
      const files = extract(result);
      for (const name of NAMES) expect(files[name]).toEqual(utf8(name));
    });

    it('marks non-ASCII names as UTF-8 in the zip', async () => {
      const store = new MemoryFileStore({ 'café.org': 'x', 'plain.org': 'y' });

      const records = centralDirectory((await build(store)).archive);
      const cafe = records.find((record) => record.name === 'café.org');

      expect(cafe && cafe.flags & UTF8_NAME_FLAG).toBe(UTF8_NAME_FLAG);
      expect(records.map((record) => record.name).sort()).toEqual(['café.org', 'plain.org']);
    });
  });

  describe('Conflict copies', () => {
    it('includes conflict copies from Roamlet and from sync tools', async () => {
      const store = new MemoryFileStore({
        'note.org': 'n\n',
        'note.org.conflict-20260115093000': 'mine\n',
        'daily/d.org.conflict-20260115093000-2': 'mine too\n',
        'note.sync-conflict-20260115-093000-ABCDEFG.org': 'syncthing\n',
        "note (Laptop's conflicted copy 2026-01-15).org": 'dropbox\n',
      });

      const files = extract(await build(store));

      expect(Object.keys(files).sort()).toEqual(
        [
          'note.org',
          'note.org.conflict-20260115093000',
          'daily/d.org.conflict-20260115093000-2',
          'note.sync-conflict-20260115-093000-ABCDEFG.org',
          "note (Laptop's conflicted copy 2026-01-15).org",
        ].sort(),
      );
      expect(files['note.org.conflict-20260115093000']).toEqual(utf8('mine\n'));
    });
  });

  describe('Export excludes internals', () => {
    it('leaves out everything that is not a note or a conflict copy', async () => {
      const store = new MemoryFileStore({
        'note.org': 'n\n',
        '.git/config': 'x',
        '.stfolder/x.org': 'x',
        '.roamlet-1.tmp': 'x',
        '.roamlet-1.old': 'x',
        '.#note.org': 'x',
        'note.org~': 'x',
        'secret.org.gpg': 'x',
        'image.png': 'x',
        'index-1.db': 'x',
        'drafts/draft.json': 'x',
        'txn/journal.json': 'x',
        'note.org.conflict-notadate': 'x',
      });

      const result = await build(store);

      expect(sortedNames(result)).toEqual(['note.org']);
      expect(result.omitted).toEqual([]);
    });

    it('leaves out hidden paths even if a store lists them', async () => {
      class ListsHidden extends MemoryFileStore {
        async list(): Promise<ListResult> {
          const entry = { size: 1, mtime: Date.UTC(2026, 0, 1), isDir: false, downloaded: true, writable: true };
          return {
            entries: [
              { ...entry, name: 'x.org', path: '.hidden/x.org' },
              { ...entry, name: '.y.org', path: '.y.org' },
              { ...entry, name: 'z.org.conflict-20260115093000', path: '.hidden/z.org.conflict-20260115093000' },
            ],
            failures: [],
          };
        }
      }

      expect(sortedNames(await build(new ListsHidden({ '.y.org': 'y' })))).toEqual([]);
    });

    it('does not archive a folder whose name looks like a note', async () => {
      const store = new MemoryFileStore({ 'folder.org/inner.org': 'x\n' });

      expect(sortedNames(await build(store))).toEqual(['folder.org/inner.org']);
    });
  });

  describe('Files not on the device', () => {
    it('completes with the available files, and lists the omitted ones', async () => {
      const store = new MemoryFileStore({ 'here.org': 'here\n' });
      store.writeFile('away.org', 'away\n', { downloaded: false });
      store.writeFile('daily/away.org.conflict-20260115093000', 'c\n', { downloaded: false });

      const result = await build(store);

      expect(sortedNames(result)).toEqual(['here.org']);
      expect(result.included).toEqual(['here.org']);
      expect(result.omitted.map((omitted) => [omitted.path, omitted.failure.kind])).toEqual([
        ['away.org', 'not_downloaded'],
        ['daily/away.org.conflict-20260115093000', 'not_downloaded'],
      ]);
    });

    it('asks for no downloads and reads nothing that is not on the device', async () => {
      const store = new MemoryFileStore({ 'here.org': 'here\n' });
      store.writeFile('away.org', 'away\n', { downloaded: false });

      await build(store);

      expect(store.calls).toEqual([{ op: 'list' }, { op: 'readBytes', path: 'here.org' }]);
    });

    it('lists a file that became unreadable as omitted', async () => {
      const store = new MemoryFileStore({ 'a.org': 'a\n', 'b.org': 'b\n' });
      store.failOperation('readBytes', { path: 'a.org', kind: 'access_denied' });

      const result = await build(store);

      expect(sortedNames(result)).toEqual(['b.org']);
      expect(result.omitted.map((omitted) => [omitted.path, omitted.failure.kind])).toEqual([
        ['a.org', 'access_denied'],
      ]);
    });

    it('gives a valid empty archive when nothing is on the device', async () => {
      const store = new MemoryFileStore();
      store.writeFile('away.org', 'away\n', { downloaded: false });

      const result = await build(store);

      expect(extract(result)).toEqual({});
      expect(result.omitted).toHaveLength(1);
    });
  });

  describe('Listing failures', () => {
    it('reports a subfolder it could not list, and archives the rest', async () => {
      const store = new MemoryFileStore({ 'a.org': 'a\n', 'daily/b.org': 'b\n' });
      store.failOperation('list', { path: 'daily' });

      const result = await build(store);

      expect(sortedNames(result)).toEqual(['a.org']);
      expect(result.unlistedFolders.map((failed) => failed.path)).toEqual(['daily']);
    });

    it('fails when nothing could be listed, rather than giving an empty archive', async () => {
      const store = new MemoryFileStore({ 'a.org': 'a\n' });
      store.failOperation('list', { kind: 'access_denied' });

      const result = await buildArchive(store);

      expect(result).toMatchObject({
        status: 'failed',
        problem: { kind: 'access_denied', accessMayBeLost: true },
      });
    });
  });

  describe('Timestamps', () => {
    it.each([
      ['the epoch', 0],
      ['before 1980', Date.UTC(1975, 0, 1)],
      ['after 2099', Date.UTC(2150, 0, 1)],
      ['not a number', Number.NaN],
    ])('keeps a file whose modification time is %s, which zip cannot hold', async (_name, mtime) => {
      const store = new MemoryFileStore();
      store.writeFile('a.org', 'a\n', { mtime });

      expect(extract(await build(store))['a.org']).toEqual(utf8('a\n'));
    });

    it('records the file time in range', async () => {
      const store = new MemoryFileStore();
      store.writeFile('a.org', 'a\n', { mtime: new Date(2026, 0, 15, 9, 30, 0).getTime() });
      const { archive } = await build(store);

      // Local file header: DOS time at offset 10 and date at 12.
      const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
      const date = view.getUint16(12, true);
      expect(date >> 9).toBe(2026 - 1980);
      expect((date >> 5) & 0xf).toBe(1);
      expect(date & 0x1f).toBe(15);
    });
  });
});
