// The native API of roamlet-fs (design.md, Decision 10, plus recovery), implemented once in Swift
// and once in Kotlin. The result shapes are the core's ports, so the FileStore adapter (task 5.4)
// passes them through. Both platforms must return exactly these shapes.
//
// Rules for both native sides:
// - `root` is passed with every call, as a plain object: `{ kind: 'app_owned' }`, or
//   `{ kind: 'external', id, name, reference }`. `app_owned` is `<documents>/org-roam`.
// - `path` is library-relative and `/`-separated, with no leading slash, and is never normalized.
//   The empty string is the library root.
// - Bytes cross the bridge as `Uint8Array`, also when nested in a result.
// - Hashes are lowercase hexadecimal SHA-256.
// - Expected conditions are typed results. A rejected promise means a bug in the module.
// - A `failure.kind` is one of `FileStoreFailureKind`, and `failure.message` is for logs only.
// - `list` skips hidden entries (leading `.`) and doesn't descend into them. Its entries are
//   sorted by nothing in particular. A directory that can't be read goes in `failures` with its
//   library-relative path, and the walk carries on.
// - `root.id` is stable for the folder: picking the same folder again gives the same id. It is used
//   as `<libraryId>` in `<internalDirectory>/libraries/<libraryId>/`, so it must be safe as a
//   single path segment. The app-owned library's id is `app-owned` (`APP_OWNED_LIBRARY_ID`).
// - `createExclusive` and `replaceFile` temp names, such as `.roamlet-<id>.tmp`, are hidden and not
//   `.org`, so `list` never reports them and Org-roam ignores them.

import type {
  CreateResult,
  DigestResult,
  LibraryRoot,
  ListResult,
  PickFolderResult,
  ReadResult,
  RecoverResult,
  ReplaceResult,
  RequestDownloadResult,
  RestoreResult,
} from '../../../src/core/ports';

export type {
  CreateResult,
  DigestResult,
  ExternalLibraryRoot,
  FileEntry,
  FileStoreFailure,
  FileStoreFailureKind,
  LibraryRoot,
  ListResult,
  PathFailure,
  PickFolderResult,
  ReadResult,
  RecoverResult,
  ReplaceResult,
  RequestDownloadResult,
  RestoreResult,
} from '../../../src/core/ports';

export interface RoamletFsNativeModule {
  /**
   * Shows the system folder picker and takes the lasting grant: a saved bookmark on iOS, a persisted
   * read and write grant on Android. Writes nothing to the folder.
   */
  pickFolder(): Promise<PickFolderResult>;

  /**
   * Checks that a root can be reached and how, refreshing an out-of-date reference. Creates the
   * app-owned folder if it doesn't exist yet. On iOS this also holds the long-lived security scope.
   */
  restore(root: LibraryRoot): Promise<RestoreResult>;

  /**
   * Finishes or undoes any interrupted save in this root (Decision 4), then removes temp files,
   * `.old` files, and journals. Runs before the library is used. When the folder can't be reached it
   * returns a failure and keeps the data needed to run again. iOS has no journal, so it has little
   * to do there, but it still reports `{ ok: true }`.
   */
  recover(root: LibraryRoot): Promise<RecoverResult>;

  /** Walks the whole library. Android uses one child-documents query per directory. */
  list(root: LibraryRoot): Promise<ListResult>;

  readBytes(root: LibraryRoot, path: string): Promise<ReadResult>;

  /** SHA-256 of the file's content. */
  digest(root: LibraryRoot, path: string): Promise<DigestResult>;

  /**
   * Creates a new file, never replacing an existing one, and verifies the final name. The parent
   * folder must already exist: a missing one is a `not_found` failure.
   */
  createExclusive(root: LibraryRoot, path: string, bytes: Uint8Array): Promise<CreateResult>;

  /** Replaces a file if its current hash is `expectedHash`, following Decision 4. */
  replaceFile(
    root: LibraryRoot,
    path: string,
    bytes: Uint8Array,
    expectedHash: string
  ): Promise<ReplaceResult>;

  /**
   * Asks the provider to bring files onto the device, without waiting for them. iOS calls
   * `startDownloadingUbiquitousItem`; Android reads the file, which triggers the provider's fetch.
   */
  requestDownload(root: LibraryRoot, paths: string[]): Promise<RequestDownloadResult>;

  /**
   * Absolute path of internal storage, hidden from the user: iOS Application Support, Android app
   * files. Created if missing. Synchronous, because it never does provider work.
   */
  internalDirectory(): string;
}
