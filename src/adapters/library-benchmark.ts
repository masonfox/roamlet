// The on-device A8 measurements (tasks 1.11 and 6.8), started from app/spike.tsx. Task 1.12 deletes
// this file with that screen, and it is not reachable from anywhere else in the app.

import { LibraryIndex } from '../core/index';
import { indexDatabaseName } from '../core/index/schema';
import { isNotePath } from '../core/library/paths';
import type { FileStore, LibraryRoot, SqlDatabaseHost } from '../core/ports';
import { openRoamletFsStore, type RoamletFsRootApi } from './roamlet-fs-file-store';

/** Its own database, so a run can't touch the index of the library the app has open. */
const BENCHMARK_LIBRARY_ID = 'a8-benchmark';

const MIB = 1024 * 1024;
const FULL_LIBRARY_NOTES = 5000;
// The generator lands on 50 MiB, and a real library only needs to be near it.
const FULL_LIBRARY_BYTES = 45 * MIB;

const RECONCILE_RUNS = 3;
const SEARCH_RUNS = 5;

/** A mix of what's fast and slow, and all found in a library from `npm run generate-library`. */
export const BENCHMARK_QUERIES = ['meridian', 'merid', 'meridian lantern', 'quokka', 'cafe', '知识'];

/** Which A8 rows the run fills. Only the folder's owner knows, so the person running it says. */
export type BenchmarkFolder = 'Local' | 'Cloud';

export interface BenchmarkOptions {
  store: FileStore;
  host: SqlDatabaseHost;
  folder: BenchmarkFolder;
  /** For the report's Device and OS cells. */
  device: string;
  /** For the report's Date cells, as YYYY-MM-DD. */
  date: string;
  /** Milliseconds, from any starting point. */
  now?: () => number;
  /** Called as each step starts. */
  onStep?: (step: string) => void;
}

export interface BenchmarkReport {
  folder: BenchmarkFolder;
  device: string;
  date: string;
  notes: number;
  bytes: number;
  /** Notes with content only at the provider, which were skipped or got a download request. */
  notDownloaded: number;
  listingFailures: number;
  listingMs: number;
  hashingMs: number;
  hashed: number;
  hashFailures: number;
  rebuildMs: number;
  /** Notes the rebuild could not read. */
  rebuildFailures: number;
  /** Each no-change launch: opening the index, then reconciling. */
  reconcileMs: number[];
  /** Files the reconciles found to have changed, which should be none. */
  reconcileChanges: number;
  /** Search times in run order, per query in `BENCHMARK_QUERIES`. */
  searches: { query: string; results: number; ms: number[] }[];
}

/**
 * Times listing, hashing, a rebuild, no-change launches, and searches, one after another. It reads
 * the library and writes nothing to it, except that a reconcile asks the provider for files that
 * aren't on the device, as the app does. Its database is gone afterward.
 */
export async function runLibraryBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const { store, host, folder, device, date, now = Date.now, onStep } = options;
  const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const started = now();
    const value = await work();
    return { value, ms: now() - started };
  };

  onStep?.('listing');
  const listing = await timed(() => store.list());
  if (listing.value.failures.some((failure) => failure.path === '')) {
    throw new Error(`the folder could not be listed: ${JSON.stringify(listing.value.failures)}`);
  }
  const notes = listing.value.entries.filter((entry) => !entry.isDir && isNotePath(entry.path));
  const present = notes.filter((entry) => entry.downloaded);

  onStep?.('hashing');
  const hashing = await timed(async () => {
    let failures = 0;
    for (const entry of present) {
      const digest = await store.digest(entry.path);
      if (!digest.ok) failures += 1;
    }
    return failures;
  });

  const name = indexDatabaseName(BENCHMARK_LIBRARY_ID);
  let index = await LibraryIndex.open(host, BENCHMARK_LIBRARY_ID);
  try {
    onStep?.('rebuild');
    const rebuild = await timed(() => index.rebuild(store));

    const reconcileMs: number[] = [];
    let reconcileChanges = 0;
    for (let run = 1; run <= RECONCILE_RUNS; run += 1) {
      onStep?.(`no-change reconcile ${run} of ${RECONCILE_RUNS}`);
      await index.close();
      const launch = await timed(async () => {
        index = await LibraryIndex.open(host, BENCHMARK_LIBRARY_ID);
        return index.reconcile(store);
      });
      reconcileMs.push(launch.ms);
      const { added, changed, removed } = launch.value;
      reconcileChanges += added.length + changed.length + removed.length;
    }

    onStep?.('search');
    const searches: BenchmarkReport['searches'] = [];
    for (const query of BENCHMARK_QUERIES) {
      const ms: number[] = [];
      let results = 0;
      for (let run = 0; run < SEARCH_RUNS; run += 1) {
        const found = await timed(() => index.search(query));
        ms.push(found.ms);
        results = found.value.length;
      }
      searches.push({ query, results, ms });
    }

    return {
      folder,
      device,
      date,
      notes: notes.length,
      bytes: notes.reduce((sum, entry) => sum + entry.size, 0),
      notDownloaded: notes.length - present.length,
      listingFailures: listing.value.failures.length,
      listingMs: listing.ms,
      hashingMs: hashing.ms,
      hashed: present.length - hashing.value,
      hashFailures: hashing.value,
      rebuildMs: rebuild.ms,
      rebuildFailures: rebuild.value.readFailures.length,
      reconcileMs,
      reconcileChanges,
      searches,
    };
  } finally {
    await index.close();
    await host.delete(name);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(' | ')} |`.replaceAll('|  |', '| |');
}

/** Why this run can't judge A8's budgets. Empty when it can. */
function disqualifiers(report: BenchmarkReport): string[] {
  const reasons: string[] = [];
  if (report.notes < FULL_LIBRARY_NOTES || report.bytes < FULL_LIBRARY_BYTES) {
    reasons.push('smaller than the 5,000-note, 50 MiB library');
  }
  if (report.listingFailures > 0) reasons.push(`${report.listingFailures} folders failed to list`);
  if (report.notDownloaded > 0) reasons.push(`${report.notDownloaded} notes weren't on the device`);
  if (report.hashFailures > 0) reasons.push(`${report.hashFailures} notes failed to hash`);
  if (report.rebuildFailures > 0) reasons.push(`${report.rebuildFailures} notes failed to index`);
  if (report.reconcileChanges > 0) reasons.push('files changed during the run');
  return reasons;
}

