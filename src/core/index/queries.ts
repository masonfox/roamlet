import type { SqlExecutor } from '../ports';
import { conflictCopyNotePath } from './conflict-copies';
import type { FileStatus } from './reconcile';

export interface IndexedFile {
  path: string;
  name: string;
  /** The display title. For a file whose content is unknown, from its name. */
  title: string;
  status: FileStatus;
  /** Has at least one node. Meaningless without `contentIndexed`: use it to mark "no ID". */
  hasNodes: boolean;
  /** False when the file's content has never been read, or could not be decoded. */
  contentIndexed: boolean;
  size: number;
  mtime: number;
}

export interface FolderEntry {
  path: string;
  name: string;
}

/** One folder's direct contents. Folders with no notes at any depth don't exist in the index. */
export interface FolderListing {
  folders: FolderEntry[];
  files: IndexedFile[];
}

export interface IndexedNode {
  id: string;
  filePath: string;
  /** 0 for a file-level node. */
  level: number;
  title: string;
  tags: string[];
  /** Where to position the reader. 0 for a file-level node. */
  startOffset: number;
}

export interface Backlink {
  /** The node containing the link. */
  source: IndexedNode;
  targetId: string;
  description: string | null;
  /** Of the link, in the source's file. */
  startOffset: number;
}

export interface OutgoingLink {
  /** Null when the link is outside any node. */
  sourceId: string | null;
  targetId: string;
  description: string | null;
  startOffset: number;
  /** The node the link resolves to, or null if it is unresolved. */
  target: IndexedNode | null;
}

export interface DuplicateId {
  id: string;
  /** Every node with this ID, the one links resolve to first. */
  nodes: IndexedNode[];
}

export interface UnresolvedLink {
  filePath: string;
  /** Null when the link is outside any node. */
  sourceId: string | null;
  targetId: string;
  description: string | null;
  startOffset: number;
}

export interface NotDownloadedFile {
  path: string;
  /** True for a file the provider evicted: search and backlinks still cover it. */
  contentIndexed: boolean;
}

export interface LibraryProblems {
  duplicateIds: DuplicateId[];
  unresolvedLinks: UnresolvedLink[];
  /** Files whose content is known and has no nodes. */
  filesWithoutIds: string[];
  invalidUtf8: string[];
  notDownloaded: NotDownloadedFile[];
  unreadable: string[];
}

export interface LibraryCounts {
  files: number;
  nodes: number;
  links: number;
}

export interface ConflictCopy {
  path: string;
  /** The note it was saved from. That note may no longer exist. */
  notePath: string;
  size: number;
  mtime: number;
}

interface NodeRow {
  id: string;
  file_path: string;
  level: number;
  title: string;
  tags_json: string;
  start_offset: number;
}

interface FileRow {
  path: string;
  name: string;
  title: string;
  status: FileStatus;
  has_nodes: number;
  hash: string | null;
  size: number;
  mtime: number;
}

const NODE_COLUMNS = `n.id, n.file_path, n.level, n.title, n.start_offset,
  (SELECT json_group_array(tag) FROM node_tags WHERE node_rowid = n.rowid) AS tags_json`;

const FILE_COLUMNS = `f.path, f.name, f.title, f.status, f.hash, f.size, f.mtime,
  EXISTS (SELECT 1 FROM nodes WHERE file_path = f.path) AS has_nodes`;

function toNode(row: NodeRow): IndexedNode {
  return {
    id: row.id,
    filePath: row.file_path,
    level: row.level,
    title: row.title,
    tags: JSON.parse(row.tags_json) as string[],
    startOffset: row.start_offset,
  };
}

function toFile(row: FileRow): IndexedFile {
  return {
    path: row.path,
    name: row.name,
    title: row.title,
    status: row.status,
    hasNodes: row.has_nodes === 1,
    contentIndexed: row.hash !== null && row.status !== 'invalid_utf8',
    size: row.size,
    mtime: row.mtime,
  };
}

