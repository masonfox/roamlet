import { conflictCopies, isNotePath, isSameOrInside, parentOf } from '../library/paths';
import { decodeUtf8 } from '../library/utf8';
import { scan, titleFromFileName } from '../org';
import type {
  FileEntry,
  FileStore,
  FileStoreFailure,
  PathFailure,
  SqlDriver,
  SqlExecutor,
} from '../ports';
import { normalizeSearchText, searchUnits } from './search-text';

/**
 * - `ok`: indexed from the file's current content.
 * - `invalid_utf8`: read, but not valid UTF-8, so never decoded.
 * - `unreadable`: the last attempt to read it failed.
 * - `not_downloaded`: its content is not on the device.
 *
 * With the last two, rows from when the file was last readable are kept. `hash` tells them apart
 * from a file that has never been read.
 */
export type FileStatus = 'ok' | 'invalid_utf8' | 'unreadable' | 'not_downloaded';

/** What the index may do to a library: read it. `createExclusive` and `replaceFile` stay out. */
export type IndexFileSource = Pick<FileStore, 'list' | 'digest' | 'readBytes' | 'requestDownload'>;

export interface ReconcileProgress {
  /** Notes handled so far in this run, unchanged ones included. */
  processed: number;
  /** Notes in the listing. */
  total: number;
}

export interface ReconcileOptions {
  /** Called after each note. An index built from nothing can be queried as it fills. */
  onProgress?: (progress: ReconcileProgress) => void;
  /** Paths per `requestDownload` call. */
  downloadBatchSize?: number;
}

export interface ReconcileResult {
  /**
   * `failed` means nothing could be listed, so the app should show the reconnect state. `partial`
   * means some folders could not be listed, and `listingFailures` says which.
   */
  listing: 'complete' | 'partial' | 'failed';
  listingFailures: PathFailure[];
  /** Files seen for the first time. */
  added: string[];
  /** Known files whose nodes, links, and search text were redone. */
  changed: string[];
  /** Files a listing showed are gone. */
  removed: string[];
  /** Files that could not be read in this run. Any rows they already had are kept. */
  readFailures: PathFailure[];
  /** Files whose download was requested in this run. They get content in a later reconcile. */
  downloadsRequested: string[];
  downloadFailures: PathFailure[];
}

const DEFAULT_DOWNLOAD_BATCH_SIZE = 50;

interface IndexedRow {
  path: string;
  size: number;
  mtime: number;
  hash: string | null;
  status: FileStatus;
}

interface ConflictCopyRow {
  path: string;
  size: number;
  mtime: number;
}

async function clearFile(tx: SqlExecutor, path: string): Promise<void> {
  await tx.run(
    'DELETE FROM search WHERE rowid IN (SELECT rowid FROM search_units WHERE file_path = ?)',
    [path],
  );
  await tx.run('DELETE FROM search_units WHERE file_path = ?', [path]);
  await tx.run(
    'DELETE FROM node_tags WHERE node_rowid IN (SELECT rowid FROM nodes WHERE file_path = ?)',
    [path],
  );
  await tx.run('DELETE FROM links WHERE file_path = ?', [path]);
  await tx.run('DELETE FROM nodes WHERE file_path = ?', [path]);
  await tx.run('DELETE FROM files WHERE path = ?', [path]);
}

