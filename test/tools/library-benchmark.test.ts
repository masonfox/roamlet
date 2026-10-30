import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateLibrary } from '../../scripts/generate-library';
import {
  BENCHMARK_QUERIES,
  formatBenchmarkReport,
  runLibraryBenchmark,
  type BenchmarkReport,
} from '../../src/adapters/library-benchmark';
import { LibraryIndex } from '../../src/core/index';
import { useIndexHost } from '../core/index-helpers';
import { MemoryFileStore } from '../support/memory-file-store';

const DEVICE = 'Test phone, Android 15';
const DATE = '2026-10-30';

function generatedStore(): { store: MemoryFileStore; notes: number; bytes: number } {
  const { files, summary } = generateLibrary({ seed: 3, notes: 40, totalBytes: 200 * 1024 });
  const contents = Object.fromEntries(files.map((file) => [file.path, file.text]));
  return { store: new MemoryFileStore(contents), notes: summary.notes, bytes: summary.bytes };
}

/** A full-size local run that met every budget, to change one thing at a time. */
function goodReport(changes: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    folder: 'Local',
    device: DEVICE,
    date: DATE,
    notes: 5000,
    bytes: 50 * 1024 * 1024,
    notDownloaded: 0,
    listingFailures: 0,
    listingMs: 800,
    hashingMs: 9000,
    hashed: 5000,
    hashFailures: 0,
    rebuildMs: 45000,
    rebuildFailures: 0,
    reconcileMs: [900, 700, 800],
    reconcileChanges: 0,
    searches: [{ query: 'meridian', results: 50, ms: [20, 10, 30, 10, 10] }],
    ...changes,
  };
}

