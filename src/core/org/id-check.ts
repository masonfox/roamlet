import type { OrgDocument, OrgNode } from './types';

/** Something the user should confirm before saving. The app never repairs IDs itself. */
export type IdWarning =
  /** The ID is gone from the file, so links to it stop resolving. */
  | { kind: 'removed'; id: string; level: number; title: string }
  /** The same node now has another ID, so links to the old one stop resolving. */
  | { kind: 'changed'; id: string; newId: string; level: number; title: string }
  /** The edit introduced an ID that this file or another one already uses. */
  | { kind: 'duplicated'; id: string; level: number; title: string };

/**
 * Compares the nodes of a file before and after an edit (Decision 2). `idsInOtherFiles` holds the
 * IDs the rest of the library uses, without this file's own. Duplicates that were already there
 * are not the edit's doing, so they do not warn on every save.
 */
export function checkIdChanges(
  before: OrgDocument,
  after: OrgDocument,
  idsInOtherFiles: ReadonlySet<string> = new Set(),
): IdWarning[] {
  const beforeCounts = countIds(before.nodes);
  const afterCounts = countIds(after.nodes);
  const added = after.nodes.filter((node) => !beforeCounts.has(node.id));
  const warnings: IdWarning[] = [];

  for (const node of before.nodes) {
    if (afterCounts.has(node.id)) continue;
    const { id, level, title } = node;
    const successor = added.findIndex((candidate) => isSameNode(node, candidate));
    if (successor === -1) {
      warnings.push({ kind: 'removed', id, level, title });
    } else {
      warnings.push({ kind: 'changed', id, newId: added[successor].id, level, title });
      added.splice(successor, 1);
    }
  }

  const reported = new Set<string>();
  for (const { id, level, title } of after.nodes) {
    if (reported.has(id)) continue;
    const count = afterCounts.get(id)!;
    const countBefore = beforeCounts.get(id) ?? 0;
    if ((count > 1 && count > countBefore) || (countBefore === 0 && idsInOtherFiles.has(id))) {
      reported.add(id);
      warnings.push({ kind: 'duplicated', id, level, title });
    }
  }
  return warnings;
}

function countIds(nodes: OrgNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { id } of nodes) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** A file has one file-level node, whatever its title. Headings match by level and title. */
function isSameNode(a: OrgNode, b: OrgNode): boolean {
  return a.level === b.level && (a.level === 0 || a.title === b.title);
}