async function insertFile(
  tx: SqlExecutor,
  entry: FileEntry,
  file: { hash: string | null; eol: string | null; status: FileStatus; title: string },
): Promise<void> {
  await tx.run(
    `INSERT INTO files (path, parent, name, size, mtime, hash, eol, status, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.path,
      parentOf(entry.path),
      entry.name,
      entry.size,
      entry.mtime,
      file.hash,
      file.eol,
      file.status,
      file.title,
    ],
  );
}

async function insertSearchUnit(
  tx: SqlExecutor,
  path: string,
  nodeRowid: number | null,
  title: string,
  body: string,
): Promise<void> {
  const unit = await tx.run('INSERT INTO search_units (file_path, node_rowid) VALUES (?, ?)', [
    path,
    nodeRowid,
  ]);
  await tx.run('INSERT INTO search (rowid, title, body) VALUES (?, ?, ?)', [
    unit.lastInsertRowId,
    title,
    body,
  ]);
}

/** Replaces all of a file's rows with what its text says, in one transaction. */
async function writeScanned(
  db: SqlDriver,
  entry: FileEntry,
  hash: string,
  text: string,
): Promise<void> {
  const doc = scan(text, { fileName: entry.name });
  const units = searchUnits(text, doc);
  await db.transaction(async (tx) => {
    await clearFile(tx, entry.path);
    await insertFile(tx, entry, { hash, eol: doc.eol, status: 'ok', title: doc.title });

    const nodeRowids: number[] = [];
    for (const node of doc.nodes) {
      const inserted = await tx.run(
        'INSERT INTO nodes (id, file_path, level, title, start_offset) VALUES (?, ?, ?, ?, ?)',
        [node.id, entry.path, node.level, node.title, node.startOffset],
      );
      nodeRowids.push(inserted.lastInsertRowId);
      for (const tag of node.tags) {
        await tx.run('INSERT INTO node_tags (node_rowid, tag) VALUES (?, ?)', [
          inserted.lastInsertRowId,
          tag,
        ]);
      }
    }
    for (const link of doc.links) {
      await tx.run(
        `INSERT INTO links (file_path, source_rowid, target_id, description, start_offset)
         VALUES (?, ?, ?, ?, ?)`,
        [
          entry.path,
          link.source === null ? null : nodeRowids[link.source],
          link.target,
          link.description,
          link.span.start,
        ],
      );
    }
    for (const unit of units) {
      const rowid = unit.node === null ? null : nodeRowids[unit.node];
      await insertSearchUnit(tx, entry.path, rowid, unit.title, unit.body);
    }
  });
}

/** Replaces all of a file's rows with an entry known only by name. */
async function writeNameOnly(
  db: SqlDriver,
  entry: FileEntry,
  file: { hash: string | null; status: FileStatus },
): Promise<void> {
  const title = titleFromFileName(entry.name);
  await db.transaction(async (tx) => {
    await clearFile(tx, entry.path);
    await insertFile(tx, entry, { ...file, eol: null, title });
    await insertSearchUnit(tx, entry.path, null, normalizeSearchText(title), '');
  });
}

async function setStatus(db: SqlDriver, path: string, status: FileStatus): Promise<void> {
  await db.run('UPDATE files SET status = ? WHERE path = ?', [status, path]);
}

/**
 * Records that a file's content can't be had right now. Existing rows stay: the file is still
 * there, so nothing says its content changed.
 */
async function markWithoutContent(
  db: SqlDriver,
  entry: FileEntry,
  indexed: IndexedRow | undefined,
  status: FileStatus,
): Promise<void> {
  if (!indexed) await writeNameOnly(db, entry, { hash: null, status });
  else if (indexed.status !== status) await setStatus(db, entry.path, status);
}

async function handleReadFailure(
  db: SqlDriver,
  entry: FileEntry,
  indexed: IndexedRow | undefined,
  failure: FileStoreFailure,
  result: ReconcileResult,
): Promise<void> {
  // Gone since the listing, which the next listing will settle.
  if (failure.kind === 'not_found') return;
  if (failure.kind === 'not_downloaded') {
    await markWithoutContent(db, entry, indexed, 'not_downloaded');
    return;
  }
  result.readFailures.push({ path: entry.path, failure });
  await markWithoutContent(db, entry, indexed, 'unreadable');
}

/** Whether a cloud-only file should come down: it is unread, or the listing says it changed. */
function needsDownload(entry: FileEntry, indexed: IndexedRow | undefined): boolean {
  return (
    !indexed || indexed.hash === null || indexed.size !== entry.size || indexed.mtime !== entry.mtime
  );
}

async function reconcileNote(
  files: IndexFileSource,
  db: SqlDriver,
  entry: FileEntry,
  indexed: IndexedRow | undefined,
  result: ReconcileResult,
  downloads: string[],
): Promise<void> {
  const settled = indexed?.status === 'ok' || indexed?.status === 'invalid_utf8';

  if (!entry.downloaded) {
    if (needsDownload(entry, indexed)) downloads.push(entry.path);
    await markWithoutContent(db, entry, indexed, 'not_downloaded');
    return;
  }
  if (settled && indexed.size === entry.size && indexed.mtime === entry.mtime) return;

  // Digest before reading. If the file changes in between, the stored hash is the older one, so
  // the next reconcile sees a difference and repairs the entry.
  const digest = await files.digest(entry.path);
  if (!digest.ok) {
    await handleReadFailure(db, entry, indexed, digest.failure, result);
    return;
  }
  if (settled && indexed.hash === digest.hash) {
    await db.run('UPDATE files SET size = ?, mtime = ? WHERE path = ?', [
      entry.size,
      entry.mtime,
      entry.path,
    ]);
    return;
  }

  const read = await files.readBytes(entry.path);
  if (!read.ok) {
    await handleReadFailure(db, entry, indexed, read.failure, result);
    return;
  }
  const text = decodeUtf8(read.bytes);
  if (text === null) await writeNameOnly(db, entry, { hash: digest.hash, status: 'invalid_utf8' });
  else await writeScanned(db, entry, digest.hash, text);
  (indexed ? result.changed : result.added).push(entry.path);
}

async function syncConflictCopies(
  db: SqlDriver,
  entries: FileEntry[],
  isUnknown: (path: string) => boolean,
): Promise<void> {
  const known = await db.all<ConflictCopyRow>('SELECT path, size, mtime FROM conflict_copies');
  const knownByPath = new Map(known.map((row) => [row.path, row]));
  const listed = conflictCopies(entries);
  const listedPaths = new Set(listed.map((entry) => entry.path));
  const stale = known.filter((row) => !listedPaths.has(row.path) && !isUnknown(row.path));
  const fresh = listed.filter((entry) => {
    const row = knownByPath.get(entry.path);
    return !row || row.size !== entry.size || row.mtime !== entry.mtime;
  });
  if (stale.length === 0 && fresh.length === 0) return;

  await db.transaction(async (tx) => {
    for (const row of stale) await tx.run('DELETE FROM conflict_copies WHERE path = ?', [row.path]);
    for (const entry of fresh) {
      await tx.run('INSERT OR REPLACE INTO conflict_copies (path, size, mtime) VALUES (?, ?, ?)', [
        entry.path,
        entry.size,
        entry.mtime,
      ]);
    }
  });
}

async function requestDownloads(
  files: IndexFileSource,
  paths: string[],
  batchSize: number,
  result: ReconcileResult,
): Promise<void> {
  for (let start = 0; start < paths.length; start += batchSize) {
    const batch = paths.slice(start, start + batchSize);
    const requested = await files.requestDownload(batch);
    result.downloadFailures.push(...requested.failures);
    result.downloadsRequested.push(...batch);
  }
}

/**
 * Brings the index in line with the files (Decision 5). This is the only way anything gets into the
 * index: a rebuild is this against an empty database, and picks up where it stopped because each
 * file commits on its own. It reads the library and never changes it.
 *
 * Paths are compared as the provider reports them, so a moved file is a removal and an addition. It
 * is re-scanned because the title of a note with no `#+title` comes from its name.
 */
export async function reconcile(
  files: IndexFileSource,
  db: SqlDriver,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const listing = await files.list();
  const result: ReconcileResult = {
    listing:
      listing.failures.length === 0
        ? 'complete'
        : listing.failures.some((failure) => failure.path === '')
          ? 'failed'
          : 'partial',
    listingFailures: listing.failures,
    added: [],
    changed: [],
    removed: [],
    readFailures: [],
    downloadsRequested: [],
    downloadFailures: [],
  };
  // Entries under a folder that could not be listed are unknown, not gone.
  const isUnknown = (path: string) =>
    listing.failures.some((failure) => isSameOrInside(path, failure.path));

  const rows = await db.all<IndexedRow>('SELECT path, size, mtime, hash, status FROM files');
  const indexedByPath = new Map(rows.map((row) => [row.path, row]));
  const notes = listing.entries.filter((entry) => !entry.isDir && isNotePath(entry.path));

  const downloads: string[] = [];
  let processed = 0;
  for (const entry of notes) {
    await reconcileNote(files, db, entry, indexedByPath.get(entry.path), result, downloads);
    processed += 1;
    options.onProgress?.({ processed, total: notes.length });
  }

  // Removals come after additions, so a moved note is briefly in both places rather than neither.
  const listedPaths = new Set(notes.map((entry) => entry.path));
  for (const row of rows) {
    if (listedPaths.has(row.path) || isUnknown(row.path)) continue;
    await db.transaction((tx) => clearFile(tx, row.path));
    result.removed.push(row.path);
  }

  await syncConflictCopies(db, listing.entries, isUnknown);
  await requestDownloads(
    files,
    downloads,
    options.downloadBatchSize ?? DEFAULT_DOWNLOAD_BATCH_SIZE,
    result,
  );
  return result;
}
