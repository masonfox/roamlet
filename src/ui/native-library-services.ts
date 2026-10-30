import { failureOf, roamletFsAccess } from '../adapters/roamlet-fs-file-store';
import type { LibraryRecordStore } from '../core/ports';
import type { LibraryServices } from './library-controller';

const RECORD_FILE_NAME = 'active-library.json';

/**
 * The real services. Native modules load only when this runs, because merely importing `roamlet-fs`
 * throws wherever its native side is missing, such as in Jest.
 */
export async function loadNativeLibraryServices(): Promise<LibraryServices> {
  const [{ RoamletFs }, { File, Paths }, { randomUUID }, { ExpoSqlDatabaseHost }] =
    await Promise.all([
      import('../../modules/roamlet-fs'),
      import('expo-file-system'),
      import('expo-crypto'),
      import('../adapters/expo-sql-driver'),
    ]);

  // Decision 3. The path has spaces on iOS (`Application Support`), so it needs encoding as a URI.
  const recordFile = new File(
    `file://${encodeURI(RoamletFs.internalDirectory())}`,
    RECORD_FILE_NAME,
  );
  const records: LibraryRecordStore = {
    read: async () => {
      try {
        return { ok: true, text: recordFile.exists ? await recordFile.text() : null };
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    write: async (text) => {
      try {
        recordFile.write(text);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
  };

  return {
    access: roamletFsAccess(RoamletFs),
    records,
    databases: new ExpoSqlDatabaseHost(Paths.cache.uri),
    ids: { newId: () => randomUUID().toLowerCase() },
    clock: { now: () => new Date() },
  };
}
