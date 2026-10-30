import { isConflictCopyPath } from '../library/paths';

const CONFLICT_SUFFIX = '.conflict-';

/** The path of the note a conflict copy was saved from, or null if `path` is not a conflict copy. */
export function conflictCopyNotePath(path: string): string | null {
  return isConflictCopyPath(path) ? path.slice(0, path.lastIndexOf(CONFLICT_SUFFIX)) : null;
}