/** Direct contents of a folder, `''` being the library root, from the index alone. */
export async function listFolder(db: SqlExecutor, path: string): Promise<FolderListing> {
  const files = await db.all<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM files f WHERE f.parent = ? ORDER BY f.name`,
    [path],
  );
  // '0' is the character after '/', so this range is exactly the paths inside `path`.
  const parents =
    path === ''
      ? await db.all<{ parent: string }>(`SELECT DISTINCT parent FROM files WHERE parent <> ''`)
      : await db.all<{ parent: string }>(
          'SELECT DISTINCT parent FROM files WHERE parent >= ? AND parent < ?',
          [`${path}/`, `${path}0`],
        );
  const prefix = path === '' ? '' : `${path}/`;
  const names = new Set(parents.map((row) => row.parent.slice(prefix.length).split('/')[0]));
  return {
    folders: [...names].sort().map((name) => ({ path: `${prefix}${name}`, name })),
    files: files.map(toFile),
  };
}

export async function getFile(db: SqlExecutor, path: string): Promise<IndexedFile | null> {
  const row = await db.get<FileRow>(`SELECT ${FILE_COLUMNS} FROM files f WHERE f.path = ?`, [path]);
  return row && toFile(row);
}

/** A file's nodes in document order. */
export async function nodesInFile(db: SqlExecutor, path: string): Promise<IndexedNode[]> {
  const rows = await db.all<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.file_path = ? ORDER BY n.start_offset`,
    [path],
  );
  return rows.map(toNode);
}

