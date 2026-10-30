// The on-device run of the FileStore contract (task 5.4), started from app/spike.tsx. Task 1.12
// deletes this file with that screen, and it is not reachable from anywhere else in the app.

import {
  runFileStoreContract,
  type FileStoreContractHarness,
  type FileStoreContractResult,
} from '../../test/support/file-store-contract';
import type { FileStore, LibraryRoot } from '../core/ports';
import { openRoamletFsStore, type RoamletFsRootApi } from './roamlet-fs-file-store';

const SCRATCH_PREFIX = 'roamlet-contract-';
const APP_OWNED_FOLDER = 'org-roam';

/** Makes and removes folders in a root, which the module has no calls for. */
export interface ScratchFolders {
  /** Makes one empty folder. Its parent already exists. */
  make(path: string): Promise<void>;
  /** Removes a folder made here, with everything in it. */
  remove(path: string): Promise<void>;
}

/**
 * The part of a store under one top-level folder, looking like a library of its own. It has to be
 * a visible folder, because `list` doesn't descend into hidden ones.
 */
export function scopedFileStore(inner: FileStore, folder: string): FileStore {
  const prefix = `${folder}/`;
  const inside = (path: string) => `${prefix}${path}`;
  const outside = (path: string) => path.slice(prefix.length);
  return {
    list: async () => {
      const { entries, failures } = await inner.list();
      return {
        entries: entries
          .filter((entry) => entry.path.startsWith(prefix))
          .map((entry) => ({ ...entry, path: outside(entry.path) })),
        failures: failures.flatMap((failure) => {
          if (failure.path === '' || failure.path === folder) return [{ ...failure, path: '' }];
          return failure.path.startsWith(prefix)
            ? [{ ...failure, path: outside(failure.path) }]
            : [];
        }),
      };
    },
    readBytes: (path) => inner.readBytes(inside(path)),
    digest: (path) => inner.digest(inside(path)),
    createExclusive: async (path, bytes) => {
      const result = await inner.createExclusive(inside(path), bytes);
      return result.status === 'created' ? { ...result, path: outside(result.path) } : result;
    },
    replaceFile: (path, bytes, expectedHash) => inner.replaceFile(inside(path), bytes, expectedHash),
    requestDownload: async (paths) => {
      const { failures } = await inner.requestDownload(paths.map(inside));
      return { failures: failures.map((failure) => ({ ...failure, path: outside(failure.path) })) };
    },
  };
}

/**
 * Gives each case its own scratch folder in `store`, seeded through `createExclusive`. Everything
 * else in the store is left alone.
 */
export function scratchContractHarness(
  store: FileStore,
  folders: ScratchFolders,
  runId: string,
): FileStoreContractHarness {
  let cases = 0;
  return {
    async open(files) {
      cases += 1;
      const scratch = `${SCRATCH_PREFIX}${runId}-${cases}`;
      await folders.make(scratch);
      const scoped = scopedFileStore(store, scratch);
      const dispose = () => folders.remove(scratch);
      try {
        const made = new Set<string>();
        for (const [path, bytes] of Object.entries(files)) {
          const segments = path.split('/').slice(0, -1);
          for (let depth = 1; depth <= segments.length; depth += 1) {
            const folder = segments.slice(0, depth).join('/');
            if (made.has(folder)) continue;
            await folders.make(`${scratch}/${folder}`);
            made.add(folder);
          }
          const seeded = await scoped.createExclusive(path, bytes);
          if (seeded.status !== 'created') {
            throw new Error(`seeding ${path}: ${JSON.stringify(seeded)}`);
          }
        }
      } catch (error) {
        await dispose();
        throw error;
      }
      return { store: scoped, dispose };
    },
  };
}

/** Scratch folders through `expo-file-system`, which also handles Android tree URIs. */
async function expoScratchFolders(root: LibraryRoot): Promise<ScratchFolders> {
  const { Directory, Paths } = await import('expo-file-system');
  const base =
    root.kind === 'external'
      ? new Directory(root.reference)
      : new Directory(Paths.document, APP_OWNED_FOLDER);

  // A run that died leaves its folder behind. Tree URIs don't give reliable names, so this is only
  // for the app-owned folder. An external run refuses a folder with anything in it.
  if (root.kind === 'app_owned') {
    for (const item of base.list()) {
      if (item instanceof Directory && item.name.startsWith(SCRATCH_PREFIX)) item.delete();
    }
  }

  // Android children can't be addressed by joining names to the parent's URI.
  const known = new Map([['', base]]);
  return {
    make: async (path) => {
      const slash = path.lastIndexOf('/');
      const parent = known.get(slash === -1 ? '' : path.slice(0, slash));
      if (!parent) throw new Error(`no parent folder known for ${path}`);
      known.set(path, parent.createDirectory(path.slice(slash + 1)));
    },
    remove: async (path) => {
      known.get(path)?.delete();
      for (const key of [...known.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) known.delete(key);
      }
    },
  };
}

/**
 * Runs every contract case against `root` on this device. On the app-owned folder, scratch folders
 * sit beside any notes there. An external folder must be empty, and works on Android only: iOS holds
 * the folder as a bookmark inside the module, and the module can't make or remove folders.
 */
export async function runContractOnDevice(
  fs: RoamletFsRootApi,
  root: LibraryRoot,
  platform: string,
): Promise<FileStoreContractResult[]> {
  if (root.kind === 'external' && platform !== 'android') {
    throw new Error('external folders can only be scratch folders on Android');
  }
  const restored = await fs.restore(root);
  if (restored.status !== 'ok' && restored.status !== 'stale') {
    throw new Error(`the folder is ${restored.status}`);
  }
  const target = restored.status === 'stale' ? restored.root : root;
  const store = openRoamletFsStore(fs, target);
  if (target.kind === 'external') {
    const { entries, failures } = await store.list();
    if (entries.length > 0 || failures.length > 0) {
      throw new Error('pick an empty folder, which the contract can fill and clean up');
    }
  }
  const folders = await expoScratchFolders(target);
  return runFileStoreContract(scratchContractHarness(store, folders, String(Date.now())));
}
