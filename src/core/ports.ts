// Seams between the platform-free core and the outside world (design.md, Decision 6).
// Expected conditions are typed results; a rejected promise means a bug or a broken adapter.

/** Why a store operation could not complete. Maps to user-facing messages in save orchestration. */
export type FileStoreFailureKind =
  /** The path does not exist. */
  | 'not_found'
  /** Access to the folder or file was refused or revoked. */
  | 'access_denied'
  /** The file exists but its content is not on the device. */
  | 'not_downloaded'
  /** The provider could not be reached or failed. Trying again later may work. */
  | 'provider_error'
  /** The provider stored the file under a different name than requested. */
  | 'name_changed';

export interface FileStoreFailure {
  kind: FileStoreFailureKind;
  /** Diagnostic detail for logs. Not for display. */
  message: string;
}

export interface PathFailure {
  /** Library-relative path. The empty string is the library root. */
  path: string;
  failure: FileStoreFailure;
}

export interface FileEntry {
  /** Final path segment, exactly as the provider reports it. */
  name: string;
  /** Library-relative, `/`-separated, with no leading slash. Never normalized. */
  path: string;
  /** Size in bytes. 0 for directories. */
  size: number;
  /** Modification time in milliseconds since the Unix epoch. */
  mtime: number;
  isDir: boolean;
  /** False when the content is only at the cloud provider, such as an iCloud placeholder. */
  downloaded: boolean;
  /** False when the provider refuses writes to this entry. */
  writable: boolean;
}

/**
 * A walk of the library. `failures` lists each directory that could not be read, so a partial
 * listing is distinguishable from a complete one: entries under a failed directory are unknown,
 * not gone (Decision 5). A failure at path `''` means nothing could be listed.
 */
export interface ListResult {
  entries: FileEntry[];
  failures: PathFailure[];
}

export type ReadResult = { ok: true; bytes: Uint8Array } | { ok: false; failure: FileStoreFailure };

export type DigestResult = { ok: true; hash: string } | { ok: false; failure: FileStoreFailure };

export type CreateResult =
  /** `path` is the verified final path, identical to the one requested. */
  | { status: 'created'; path: string }
  /** Something already has that name. Nothing was written. */
  | { status: 'exists' }
  | { status: 'failed'; failure: FileStoreFailure };

export type ReplaceResult =
  /** The new bytes are in place and verified. `hash` is their digest. */
  | { status: 'replaced'; hash: string }
  /** The file no longer matches `expectedHash`, and it was left untouched. */
  | { status: 'stale'; currentHash: string }
  /** The file holds complete old or new content (Decision 4). */
  | { status: 'failed'; failure: FileStoreFailure };

export interface RequestDownloadResult {
  /** Paths whose download could not be requested. Absence does not mean the file has arrived. */
  failures: PathFailure[];
}

/**
 * The user's library, or any other source of files. Paths are library-relative as in `FileEntry`,
 * and hashes are lowercase hexadecimal SHA-256 of the file's bytes.
 */
export interface FileStore {
  /**
   * Walks the whole library. Hidden files and folders (leading `.`) are neither returned nor
   * descended into. Non-`.org` files are returned; choosing what to index is the caller's job.
   * Provider failures are reported in the result, never by rejecting.
   */
  list(): Promise<ListResult>;
  readBytes(path: string): Promise<ReadResult>;
  digest(path: string): Promise<DigestResult>;
  /**
   * Creates a new file. Never replaces an existing one, and verifies the final name. The parent
   * folder must already exist: a missing one is a `not_found` failure.
   */
  createExclusive(path: string, bytes: Uint8Array): Promise<CreateResult>;
  /**
   * Atomically replaces a file if its current hash is `expectedHash`, doing the check as close to
   * the write as the platform allows.
   */
  replaceFile(path: string, bytes: Uint8Array, expectedHash: string): Promise<ReplaceResult>;
  /** Asks the provider to bring files onto the device. Does not wait for them to arrive. */
  requestDownload(paths: string[]): Promise<RequestDownloadResult>;
}

export type SqlValue = string | number | null | Uint8Array;

export interface SqlRunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqlExecutor {
  /** Runs one or more statements with no parameters, such as schema DDL or a PRAGMA. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<SqlRunResult>;
  all<Row>(sql: string, params?: SqlValue[]): Promise<Row[]>;
  /** The first row, or null when there are none. */
  get<Row>(sql: string, params?: SqlValue[]): Promise<Row | null>;
}

export interface SqlDriver extends SqlExecutor {
  /**
   * Runs `work` in an exclusive transaction: commits when it resolves, rolls back and rejects when
   * it rejects. Statements inside must go through `tx`.
   */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface IdGenerator {
  /** A new lowercase UUID. */
  newId(): string;
}

export interface Clock {
  now(): Date;
}

/** A folder the user chose. */
export interface ExternalLibraryRoot {
  kind: 'external';
  /** Stable for the folder itself, so picking the same folder again gives the same id. */
  id: string;
  /** The folder's name, for display. */
  name: string;
  /** The saved platform reference: an iOS bookmark or an Android tree URI. Opaque to the core. */
  reference: string;
}

/** Where a library lives (Decision 3). */
export type LibraryRoot = { kind: 'app_owned' } | ExternalLibraryRoot;

export type RestoreResult =
  | { status: 'ok'; writable: boolean }
  /** Still usable, but the saved reference was out of date. `root` carries the refreshed one. */
  | { status: 'stale'; root: ExternalLibraryRoot; writable: boolean }
  /** The user or the system withdrew access. */
  | { status: 'revoked' }
  /** The folder was moved or deleted. */
  | { status: 'missing' };

export type PickFolderResult =
  | { status: 'picked'; root: ExternalLibraryRoot; writable: boolean }
  | { status: 'cancelled' }
  /** The provider doesn't allow folder access. */
  | { status: 'unsupported_provider' }
  /** The platform doesn't allow this location, such as Android's storage root or `Download`. */
  | { status: 'restricted_location' }
  /** The picker could not open or failed. Android issue #50386 needs an app restart to clear. */
  | { status: 'picker_failed'; message: string };

export type RecoverResult = { ok: true } | { ok: false; failure: FileStoreFailure };

/** Platform access to library roots, provided by the native module (Decision 10). */
export interface LibraryAccess {
  /** Shows the system folder picker. Takes the lasting grant, and writes nothing to the folder. */
  pickFolder(): Promise<PickFolderResult>;
  /**
   * Checks that a root can be reached and how, refreshing an out-of-date reference. The app-owned
   * folder is created here if it doesn't exist yet.
   */
  restore(root: LibraryRoot): Promise<RestoreResult>;
  /**
   * Finishes or undoes any interrupted save in this root (Decision 4). Data needed for an
   * unfinished recovery is kept when this fails, so it can run again.
   */
  recover(root: LibraryRoot): Promise<RecoverResult>;
  /** A store over a root that `restore` reported as usable. */
  openStore(root: LibraryRoot): FileStore;
}

export type RecordReadResult =
  /** `text` is null when nothing has been saved yet. */
  { ok: true; text: string | null } | { ok: false; failure: FileStoreFailure };

export type RecordWriteResult = { ok: true } | { ok: false; failure: FileStoreFailure };

/** Keeps the active library's record in internal storage: `active-library.json` in Decision 3. */
export interface LibraryRecordStore {
  read(): Promise<RecordReadResult>;
  write(text: string): Promise<RecordWriteResult>;
}