/** Every node with this ID, the one links resolve to first: lowest path, then earliest in it. */
async function nodesWithId(db: SqlExecutor, id: string): Promise<IndexedNode[]> {
  const rows = await db.all<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id = ? ORDER BY n.file_path, n.start_offset`,
    [id],
  );
  return rows.map(toNode);
}

/** The node a link to this ID opens, or null if the link is unresolved. */
export async function resolveLink(db: SqlExecutor, id: string): Promise<IndexedNode | null> {
  const row = await db.get<NodeRow>(
    `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id = ?
     ORDER BY n.file_path, n.start_offset LIMIT 1`,
    [id],
  );
  return row && toNode(row);
}

async function backlinksWhere(
  db: SqlExecutor,
  condition: string,
  param: string,
): Promise<Backlink[]> {
  const rows = await db.all<
    NodeRow & { target_id: string; description: string | null; link_offset: number }
  >(
    `SELECT ${NODE_COLUMNS}, l.target_id, l.description, l.start_offset AS link_offset
     FROM links l JOIN nodes n ON n.rowid = l.source_rowid
     WHERE ${condition}
     ORDER BY n.file_path, l.start_offset`,
    [param],
  );
  return rows.map((row) => ({
    source: toNode(row),
    targetId: row.target_id,
    description: row.description,
    startOffset: row.link_offset,
  }));
}

/**
 * Links to this ID. As in Org-roam, a backlink comes from a node, so a link outside any node has no
 * backlink entry. It still appears in `outgoingLinks` for its own file.
 */
export function backlinks(db: SqlExecutor, id: string): Promise<Backlink[]> {
  return backlinksWhere(db, 'l.target_id = ?', id);
}

/** Links to any node in this file: the backlinks of an open note. */
export function backlinksForFile(db: SqlExecutor, path: string): Promise<Backlink[]> {
  return backlinksWhere(db, 'l.target_id IN (SELECT id FROM nodes WHERE file_path = ?)', path);
}

/** Every ID link in a file in document order, resolved as of now. */
export async function outgoingLinks(db: SqlExecutor, path: string): Promise<OutgoingLink[]> {
  const rows = await db.all<{
    source_id: string | null;
    target_id: string;
    description: string | null;
    start_offset: number;
  }>(
    `SELECT s.id AS source_id, l.target_id, l.description, l.start_offset
     FROM links l LEFT JOIN nodes s ON s.rowid = l.source_rowid
     WHERE l.file_path = ?
     ORDER BY l.start_offset`,
    [path],
  );
  const targets = new Map<string, IndexedNode | null>();
  for (const { target_id: id } of rows) {
    if (!targets.has(id)) targets.set(id, await resolveLink(db, id));
  }
  return rows.map((row) => ({
    sourceId: row.source_id,
    targetId: row.target_id,
    description: row.description,
    startOffset: row.start_offset,
    target: targets.get(row.target_id) ?? null,
  }));
}

export async function duplicateIds(db: SqlExecutor): Promise<DuplicateId[]> {
  const rows = await db.all<{ id: string }>(
    'SELECT id FROM nodes GROUP BY id HAVING COUNT(*) > 1 ORDER BY id',
  );
  const duplicates: DuplicateId[] = [];
  for (const { id } of rows) duplicates.push({ id, nodes: await nodesWithId(db, id) });
  return duplicates;
}

export async function unresolvedLinks(db: SqlExecutor): Promise<UnresolvedLink[]> {
  const rows = await db.all<{
    file_path: string;
    source_id: string | null;
    target_id: string;
    description: string | null;
    start_offset: number;
  }>(
    `SELECT l.file_path, s.id AS source_id, l.target_id, l.description, l.start_offset
     FROM links l LEFT JOIN nodes s ON s.rowid = l.source_rowid
     WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = l.target_id)
     ORDER BY l.file_path, l.start_offset`,
  );
  return rows.map((row) => ({
    filePath: row.file_path,
    sourceId: row.source_id,
    targetId: row.target_id,
    description: row.description,
    startOffset: row.start_offset,
  }));
}

async function pathsWithStatus(db: SqlExecutor, status: FileStatus): Promise<string[]> {
  const rows = await db.all<{ path: string }>(
    'SELECT path FROM files WHERE status = ? ORDER BY path',
    [status],
  );
  return rows.map((row) => row.path);
}

/** Everything the data problem report needs, without touching any file. */
export async function libraryProblems(db: SqlExecutor): Promise<LibraryProblems> {
  const withoutIds = await db.all<{ path: string }>(
    `SELECT path FROM files f
     WHERE f.hash IS NOT NULL AND f.status <> 'invalid_utf8'
       AND NOT EXISTS (SELECT 1 FROM nodes WHERE file_path = f.path)
     ORDER BY path`,
  );
  const notDownloaded = await db.all<{ path: string; hash: string | null }>(
    `SELECT path, hash FROM files WHERE status = 'not_downloaded' ORDER BY path`,
  );
  return {
    duplicateIds: await duplicateIds(db),
    unresolvedLinks: await unresolvedLinks(db),
    filesWithoutIds: withoutIds.map((row) => row.path),
    invalidUtf8: await pathsWithStatus(db, 'invalid_utf8'),
    notDownloaded: notDownloaded.map((row) => ({
      path: row.path,
      contentIndexed: row.hash !== null,
    })),
    unreadable: await pathsWithStatus(db, 'unreadable'),
  };
}

export async function libraryCounts(db: SqlExecutor): Promise<LibraryCounts> {
  const row = await db.get<LibraryCounts>(
    `SELECT (SELECT COUNT(*) FROM files) AS files,
            (SELECT COUNT(*) FROM nodes) AS nodes,
            (SELECT COUNT(*) FROM links) AS links`,
  );
  return row as LibraryCounts;
}

/** Conflict copies as of the last listing. Kept when a folder can't be listed, like other entries. */
export async function conflictCopies(db: SqlExecutor): Promise<ConflictCopy[]> {
  const rows = await db.all<{ path: string; size: number; mtime: number }>(
    'SELECT path, size, mtime FROM conflict_copies ORDER BY path',
  );
  return rows.map((row) => ({ ...row, notePath: conflictCopyNotePath(row.path) as string }));
}
