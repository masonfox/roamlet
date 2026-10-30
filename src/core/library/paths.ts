// Names in the library: what counts as a note, what counts as a conflict copy, and how names are
// compared. Paths are library-relative as in `FileEntry`, and are never rewritten here.

import type { FileEntry } from '../ports';

const CONFLICT_COPY_NAME = /\.org\.conflict-\d{14}(?:-\d+)?$/;
const SYNC_CONFLICT_NAME = /\.sync-conflict-\d{8}-\d{6}-[^/]*\.org$| \([^()]*conflicted copy[^()]*\)\.org$/i;

function isHidden(path: string): boolean {
  return path.split('/').some((part) => part.startsWith('.'));
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function joinPath(directory: string, name: string): string {
  return directory === '' ? name : `${directory}/${name}`;
}

/** Whether `path` is `ancestor` or something inside it. `''` is the library root. */
export function isSameOrInside(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Files ending in `.org`, outside hidden folders. Everything else is ignored (In-place files). */
export function isNotePath(path: string): boolean {
  return path.endsWith('.org') && !isHidden(path);
}

/** A copy made by `saveConflictCopy`. Its name doesn't end in `.org`, so it is never a note. */
export function isConflictCopyPath(path: string): boolean {
  return !isHidden(path) && CONFLICT_COPY_NAME.test(baseName(path));
}

/**
 * A `.org` copy a sync tool made of a conflicting note, going by Syncthing's and Dropbox's naming.
 * Unlike a `saveConflictCopy` file, it is a note, and it carries the original's IDs.
 */
export function isSyncConflictNotePath(path: string): boolean {
  return SYNC_CONFLICT_NAME.test(baseName(path));
}

/** The conflict copies in a listing, for diagnostics. */
export function conflictCopies(entries: FileEntry[]): FileEntry[] {
  return entries.filter((entry) => !entry.isDir && isConflictCopyPath(entry.path));
}

/**
 * The form in which names clash on a filesystem that ignores case or normalization. Going through
 * upper case folds characters like `ß` and final sigma, which lower case alone keeps.
 */
export function foldName(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}
