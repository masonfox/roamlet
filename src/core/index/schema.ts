import type { SqlDatabaseHost, SqlDriver } from '../ports';

/** Change this with any change to `SCHEMA`. A database with another version is deleted and rebuilt. */
export const SCHEMA_VERSION = 1;

// `hash` is null until the file's content has been read. `search_units` says what each `search` row
// (same rowid) belongs to; `node_rowid` is null for a file-level row of a file with no such node.
// `links.source_rowid` is null for a link outside any node.
const SCHEMA = `
  CREATE TABLE files (
    path TEXT PRIMARY KEY NOT NULL,
    parent TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    hash TEXT,
    eol TEXT,
    status TEXT NOT NULL,
    title TEXT NOT NULL
  );
  CREATE INDEX files_parent ON files (parent, name);

  CREATE TABLE nodes (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    level INTEGER NOT NULL,
    title TEXT NOT NULL,
    start_offset INTEGER NOT NULL
  );
  CREATE INDEX nodes_id ON nodes (id, file_path, start_offset);
  CREATE INDEX nodes_file ON nodes (file_path, start_offset);

  CREATE TABLE node_tags (
    node_rowid INTEGER NOT NULL,
    tag TEXT NOT NULL
  );
  CREATE INDEX node_tags_node ON node_tags (node_rowid);

  CREATE TABLE links (
    rowid INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    source_rowid INTEGER,
    target_id TEXT NOT NULL,
    description TEXT,
    start_offset INTEGER NOT NULL
  );
  CREATE INDEX links_target ON links (target_id);
  CREATE INDEX links_file ON links (file_path, start_offset);

  CREATE TABLE search_units (
    rowid INTEGER PRIMARY KEY,
    file_path TEXT NOT NULL,
    node_rowid INTEGER
  );
  CREATE INDEX search_units_file ON search_units (file_path);

  CREATE VIRTUAL TABLE search USING fts5(title, body, tokenize="unicode61 remove_diacritics 2");

  CREATE TABLE conflict_copies (
    path TEXT PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL
  );

  PRAGMA user_version = ${SCHEMA_VERSION};
`;

/** One database per library, so switching library can never mix their entries. */
export function indexDatabaseName(libraryId: string): string {
  return `index-${encodeURIComponent(libraryId)}.db`;
}

/** The database at its current version, or null if it needs recreating. */
async function openCurrent(host: SqlDatabaseHost, name: string): Promise<SqlDriver | null> {
  let db: SqlDriver | null = null;
  try {
    db = await host.open(name);
    const row = await db.get<{ user_version: number }>('PRAGMA user_version');
    if (row?.user_version === SCHEMA_VERSION) {
      await db.get('SELECT path FROM files LIMIT 1');
      await db.get('SELECT rowid FROM search LIMIT 1');
      return db;
    }
  } catch {
    // Unreadable is handled like an old version: the index is only ever a cache of the files.
  }
  await db?.close().catch(() => undefined);
  return null;
}

/**
 * Opens a library's index, recreating it when it is missing, unreadable, or another version. An
 * empty index then fills through `reconcile`. See Decision 5.
 */
export async function openIndexDatabase(host: SqlDatabaseHost, name: string): Promise<SqlDriver> {
  const current = await openCurrent(host, name);
  if (current) return current;

  await host.delete(name);
  const db = await host.open(name);
  try {
    await db.transaction((tx) => tx.exec(SCHEMA));
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  return db;
}
