import * as fc from 'fast-check';

import { LibraryIndex, type IndexFileSource } from '../../src/core/index';
import { indexDatabaseName } from '../../src/core/index/schema';
import { MemoryFileStore } from '../support/memory-file-store';
import { useIndexHost, type IndexHostEnv } from './index-helpers';

const ids = Array.from({ length: 4 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

/** Everything in the index, with rowids replaced by what they refer to. */
async function snapshot(env: IndexHostEnv, libraryId: string): Promise<unknown> {
  const db = await env.host.open(indexDatabaseName(libraryId));
  const result = {
    files: await db.all(
      'SELECT path, parent, name, size, mtime, hash, eol, status, title FROM files ORDER BY path',
    ),
    nodes: await db.all(
      `SELECT n.id, n.file_path, n.level, n.title, n.start_offset,
         (SELECT group_concat(tag) FROM node_tags WHERE node_rowid = n.rowid) AS tags
       FROM nodes n ORDER BY n.file_path, n.start_offset`,
    ),
    links: await db.all(
      `SELECT l.file_path, s.id AS source, s.start_offset AS source_offset, l.target_id,
         l.description, l.start_offset
       FROM links l LEFT JOIN nodes s ON s.rowid = l.source_rowid
       ORDER BY l.file_path, l.start_offset`,
    ),
    search: await db.all(
      `SELECT u.file_path, n.id AS node, n.start_offset AS node_offset, s.title, s.body
       FROM search s JOIN search_units u ON u.rowid = s.rowid
       LEFT JOIN nodes n ON n.rowid = u.node_rowid
       ORDER BY u.file_path, n.start_offset`,
    ),
    conflictCopies: await db.all('SELECT path, size, mtime FROM conflict_copies ORDER BY path'),
    orphanTags: await db.all('SELECT tag FROM node_tags WHERE node_rowid NOT IN (SELECT rowid FROM nodes)'),
    orphanSearch: await db.all('SELECT rowid FROM search WHERE rowid NOT IN (SELECT rowid FROM search_units)'),
  };
  await db.close();
  return result;
}

const pathArb = fc.constantFrom(
  'a.org',
  'b.org',
  'c.org',
  'sub/a.org',
  'sub/deep/b.org',
  'other/c.org',
  'a.org.conflict-20260115093000',
  'sub/a.org.conflict-20260115093000',
  'image.png',
);

const contentArb: fc.Arbitrary<string | Uint8Array> = fc.oneof(
  fc
    .record({
      id: fc.constantFrom(...ids),
      title: fc.constantFrom('Alpha', 'Beta', 'Café', '日本語のノート'),
      target: fc.constantFrom(...ids),
    })
    .map(({ id, title, target }) => note(id, title, `body [[id:${target}][label]] words`)),
  fc
    .record({ id: fc.constantFrom(...ids), heading: fc.constantFrom(...ids), target: fc.constantFrom(...ids) })
    .map(
      ({ id, heading, target }) =>
        `${note(id, 'Two nodes')}* Heading :tag:\n:PROPERTIES:\n:ID: ${heading}\n:END:\nTo [[id:${target}]]\n`,
    ),
  fc.constantFrom(
    'no nodes here, only words\n',
    '#+title: Heading nodes only\nloose text\n',
    `* Heading\r\n:PROPERTIES:\r\n:ID: ${ids[0]}\r\n:END:\r\nCRLF body\r\n`,
    `﻿#+title: With BOM\nText with [[id:${ids[1]}]] in no node\n`,
    '',
    new Uint8Array([0x23, 0xff, 0xfe]),
  ),
);

type Op =
  | { kind: 'write'; path: string; content: string | Uint8Array }
  | { kind: 'remove'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'touch'; path: string }
  | { kind: 'evict'; path: string }
  | { kind: 'restore'; path: string }
  | { kind: 'reconcile' }
  | { kind: 'failed-listing' }
  | { kind: 'failed-folder' }
  | { kind: 'failed-read'; path: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('write' as const), path: pathArb, content: contentArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('remove' as const), path: pathArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('rename' as const), from: pathArb, to: pathArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('touch' as const), path: pathArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('evict' as const), path: pathArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('restore' as const), path: pathArb }) },
  { weight: 3, arbitrary: fc.constant({ kind: 'reconcile' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'failed-listing' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'failed-folder' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('failed-read' as const), path: pathArb }) },
);

