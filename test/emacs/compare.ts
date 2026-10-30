import { scan } from '../../src/core/org';
import type { OrgDocument } from '../../src/core/org';

export interface OracleNode {
  id: string;
  file: string;
  level: number;
  /** One-based character position in the buffer Emacs decoded. */
  pos: number;
  title: string;
  tags: string[];
}

export interface OracleLink {
  source: string;
  dest: string;
}

export interface Results {
  files: string[];
  nodes: OracleNode[];
  links: OracleLink[];
}

/** The JSON that `oracle.el` writes. */
export interface OracleDump extends Results {
  versions: Record<string, string>;
  nodes: (OracleNode & { slug: string })[];
  /** From Org-roam's own backlink lookup, for each node. */
  backlinks: OracleLink[];
  /** The description Org parses for each `id:` link that has one. */
  descriptions: { file: string; dest: string; description: string }[];
}

/** A known difference. `difference` is compared exactly, so a changed result needs a new entry. */
export interface AllowlistEntry {
  difference: string;
  reason: string;
}

export interface Comparison {
  /** Differences with no allowlist entry. */
  unexpected: string[];
  /** Allowlist entries that no longer describe a difference. */
  stale: string[];
  /** Allowlist entries with no reason. */
  unjustified: string[];
}

/** The scanner's results over a map of file name to text, in the oracle's shape. */
export function scanFiles(files: Record<string, string>): Results {
  const nodes: OracleNode[] = [];
  const links: OracleLink[] = [];
  for (const [file, text] of Object.entries(files)) {
    const doc = scan(text, { fileName: file });
    for (const node of doc.nodes) {
      nodes.push({
        id: node.id,
        file,
        level: node.level,
        pos: emacsPosition(text, doc, node.startOffset),
        title: node.title,
        tags: [...node.tags].sort(),
      });
    }
    for (const link of doc.links) {
      if (link.source !== null) links.push({ source: doc.nodes[link.source].id, dest: link.target });
    }
  }
  return { files: Object.keys(files).sort(), nodes, links };
}

/** Emacs counts characters from 1, drops a BOM, and hides line endings it decoded consistently. */
function emacsPosition(text: string, doc: OrgDocument, offset: number): number {
  let position = 1;
  for (const char of text.slice(doc.bomLength, Math.max(offset, doc.bomLength))) {
    if (char !== '\r' || doc.eol !== 'crlf') position++;
  }
  return position;
}

/** Every difference between the oracle and the scanner, one line each. */
export function diff(oracle: Results, scanner: Results): string[] {
  const differences: string[] = [];
  for (const file of oracle.files) {
    if (!scanner.files.includes(file)) differences.push(`file-only-in-oracle ${file}`);
  }
  for (const file of scanner.files) {
    if (!oracle.files.includes(file)) differences.push(`file-only-in-scanner ${file}`);
  }
  differences.push(...diffNodes(oracle.nodes, scanner.nodes), ...diffLinks(oracle.links, scanner.links));
  return differences.sort();
}

function diffNodes(oracle: OracleNode[], scanner: OracleNode[]): string[] {
  const differences: string[] = [];
  const remaining = [...scanner];
  const take = (matches: (node: OracleNode) => boolean) => {
    const index = remaining.findIndex(matches);
    return index === -1 ? null : remaining.splice(index, 1)[0];
  };
  // Exact matches go first, so a file holding an ID twice pairs each node with its own heading.
  const unmatched = oracle.filter(
    (node) => !take((other) => sameNode(other, node)),
  );
  for (const node of unmatched) {
    const other = take((candidate) => candidate.file === node.file && candidate.id === node.id);
    if (!other) {
      differences.push(`node-only-in-oracle ${node.file} ${node.id} ${JSON.stringify(node.title)}`);
      continue;
    }
    for (const field of ['level', 'pos', 'title', 'tags'] as const) {
      const expected = JSON.stringify(node[field]);
      const actual = JSON.stringify(other[field]);
      if (expected !== actual) {
        differences.push(`node-${field} ${node.file} ${node.id} oracle=${expected} scanner=${actual}`);
      }
    }
  }
  for (const node of remaining) {
    differences.push(`node-only-in-scanner ${node.file} ${node.id} ${JSON.stringify(node.title)}`);
  }
  return differences;
}

function sameNode(a: OracleNode, b: OracleNode): boolean {
  return (
    a.id === b.id &&
    a.file === b.file &&
    a.level === b.level &&
    a.pos === b.pos &&
    a.title === b.title &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  );
}

/** Compared as counts per source and target: the database doesn't say which file a link is from. */
function diffLinks(oracle: OracleLink[], scanner: OracleLink[]): string[] {
  const count = (links: OracleLink[]) => {
    const counts = new Map<string, number>();
    for (const { source, dest } of links) {
      const key = `${source} -> ${dest}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const expected = count(oracle);
  const actual = count(scanner);
  const differences: string[] = [];
  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const inOracle = expected.get(key) ?? 0;
    const inScanner = actual.get(key) ?? 0;
    if (inOracle !== inScanner) differences.push(`link ${key} oracle=${inOracle} scanner=${inScanner}`);
  }
  return differences;
}

/** Sorts differences against the allowlist. Everything in the result must be empty to pass. */
export function compare(differences: string[], allowlist: AllowlistEntry[]): Comparison {
  const allowed = new Set(allowlist.map((entry) => entry.difference));
  const found = new Set(differences);
  return {
    unexpected: differences.filter((difference) => !allowed.has(difference)),
    stale: [...allowed].filter((difference) => !found.has(difference)),
    unjustified: allowlist
      .filter((entry) => entry.reason.trim() === '')
      .map((entry) => entry.difference),
  };
}
