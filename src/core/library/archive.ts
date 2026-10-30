import { zipSync, type Zippable } from 'fflate';

import type { FileStore, PathFailure } from '../ports';

import { isConflictCopyPath, isNotePath } from './paths';
import { describeFailure, type LibraryProblem } from './problems';

// Zip timestamps can't hold anything outside these years, and fflate throws on them.
const FIRST_ZIP_YEAR = 1980;
const LAST_ZIP_YEAR = 2099;

export type ArchiveResult =
  | {
      status: 'ok';
      /** A `.zip` of the files in `included`, at their library paths. */
      archive: Uint8Array;
      included: string[];
      /** Files left out, such as those not on the device. */
      omitted: PathFailure[];
      /** Folders that could not be listed. Their files are unknown, so none are in the archive. */
      unlistedFolders: PathFailure[];
    }
  | { status: 'failed'; problem: LibraryProblem };

function zipTime(mtime: number): Date {
  const date = new Date(mtime);
  const year = date.getFullYear();
  return year >= FIRST_ZIP_YEAR && year <= LAST_ZIP_YEAR ? date : new Date(FIRST_ZIP_YEAR, 0, 1);
}

/**
 * Archives the library's `.org` files and conflict copies (Export). Everything else in the folder
 * is left out, and internal data lives outside it. Only reads what is on the device, so it needs no
 * connection. Folders exist in the archive through their files.
 */
export async function buildArchive(store: FileStore): Promise<ArchiveResult> {
  const listing = await store.list();
  const rootFailure = listing.failures.find((failed) => failed.path === '');
  if (rootFailure) return { status: 'failed', problem: describeFailure(rootFailure.failure, 'export') };

  const files: Zippable = {};
  const included: string[] = [];
  const omitted: PathFailure[] = [];
  for (const entry of listing.entries) {
    if (entry.isDir || !(isNotePath(entry.path) || isConflictCopyPath(entry.path))) continue;
    if (!entry.downloaded) {
      const message = `${entry.path} is not on the device`;
      omitted.push({ path: entry.path, failure: { kind: 'not_downloaded', message } });
      continue;
    }
    const read = await store.readBytes(entry.path);
    if (!read.ok) {
      omitted.push({ path: entry.path, failure: read.failure });
      continue;
    }
    files[entry.path] = [read.bytes, { mtime: zipTime(entry.mtime) }];
    included.push(entry.path);
  }
  return {
    status: 'ok',
    archive: zipSync(files),
    included,
    omitted,
    unlistedFolders: listing.failures,
  };
}
