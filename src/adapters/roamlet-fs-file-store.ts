import type { RoamletFsNativeModule } from '../../modules/roamlet-fs';
import type { FileStore, FileStoreFailure, LibraryAccess, LibraryRoot } from '../core/ports';

/** The module's calls that take a root. Passed in, because importing it throws where it's missing. */
export type RoamletFsRootApi = Omit<RoamletFsNativeModule, 'internalDirectory'>;

/** The module's expected conditions are typed results, so a rejection is a bug or a bridge error. */
export function failureOf(error: unknown): FileStoreFailure {
  return { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) };
}

/**
 * A `FileStore` over the module, for either kind of root. Results pass through as they are. A
 * rejection becomes a failure result, so a broken call looks like a provider failure to the core:
 * nothing is removed from the index, and a save keeps the user's text.
 */
export function openRoamletFsStore(fs: RoamletFsRootApi, root: LibraryRoot): FileStore {
  return {
    list: () =>
      fs.list(root).catch((error) => ({
        entries: [],
        failures: [{ path: '', failure: failureOf(error) }],
      })),
    readBytes: async (path) => {
      try {
        const result = await fs.readBytes(root, path);
        // UTF-8 validation and hashing downstream need real bytes, so anything else stops here.
        if (result.ok && !(result.bytes instanceof Uint8Array)) {
          return { ok: false, failure: failureOf(`readBytes of ${path} did not return a Uint8Array`) };
        }
        return result;
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    digest: (path) =>
      fs.digest(root, path).catch((error) => ({ ok: false, failure: failureOf(error) })),
    createExclusive: (path, bytes) =>
      fs
        .createExclusive(root, path, bytes)
        .catch((error) => ({ status: 'failed', failure: failureOf(error) })),
    replaceFile: (path, bytes, expectedHash) =>
      fs
        .replaceFile(root, path, bytes, expectedHash)
        .catch((error) => ({ status: 'failed', failure: failureOf(error) })),
    requestDownload: (paths) =>
      fs.requestDownload(root, paths).catch((error) => ({
        failures: paths.map((path) => ({ path, failure: failureOf(error) })),
      })),
  };
}

/** `LibraryAccess` over the module, with rejections mapped as in `openRoamletFsStore`. */
export function roamletFsAccess(fs: RoamletFsRootApi): LibraryAccess {
  return {
    // Android issue #50386 can reject a picker, and this result is what asks for a restart.
    pickFolder: () =>
      fs.pickFolder().catch((error) => ({
        status: 'picker_failed',
        message: failureOf(error).message,
      })),
    // The result has no failure case. Reporting `missing` shows the reconnect state and keeps the
    // index and drafts, as the iOS side does for an app-owned folder it can't create.
    restore: (root) =>
      fs.restore(root).catch((error) => {
        console.warn(`roamlet-fs restore rejected: ${failureOf(error).message}`);
        return { status: 'missing' };
      }),
    recover: (root) => fs.recover(root).catch((error) => ({ ok: false, failure: failureOf(error) })),
    openStore: (root) => openRoamletFsStore(fs, root),
  };
}