function cells(row: string): string[] {
  return row
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

function rowFor(report: BenchmarkReport, measure: string): string[] {
  const line = formatBenchmarkReport(report)
    .split('\n')
    .find((candidate) => candidate.startsWith(`| ${measure} |`));
  return cells(line as string);
}

describe('runLibraryBenchmark', () => {
  const env = useIndexHost();

  it('measures a generated library, finds every query, and leaves no database behind', async () => {
    const { store, notes, bytes } = generatedStore();
    let tick = 0;
    const steps: string[] = [];
    const report = await runLibraryBenchmark({
      store,
      host: env.host,
      folder: 'Local',
      device: DEVICE,
      date: DATE,
      now: () => (tick += 5),
      onStep: (step) => steps.push(step),
    });

    expect(report).toMatchObject({
      notes,
      bytes,
      notDownloaded: 0,
      listingFailures: 0,
      hashed: notes,
      hashFailures: 0,
      rebuildFailures: 0,
      reconcileChanges: 0,
    });
    expect(report.listingMs).toBeGreaterThan(0);
    expect(report.reconcileMs).toHaveLength(3);
    expect(steps[0]).toBe('listing');
    expect(steps[steps.length - 1]).toBe('search');
    expect(report.searches.map((search) => search.query)).toEqual(BENCHMARK_QUERIES);
    for (const search of report.searches) {
      expect([search.query, search.results > 0]).toEqual([search.query, true]);
      expect(search.ms).toHaveLength(5);
    }

    // Deleted, so opening again starts empty.
    const reopened = await LibraryIndex.open(env.host, 'a8-benchmark');
    expect((await reopened.counts()).files).toBe(0);
    await reopened.close();
  });

  it('writes nothing to the library', async () => {
    const { store } = generatedStore();
    store.calls = [];
    await runLibraryBenchmark({
      store,
      host: env.host,
      folder: 'Local',
      device: DEVICE,
      date: DATE,
    });
    const ops = new Set(store.calls.map((call) => call.op));
    expect(ops.has('createExclusive')).toBe(false);
    expect(ops.has('replaceFile')).toBe(false);
  });

  it('keeps the index of the library the app has open', async () => {
    const { store } = generatedStore();
    const active = await LibraryIndex.open(env.host, 'active-library');
    await active.rebuild(new MemoryFileStore({ 'a.org': '#+title: A\n' }));

    await runLibraryBenchmark({
      store,
      host: env.host,
      folder: 'Local',
      device: DEVICE,
      date: DATE,
    });

    expect((await active.counts()).files).toBe(1);
    await active.close();
  });

  it('rejects when nothing could be listed, and leaves the failure to the caller', async () => {
    const { store } = generatedStore();
    store.failOperation('list');
    await expect(
      runLibraryBenchmark({ store, host: env.host, folder: 'Local', device: DEVICE, date: DATE }),
    ).rejects.toThrow('could not be listed');
  });

  it('counts notes that are not on the device instead of hashing them', async () => {
    const { store, notes } = generatedStore();
    store.writeFile('cloud-only.org', '#+title: Cloud\n', { downloaded: false });
    const report = await runLibraryBenchmark({
      store,
      host: env.host,
      folder: 'Cloud',
      device: DEVICE,
      date: DATE,
    });
    expect(report).toMatchObject({ notes: notes + 1, notDownloaded: 1, hashed: notes });
  });
});

describe('formatBenchmarkReport', () => {
  const validation = readFileSync(join(__dirname, '../../docs/validation.md'), 'utf8');

  /** The rows of one section in the doc: its header's column count, and its label cells. */
  function documented(heading: string): { columns: number; rows: string[][] } {
    const section = validation.split(`## ${heading}`)[1].split('\n## ')[0];
    const tableRows = section.split('\n').filter((line) => line.startsWith('|'));
    return {
      columns: cells(tableRows[0]).length,
      rows: tableRows.slice(2).map(cells),
    };
  }

  it.each(['Local', 'Cloud'] as const)('matches the %s rows in docs/validation.md', (folder) => {
    const lines = formatBenchmarkReport(goodReport({ folder })).split('\n');
    const rows = lines.filter((line) => line.startsWith('|')).map(cells);
    const baselines = documented('A8 baselines (task 1.11)');
    const benchmark = documented('A8 benchmark (task 6.8)');

    expect(rows).toHaveLength(5);
    for (const row of rows.slice(0, 2)) {
      expect(row).toHaveLength(baselines.columns);
      expect(baselines.rows.map((doc) => doc.slice(0, 2))).toContainEqual(row.slice(0, 2));
    }
    for (const row of rows.slice(2)) {
      expect(row).toHaveLength(benchmark.columns);
      expect(benchmark.rows.map((doc) => doc.slice(0, 3))).toContainEqual(row.slice(0, 3));
    }
  });

  it('fills the cells of a full-size local run', () => {
    expect(rowFor(goodReport(), 'Listing')).toEqual([
      'Listing',
      'Local',
      '',
      '5000',
      '50.00 MiB',
      '800 ms',
      DEVICE,
      DATE,
      '',
    ]);
    expect(rowFor(goodReport(), 'Full rebuild').slice(3, 5)).toEqual(['45000 ms', 'pass']);
  });

  it('judges each budget on its slowest run', () => {
    const report = goodReport({
      rebuildMs: 60000,
      reconcileMs: [100, 2000, 100],
      searches: [{ query: 'a', results: 1, ms: [1, 1, 200, 1, 1] }],
    });
    expect(rowFor(report, 'Full rebuild').slice(3, 5)).toEqual(['60000 ms', 'fail']);
    expect(rowFor(report, 'No-change launch reconcile').slice(3, 5)).toEqual(['2000 ms', 'fail']);
    expect(rowFor(report, 'Search').slice(3, 5)).toEqual(['200 ms', 'fail']);
    expect(rowFor(goodReport({ rebuildMs: 59999 }), 'Full rebuild')[4]).toBe('pass');
  });

  it.each<[string, Partial<BenchmarkReport>, string]>([
    ['too few notes', { notes: 100 }, 'smaller than'],
    ['too few bytes', { bytes: 1024 }, 'smaller than'],
    ['notes off the device', { notDownloaded: 2 }, "2 notes weren't on the device"],
    ['a partial listing', { listingFailures: 1 }, '1 folders failed to list'],
    ['a hash failure', { hashFailures: 1 }, '1 notes failed to hash'],
    ['a rebuild failure', { rebuildFailures: 1 }, '1 notes failed to index'],
    ['a change mid-run', { reconcileChanges: 1 }, 'files changed'],
  ])('leaves Result blank and says why with %s', (_name, changes, reason) => {
    const rebuild = rowFor(goodReport(changes), 'Full rebuild');
    expect(rebuild[4]).toBe('');
    expect(rebuild[7]).toContain(reason);
  });

  it('never judges a cloud folder, which has no budget yet', () => {
    const rebuild = rowFor(goodReport({ folder: 'Cloud' }), 'Full rebuild');
    expect(rebuild.slice(1, 5)).toEqual(['Cloud', 'None yet', '45000 ms', '']);
  });
});