async function apply(op: Op, store: MemoryFileStore, index: LibraryIndex, tick: () => number): Promise<void> {
  const exists = (path: string) => store.peek(path) !== undefined;
  switch (op.kind) {
    case 'write':
      store.writeFile(op.path, op.content, { mtime: tick() });
      break;
    case 'remove':
      if (exists(op.path)) store.remove(op.path);
      break;
    case 'rename':
      if (exists(op.from) && !exists(op.to)) store.rename(op.from, op.to);
      break;
    case 'touch':
      if (exists(op.path)) store.setMtime(op.path, tick());
      break;
    case 'evict':
      if (exists(op.path)) store.setDownloaded(op.path, false);
      break;
    case 'restore':
      if (exists(op.path)) store.setDownloaded(op.path, true);
      break;
    case 'reconcile':
      await index.reconcile(store);
      break;
    case 'failed-listing':
      store.failOperation('list', { times: 1 });
      await index.reconcile(store);
      store.clearFaults();
      break;
    case 'failed-folder':
      store.failOperation('list', { path: 'sub', times: 1 });
      await index.reconcile(store);
      store.clearFaults();
      break;
    case 'failed-read':
      store.failOperation('readBytes', { path: op.path, times: 1 });
      await index.reconcile(store);
      store.clearFaults();
      break;
  }
}

