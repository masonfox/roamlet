import type { SqlExecutor, SqlValue } from '../ports';
import type { FileStatus } from './reconcile';
import { normalizeSearchText } from './search-text';

export interface SearchResult {
  filePath: string;
  fileTitle: string;
  fileStatus: FileStatus;
  /** Null for a result that is a file, not a node. */
  nodeId: string | null;
  /** 0 for a file or file-level node. More means a heading. */
  level: number;
  title: string;
  /** Where to position the reader. */
  startOffset: number;
}

export interface SearchOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 50;

// Weights for the title and body columns.
const BM25 = 'bm25(search, 10.0, 1.0)';

// `unicode61` keeps a run of these as one token, so FTS5 can't find a word inside one (Decision 5).
// Spelled as ranges so this doesn't depend on the engine's Unicode script data.
const UNSEGMENTED_SCRIPT =
  /[฀-໿ༀ-࿿က-႟ᄀ-ᇿក-៿⺀-⿟々-〇぀-ヿ㄰-㆏ㇰ-ㇿ㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿ｦ-ﾟ]|[\u{20000}-\u{3FFFF}]/u;

// Characters `unicode61` indexes. A term with none of them is an empty phrase, which matches nothing.
const TOKEN_CHARACTER = /[\p{L}\p{N}\p{Co}]/u;

interface ParsedQuery {
  /** Terms FTS5 can match. */
  ftsTerms: string[];
  /** Terms needing a substring scan. */
  likeTerms: string[];
}

function parseQuery(query: string): ParsedQuery {
  const terms = normalizeSearchText(query)
    .replace(/\u0000/g, ' ')
    .split(/\s+/u)
    .filter((term) => TOKEN_CHARACTER.test(term));
  return {
    ftsTerms: terms.filter((term) => !UNSEGMENTED_SCRIPT.test(term)),
    likeTerms: terms.filter((term) => UNSEGMENTED_SCRIPT.test(term)),
  };
}

/**
 * A term as a quoted FTS5 string with a prefix star. Quoting makes everything in it literal, so
 * user input can't be read as query syntax: `AND`, `title:`, `"`, `*`, `(`, `-`, and so on.
 */
function ftsTerm(term: string, column?: string): string {
  const quoted = `"${term.replace(/"/g, '""')}"*`;
  return column ? `${column} : ${quoted}` : quoted;
}

function ftsExpression(terms: string[], column?: string): string {
  return terms.map((term) => ftsTerm(term, column)).join(' AND ');
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

const LIKE_TITLE = `search.title LIKE ? ESCAPE '\\'`;
const LIKE_BODY = `search.body LIKE ? ESCAPE '\\'`;

/**
 * Searches titles and bodies with prefix matching. Every term must match, in any column.
 *
 * Results where every term is in the title come first, so that a title match always outranks a
 * body-only one as the spec requires. `bm25` alone can't promise that: a body repeating a word can
 * outscore a long title holding it once. Within each group, `bm25` orders by relevance, with path
 * and offset settling ties so results don't jump around while typing.
 */
export async function search(
  db: SqlExecutor,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const { ftsTerms, likeTerms } = parseQuery(query);
  if (ftsTerms.length === 0 && likeTerms.length === 0) return [];

  const titleTests: string[] = [];
  const titleParams: SqlValue[] = [];
  const conditions: string[] = [];
  const conditionParams: SqlValue[] = [];
  if (ftsTerms.length > 0) {
    titleTests.push('search.rowid IN (SELECT rowid FROM search WHERE search MATCH ?)');
    titleParams.push(ftsExpression(ftsTerms, 'title'));
    conditions.push('search MATCH ?');
    conditionParams.push(ftsExpression(ftsTerms));
  }
  for (const term of likeTerms) {
    const pattern = likePattern(term);
    titleTests.push(LIKE_TITLE);
    titleParams.push(pattern);
    conditions.push(`(${LIKE_TITLE} OR ${LIKE_BODY})`);
    conditionParams.push(pattern, pattern);
  }

  const rows = await db.all<{
    file_path: string;
    file_title: string;
    status: FileStatus;
    node_id: string | null;
    level: number | null;
    title: string;
    start_offset: number | null;
  }>(
    `SELECT f.path AS file_path, f.title AS file_title, f.status,
            n.id AS node_id, n.level, search.title, n.start_offset
     FROM search
     JOIN search_units u ON u.rowid = search.rowid
     JOIN files f ON f.path = u.file_path
     LEFT JOIN nodes n ON n.rowid = u.node_rowid
     WHERE ${conditions.join(' AND ')}
     ORDER BY (${titleTests.join(' AND ')}) DESC,
              ${ftsTerms.length > 0 ? `${BM25},` : ''}
              f.path, n.start_offset
     LIMIT ?`,
    [...conditionParams, ...titleParams, options.limit ?? DEFAULT_LIMIT],
  );
  return rows.map((row) => ({
    filePath: row.file_path,
    fileTitle: row.file_title,
    fileStatus: row.status,
    nodeId: row.node_id,
    level: row.level ?? 0,
    title: row.title,
    startOffset: row.start_offset ?? 0,
  }));
}
