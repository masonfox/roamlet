import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { buildArchive } from '../../core/library';
import type { FileStore, PathFailure } from '../../core/ports';

const ARCHIVE_NAME = 'roamlet-export.zip';

const NOT_SHARED_MESSAGE =
  'The library couldn’t be exported. The share sheet didn’t open, or the device may be full. Try again.';

export type ExportOutcome =
  | {
      status: 'shared';
      included: number;
      omitted: PathFailure[];
      unlistedFolders: PathFailure[];
    }
  /** Nothing could go in the archive, so no share sheet was opened. */
  | { status: 'nothing_to_export'; omitted: PathFailure[]; unlistedFolders: PathFailure[] }
  | { status: 'failed'; message: string; accessMayBeLost: boolean };

/**
 * Builds the archive and offers it through the share sheet. The file stays in the cache until the
 * next export replaces it, because an app receiving it may still be reading after the sheet closes.
 */
export async function exportLibrary(store: FileStore): Promise<ExportOutcome> {
  const result = await buildArchive(store);
  if (result.status === 'failed') {
    return {
      status: 'failed',
      message: result.problem.message,
      accessMayBeLost: result.problem.accessMayBeLost,
    };
  }
  const { archive, included, omitted, unlistedFolders } = result;
  if (included.length === 0) return { status: 'nothing_to_export', omitted, unlistedFolders };

  try {
    const file = new File(Paths.cache, ARCHIVE_NAME);
    if (file.exists) file.delete();
    file.write(archive);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/zip',
      UTI: 'public.zip-archive',
      dialogTitle: 'Export library',
    });
  } catch {
    return { status: 'failed', message: NOT_SHARED_MESSAGE, accessMayBeLost: false };
  }
  return { status: 'shared', included: included.length, omitted, unlistedFolders };
}