describe('rebuild', () => {
  const env = useIndexHost();

  it('Scenario: Rebuild equivalence — after random operations, incremental equals rebuilt', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 25 }), async (ops) => {
        const id = `run-${run++}`;
        const store = new MemoryFileStore();
        let clock = Date.UTC(2026, 5, 1);
        const incremental = await LibraryIndex.open(env.host, `${id}-incremental`);
        for (const op of ops) await apply(op, store, incremental, () => (clock += 1000));

        // A file that isn't on the device keeps rows incrementally and has none in a rebuild. That
        // difference is by design (Decision 5), so compare once everything is here.
        for (const path of store.paths()) store.setDownloaded(path, true);
        await incremental.reconcile(store);
        await incremental.close();

        const rebuilt = await LibraryIndex.open(env.host, `${id}-rebuilt`);
        await rebuilt.rebuild(store);
        await rebuilt.close();

        expect(await snapshot(env, `${id}-incremental`)).toEqual(await snapshot(env, `${id}-rebuilt`));
      }),
      { numRuns: 40 },
    );
  }, 120000);

  it.each([
    ['a node title', `UPDATE nodes SET title = 'x'`],
    ['a node tag', `UPDATE node_tags SET tag = 'x'`],
    ['a link target', `UPDATE links SET target_id = 'x'`],
    ['search text', `UPDATE search SET body = 'x'`],
    ['a file hash', `UPDATE files SET hash = 'x'`],
    ['a conflict copy', `DELETE FROM conflict_copies`],
    ['leftover tags', `INSERT INTO node_tags (node_rowid, tag) VALUES (999, 'x')`],
    ['leftover search rows', `INSERT INTO search (rowid, title, body) VALUES (999, 'x', 'x')`],
  ])('the comparison would notice a difference in %s', async (_name, tamper) => {
    const store = new MemoryFileStore({
      'a.org': `:PROPERTIES:\n:ID: ${ids[0]}\n:END:\n#+filetags: :t:\n#+title: A\n[[id:${ids[1]}]] words\n`,
      'a.org.conflict-20260115093000': 'text',
    });
    const index = await LibraryIndex.open(env.host, 'seen');
    await index.reconcile(store);
    await index.close();
    const clean = await snapshot(env, 'seen');
    const db = await env.host.open(indexDatabaseName('seen'));
    await db.exec(tamper);
    await db.close();

    expect(await snapshot(env, 'seen')).not.toEqual(clean);
  });

  describe('Scenario: Interrupted rebuild', () => {
    /** A store where the app dies at the Nth read: the call never returns a result. */
    function dyingAt(store: MemoryFileStore, read: number): IndexFileSource {
      let reads = 0;
      return {
        list: () => store.list(),
        digest: (path) => store.digest(path),
        requestDownload: (paths) => store.requestDownload(paths),
        readBytes: (path) => {
          reads += 1;
          if (reads === read) throw new Error('terminated');
          return store.readBytes(path);
        },
      };
    }

    function library(): MemoryFileStore {
      const files: Record<string, string> = {};
      for (let i = 0; i < 8; i += 1) {
        files[`n${i}.org`] = note(`00000000-0000-4000-8000-0000000000a${i}`, `Note ${i}`, `word${i}`);
      }
      return new MemoryFileStore(files);
    }

    it('resumes on next launch, without redoing finished files, and completes correctly', async () => {
      const store = library();
      const index = await LibraryIndex.open(env.host, 'lib');
      await index.reconcile(store);
      const complete = await snapshot(env, 'lib');

      await expect(index.rebuild(dyingAt(store, 4))).rejects.toThrow('terminated');
      await index.close();

      // Next launch: whatever finished is there, and queries work on it.
      const reopened = await LibraryIndex.open(env.host, 'lib');
      expect((await reopened.counts()).files).toBe(3);
      expect((await reopened.search('word1')).length).toBe(1);

      store.calls = [];
      const result = await reopened.reconcile(store);

      expect(result.added).toEqual(['n3.org', 'n4.org', 'n5.org', 'n6.org', 'n7.org']);
      expect(store.calls.filter((call) => call.op === 'readBytes')).toHaveLength(5);
      await reopened.close();
      expect(await snapshot(env, 'lib')).toEqual(complete);
    });

    it('survives being interrupted again and again', async () => {
      const store = library();
      const index = await LibraryIndex.open(env.host, 'clean');
      await index.reconcile(store);
      await index.close();
      const complete = await snapshot(env, 'clean');

      let current = await LibraryIndex.open(env.host, 'lib');
      await expect(current.rebuild(dyingAt(store, 2))).rejects.toThrow('terminated');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await current.close();
        current = await LibraryIndex.open(env.host, 'lib');
        await expect(current.reconcile(dyingAt(store, 2))).rejects.toThrow('terminated');
      }
      await current.close();
      current = await LibraryIndex.open(env.host, 'lib');
      await current.reconcile(store);
      await current.close();

      expect(await snapshot(env, 'lib')).toEqual(complete);
    });

    it('a rejected run does not stop the next one in the same session', async () => {
      const store = library();
      const index = await LibraryIndex.open(env.host, 'lib');

      await expect(index.rebuild(dyingAt(store, 1))).rejects.toThrow('terminated');
      await index.reconcile(store);

      expect((await index.counts()).files).toBe(8);
      await index.close();
    });

    it('a file interrupted inside its own transaction leaves no partial rows', async () => {
      const store = library();
      const host = {
        open: async (name: string) => {
          const db = await env.host.open(name);
          let transactions = 0;
          const transaction: typeof db.transaction = (work) =>
            db.transaction(async (tx) => {
              const result = await work(tx);
              // The schema is the first transaction, and files follow.
              transactions += 1;
              if (transactions === 3) throw new Error('terminated');
              return result;
            });
          return {
            exec: db.exec.bind(db),
            run: db.run.bind(db),
            all: db.all.bind(db),
            get: db.get.bind(db),
            close: db.close.bind(db),
            transaction,
          };
        },
        delete: (name: string) => env.host.delete(name),
      };
      const index = await LibraryIndex.open(host, 'lib');

      await expect(index.reconcile(store)).rejects.toThrow('terminated');
      await index.close();

      expect(await snapshot(env, 'lib')).toMatchObject({
        files: [expect.objectContaining({ path: 'n0.org' })],
        nodes: [expect.objectContaining({ file_path: 'n0.org' })],
        search: [expect.objectContaining({ file_path: 'n0.org' })],
      });
    });

    it('shows partial results while a rebuild runs', async () => {
      const store = library();
      const index = await LibraryIndex.open(env.host, 'lib');
      await index.reconcile(store);
      const seen: number[] = [];
      const checks: Promise<void>[] = [];

      await index.rebuild(store, {
        onProgress: () => {
          checks.push(index.counts().then((counts) => void seen.push(counts.files)));
        },
      });
      await Promise.all(checks);

      expect(seen[0]).toBeLessThan(8);
      expect(await index.counts()).toMatchObject({ files: 8 });
      await index.close();
    });
  });
});