/**
 * The report as Markdown table rows, with the same columns as the A8 sections of
 * `docs/validation.md`. Times are the slowest run, which is what a budget has to hold for. Provider
 * is left for the person running it, and Result is left blank unless a budget applies and the run
 * can judge it.
 */
export function formatBenchmarkReport(report: BenchmarkReport): string {
  const { folder, device, date, notes, bytes } = report;
  const size = `${(bytes / MIB).toFixed(2)} MiB`;
  const reasons = disqualifiers(report);
  const caveat = reasons.join('; ');

  const budgetRow = (measure: string, budgetMs: number, budget: string, ms: number, note: string) => {
    const judged = folder === 'Local' && reasons.length === 0;
    const result = judged ? (ms < budgetMs ? 'pass' : 'fail') : '';
    const noteCell = [note, caveat].filter((part) => part !== '').join('; ');
    return row([
      measure,
      folder,
      folder === 'Local' ? budget : 'None yet',
      `${ms} ms`,
      result,
      device,
      date,
      noteCell,
    ]);
  };

  const searchMs = report.searches.flatMap((search) => search.ms);
  const searchNotes = report.searches
    .map((search) => `"${search.query}" ${search.results} results, median ${median(search.ms)} ms`)
    .join(', ');

  return [
    `A8 baselines (task 1.11), ${folder} folder`,
    row(['Listing', folder, '', notes, size, `${report.listingMs} ms`, device, date, caveat]),
    row([
      'Hashing',
      folder,
      '',
      notes,
      size,
      `${report.hashingMs} ms`,
      device,
      date,
      [`${report.hashed} notes hashed`, caveat].filter((part) => part !== '').join('; '),
    ]),
    '',
    `A8 benchmark (task 6.8), ${folder} folder`,
    budgetRow('Full rebuild', 60000, 'Under 60 s', report.rebuildMs, ''),
    budgetRow(
      'No-change launch reconcile',
      2000,
      'Under 2 s',
      Math.max(...report.reconcileMs),
      `runs: ${report.reconcileMs.join(', ')} ms`,
    ),
    budgetRow('Search', 200, 'Under 200 ms', Math.max(...searchMs), searchNotes),
  ].join('\n');
}

/** Runs the benchmark on `root` on this device, keeping its database with the real index's. */
export async function runBenchmarkOnDevice(
  fs: RoamletFsRootApi,
  root: LibraryRoot,
  options: Pick<BenchmarkOptions, 'folder' | 'device' | 'date' | 'onStep'>,
): Promise<BenchmarkReport> {
  const restored = await fs.restore(root);
  if (restored.status !== 'ok' && restored.status !== 'stale') {
    throw new Error(`the folder is ${restored.status}`);
  }
  const target = restored.status === 'stale' ? restored.root : root;
  const [{ Paths }, { ExpoSqlDatabaseHost }] = await Promise.all([
    import('expo-file-system'),
    import('./expo-sql-driver'),
  ]);
  return runLibraryBenchmark({
    ...options,
    store: openRoamletFsStore(fs, target),
    host: new ExpoSqlDatabaseHost(Paths.cache.uri),
  });
}
