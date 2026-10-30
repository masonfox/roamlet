import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generateLibrary,
  writeLibrary,
  type GenerateOptions,
} from '../../scripts/generate-library';
import { LibraryIndex } from '../../src/core/index';
import { scan } from '../../src/core/org';
import { useIndexHost } from '../core/index-helpers';
import { MemoryFileStore } from '../support/memory-file-store';

const SMALL: GenerateOptions = { seed: 7, notes: 120, totalBytes: 512 * 1024 };
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every file under `directory` as exact bytes, by `/`-separated relative path. */
function readTree(directory: string): Record<string, Uint8Array> {
  const tree: Record<string, Uint8Array> = {};
  const entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const path = full.slice(directory.length + 1).replaceAll('\\', '/');
    tree[path] = new Uint8Array(readFileSync(full));
  }
  return tree;
}

describe('generateLibrary', () => {
  const env = useIndexHost();
  let base: string;
  let index: LibraryIndex | null = null;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'roamlet-generated-'));
  });
  afterEach(async () => {
    await index?.close();
    index = null;
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const written = (name: string, options: GenerateOptions = SMALL) => {
    const directory = join(base, name);
    const library = generateLibrary(options);
    writeLibrary(library, directory);
    return { library, tree: readTree(directory) };
  };

  it('writes identical bytes for the same seed, and different ones for another', () => {
    const first = written('first');
    const second = written('second');
    const other = written('other', { ...SMALL, seed: 8 });

    expect(Object.keys(second.tree)).toEqual(Object.keys(first.tree));
    for (const [path, bytes] of Object.entries(first.tree)) {
      expect(Buffer.compare(second.tree[path], bytes)).toBe(0);
    }
    expect(second.library.summary.hash).toBe(first.library.summary.hash);
    expect(other.library.summary.hash).not.toBe(first.library.summary.hash);
  });

  // Pinned so that a change to the generator, or anything that varies by machine, gets noticed.
  it('produces this exact library for this seed', () => {
    const { summary } = generateLibrary(SMALL);
    expect({ ...summary, filesWithoutIds: summary.filesWithoutIds.length }).toEqual({
      notes: 120,
      bytes: 524433,
      nodes: 179,
      headingNodes: 62,
      links: 212,
      filesWithoutIds: 3,
      hash: 'bfbb3836668dc939a706adac690906d8016fd8ccd23725aacee3cb472ac854c6',
    });
  });

  it('scans to the counts it reports, with lowercase UUIDs and only resolved links', () => {
    const { library, tree } = written('scanned');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const docs = Object.entries(tree).map(([path, bytes]) =>
      scan(decoder.decode(bytes), { fileName: path }),
    );

    const ids = docs.flatMap((doc) => doc.nodes.map((node) => node.id));
    const links = docs.flatMap((doc) => doc.links);
    expect(docs).toHaveLength(library.summary.notes);
    expect(ids).toHaveLength(library.summary.nodes);
    expect(links).toHaveLength(library.summary.links);
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => !LOWERCASE_UUID.test(id))).toEqual([]);
    const known = new Set(ids);
    expect(links.filter((link) => !known.has(link.target))).toEqual([]);
    expect(links.filter((link) => link.source === null)).toEqual([]);
    expect(docs.filter((doc) => doc.nodes.length === 0)).toHaveLength(
      library.summary.filesWithoutIds.length,
    );
    expect(docs.every((doc) => doc.eol === 'lf')).toBe(true);
    expect(docs.filter((doc) => doc.nodes.some((node) => node.level > 0)).length).toBeGreaterThan(0);
  });

  it('has the folders, kinds of text, and size that were asked for', () => {
    const { library, tree } = written('shape');
    const paths = Object.keys(tree);
    const text = library.files.map((file) => file.text).join('');

    expect(library.summary.filesWithoutIds).toHaveLength(3);
    expect(paths.some((path) => path.startsWith('daily/'))).toBe(true);
    expect(paths.some((path) => path.includes('/') && !path.startsWith('daily/'))).toBe(true);
    expect(paths.some((path) => !path.includes('/'))).toBe(true);
    expect(paths.some((path) => path.includes('知识管理'))).toBe(true);
    expect(text).toMatch(/[぀-ヿ]/);
    expect(text).toMatch(/[一-鿿]/);
    expect(text).toContain('café');
    // Within a note's worth of what was asked for.
    expect(Math.abs(library.summary.bytes - 512 * 1024)).toBeLessThan(32 * 1024);
  });

  it('indexes cleanly, with the counts it reports', async () => {
    const { library, tree } = written('indexed');
    const store = new MemoryFileStore(tree);
    index = await LibraryIndex.open(env.host, 'generated');

    const result = await index.rebuild(store);
    expect(result).toMatchObject({ listing: 'complete', readFailures: [], changed: [] });
    expect(result.added).toHaveLength(library.summary.notes);

    expect(await index.counts()).toEqual({
      files: library.summary.notes,
      nodes: library.summary.nodes,
      links: library.summary.links,
    });
    expect(await index.notesSize()).toBe(library.summary.bytes);
    const problems = await index.problems();
    expect(problems).toMatchObject({
      duplicateIds: [],
      unresolvedLinks: [],
      invalidUtf8: [],
      notDownloaded: [],
      unreadable: [],
    });
    expect(problems.filesWithoutIds).toEqual([...library.summary.filesWithoutIds].sort());
  });

  it('refuses a directory with anything in it', () => {
    const directory = join(base, 'occupied');
    written('occupied');
    writeFileSync(join(directory, 'keep.txt'), 'keep');
    expect(() => writeLibrary(generateLibrary(SMALL), directory)).toThrow("isn't empty");
    expect(readFileSync(join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('rejects sizes it can not honor', () => {
    expect(() => generateLibrary({ notes: 5 })).toThrow('at least');
    expect(() => generateLibrary({ seed: Number.NaN })).toThrow('seed');
    expect(() => generateLibrary({ totalBytes: Number.NaN })).toThrow('size');
  });
});
