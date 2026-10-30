import { createHash } from 'node:crypto';

import type {
  CreateResult,
  DigestResult,
  FileEntry,
  FileStore,
  FileStoreFailure,
  FileStoreFailureKind,
  ListResult,
  ReadResult,
  ReplaceResult,
  RequestDownloadResult,
} from '../../src/core/ports';

export const FILE_STORE_OPERATIONS = [
  'list',
  'readBytes',
  'digest',
  'createExclusive',
  'replaceFile',
  'requestDownload',
] as const;

export type FileStoreOperation = (typeof FILE_STORE_OPERATIONS)[number];

export interface FailOperationOptions {
  /**
   * Only this exact path fails. For `list` it is the folder whose read fails, and the default `''`
   * fails the whole listing. For other operations the default fails every path.
   */
  path?: string;
  /** Defaults to `provider_error`. */
  kind?: FileStoreFailureKind;
  /** How many matching calls fail. Defaults to every call until `clearFaults`. */
  times?: number;
  /** `replaceFile` only: the new bytes land and the failure is reported anyway (Decision 4). */
  afterWrite?: boolean;
}

export interface WriteFileOptions {
  /** Defaults to a new, later time from the store's own clock. */
  mtime?: number;
  /** Defaults to true. */
  downloaded?: boolean;
}

export interface StoreCall {
  op: FileStoreOperation;
  /** Absent for `list`. `requestDownload` logs one call per path. */
  path?: string;
}

type FileContent = string | Uint8Array;

interface StoredFile {
  bytes: Uint8Array;
  mtime: number;
  downloaded: boolean;
}

interface Fault {
  op: FileStoreOperation;
  path: string | undefined;
  failure: FileStoreFailure;
  remaining: number;
  afterWrite: boolean;
}

interface NameAlteration {
  alter: (name: string) => string;
  leaveBehind: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBytes(content: FileContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function isSameOrInside(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** A malformed path is a caller bug, so it rejects rather than producing a typed failure. */
function assertFilePath(path: string): void {
  const valid = path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
  if (!valid) throw new Error(`Malformed library path: ${JSON.stringify(path)}`);
}

function failure(kind: FileStoreFailureKind, message: string): FileStoreFailure {
  return { kind, message };
}

/**
 * A `FileStore` held in memory for Node tests (Decision 6). Everything outside the `FileStore`
 * methods is a test hook: hooks change the store as the outside world would, are not logged in
 * `calls`, and throw on misuse. Paths are compared exactly, so `Note.org` and `note.org`, or NFC
 * and NFD spellings of a name, are different files.
 */
export class MemoryFileStore implements FileStore {
  /** Every `FileStore` call so far, in order. Assign `[]` to start counting afresh. */
  calls: StoreCall[] = [];

  private readonly files = new Map<string, StoredFile>();
  private readonly dirs = new Map<string, number>();
  private readonly readOnly = new Set<string>();
  private faults: Fault[] = [];
  private pendingChanges = new Map<string, Uint8Array>();
  private nameAlteration: NameAlteration | null = null;
  private clock = Date.UTC(2026, 0, 1);

  constructor(files: Record<string, FileContent> = {}) {
    for (const [path, content] of Object.entries(files)) this.writeFile(path, content);
  }

  async list(): Promise<ListResult> {
    this.calls.push({ op: 'list' });
    const result: ListResult = { entries: [], failures: [] };
    this.walk('', result);
    return result;
  }

  async readBytes(path: string): Promise<ReadResult> {
    assertFilePath(path);
    this.calls.push({ op: 'readBytes', path });
    const content = this.availableContent('readBytes', path);
    if ('failure' in content) return { ok: false, failure: content.failure };
    return { ok: true, bytes: content.bytes.slice() };
  }

  async digest(path: string): Promise<DigestResult> {
    assertFilePath(path);
    this.calls.push({ op: 'digest', path });
    const content = this.availableContent('digest', path);
    if ('failure' in content) return { ok: false, failure: content.failure };
    return { ok: true, hash: sha256Hex(content.bytes) };
  }

  async createExclusive(path: string, bytes: Uint8Array): Promise<CreateResult> {
    assertFilePath(path);
    this.calls.push({ op: 'createExclusive', path });
    const parent = parentOf(path);

    const fault = this.takeFault('createExclusive', path);
    if (fault) return { status: 'failed', failure: fault.failure };
    if (!this.isWritable(parent)) {
      return { status: 'failed', failure: failure('access_denied', `${parent} is read-only`) };
    }
    if (!this.isDir(parent)) {
      return { status: 'failed', failure: failure('not_found', `No folder at ${parent}`) };
    }
    if (this.exists(path)) return { status: 'exists' };

    if (this.nameAlteration) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const altered = joinPath(parent, this.nameAlteration.alter(name));
      if (altered !== path) {
        if (this.nameAlteration.leaveBehind && !this.exists(altered)) this.writeFile(altered, bytes);
        return {
          status: 'failed',
          failure: failure('name_changed', `Provider stored ${path} as ${altered}`),
        };
      }
    }

    this.writeFile(path, bytes);
    return { status: 'created', path };
  }

  async replaceFile(path: string, bytes: Uint8Array, expectedHash: string): Promise<ReplaceResult> {
    assertFilePath(path);
    this.calls.push({ op: 'replaceFile', path });

    const pending = this.pendingChanges.get(path);
    if (pending) {
      this.pendingChanges.delete(path);
      this.writeFile(path, pending);
    }

    const fault = this.takeFault('replaceFile', path);
    if (fault && !fault.afterWrite) return { status: 'failed', failure: fault.failure };
    if (!this.isWritable(path)) {
      return { status: 'failed', failure: failure('access_denied', `${path} is read-only`) };
    }
    const file = this.files.get(path);
    if (!file) return { status: 'failed', failure: failure('not_found', `No file at ${path}`) };
    if (!file.downloaded) {
      return { status: 'failed', failure: failure('not_downloaded', `${path} is not on the device`) };
    }
    const currentHash = sha256Hex(file.bytes);
    if (currentHash !== expectedHash) return { status: 'stale', currentHash };

    this.writeFile(path, bytes);
    if (fault) return { status: 'failed', failure: fault.failure };
    return { status: 'replaced', hash: sha256Hex(bytes) };
  }

  async requestDownload(paths: string[]): Promise<RequestDownloadResult> {
    const result: RequestDownloadResult = { failures: [] };
    for (const path of paths) {
      assertFilePath(path);
      this.calls.push({ op: 'requestDownload', path });
      const fault = this.takeFault('requestDownload', path);
      if (fault) result.failures.push({ path, failure: fault.failure });
      else if (!this.files.has(path)) {
        result.failures.push({ path, failure: failure('not_found', `No file at ${path}`) });
      }
    }
    return result;
  }

  /** Adds or overwrites a file as an outside tool would, creating missing parent folders. */
  writeFile(path: string, content: FileContent, options: WriteFileOptions = {}): void {
    assertFilePath(path);
    if (this.dirs.has(path)) throw new Error(`${path} is a folder`);
    this.mkdir(parentOf(path));
    this.files.set(path, {
      bytes: toBytes(content),
      mtime: options.mtime ?? this.tick(),
      downloaded: options.downloaded ?? true,
    });
  }

  /** Adds a folder and any missing parents. Folders otherwise appear only through their files. */
  mkdir(path: string): void {
    if (path === '') return;
    assertFilePath(path);
    if (this.files.has(path)) throw new Error(`${path} is a file`);
    if (this.dirs.has(path)) return;
    this.mkdir(parentOf(path));
    this.dirs.set(path, this.tick());
  }

  /** Changes a file's modification time and leaves its bytes alone, as `touch` or a sync tool can. */
  setMtime(path: string, mtime: number): void {
    this.requireFile(path).mtime = mtime;
  }

  /** Removes a file, or a folder with everything in it. */
  remove(path: string): void {
    assertFilePath(path);
    if (!this.exists(path)) throw new Error(`Nothing at ${path}`);
    for (const key of [...this.files.keys()]) if (isSameOrInside(key, path)) this.files.delete(key);
    for (const key of [...this.dirs.keys()]) if (isSameOrInside(key, path)) this.dirs.delete(key);
  }

  /** Moves a file to a free path, keeping its bytes and modification time. */
  rename(from: string, to: string): void {
    const file = this.requireFile(from);
    assertFilePath(to);
    if (this.exists(to)) throw new Error(`${to} already exists`);
    this.mkdir(parentOf(to));
    this.files.delete(from);
    this.files.set(to, file);
  }

  /** Marks a file as on the device or cloud-only. Its bytes are kept either way. */
  setDownloaded(path: string, downloaded: boolean): void {
    this.requireFile(path).downloaded = downloaded;
  }

  /** Refuses writes to a file or folder, including everything in it. `''` is the library root. */
  setReadOnly(path = '', readOnly = true): void {
    if (readOnly) this.readOnly.add(path);
    else this.readOnly.delete(path);
  }

  /** Makes a `FileStore` operation fail. See `FailOperationOptions` for the default scope. */
  failOperation(op: FileStoreOperation, options: FailOperationOptions = {}): void {
    const kind = options.kind ?? 'provider_error';
    const path = options.path ?? (op === 'list' ? '' : undefined);
    this.faults.push({
      op,
      path,
      failure: failure(kind, `Injected ${kind} on ${op} of ${path ?? 'any path'}`),
      remaining: options.times ?? Infinity,
      afterWrite: options.afterWrite ?? false,
    });
  }

  /** Makes the next `replaceFile` of `path` find the file already changed to `content`. */
  changeBeforeNextReplace(path: string, content: FileContent): void {
    this.requireFile(path);
    this.pendingChanges.set(path, toBytes(content));
  }

  /**
   * Makes the provider store new files under `alter(name)`. `createExclusive` then reports
   * `name_changed`. The altered file is gone by default, as after the adapter's cleanup, and
   * `leaveBehind` keeps it, as when that cleanup also fails.
   */
  alterCreatedNames(alter: (name: string) => string, options: { leaveBehind?: boolean } = {}): void {
    this.nameAlteration = { alter, leaveBehind: options.leaveBehind ?? false };
  }

  /** Ends every injected failure, stale change, and name alteration. */
  clearFaults(): void {
    this.faults = [];
    this.pendingChanges.clear();
    this.nameAlteration = null;
  }

  /** The file's bytes whatever its state, or undefined if there is none. */
  peek(path: string): Uint8Array | undefined {
    return this.files.get(path)?.bytes.slice();
  }

  /** The file's content decoded as UTF-8, or undefined if there is none. */
  peekText(path: string): string | undefined {
    const bytes = this.files.get(path)?.bytes;
    return bytes && new TextDecoder().decode(bytes);
  }

  /** Every file path, including hidden ones that `list` leaves out, sorted. */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  private walk(dir: string, result: ListResult): void {
    const fault = this.takeFault('list', dir);
    if (fault) {
      result.failures.push({ path: dir, failure: fault.failure });
      return;
    }
    for (const name of this.childNames(dir)) {
      if (name.startsWith('.')) continue;
      const path = joinPath(dir, name);
      result.entries.push(this.entryFor(path, name));
      if (this.dirs.has(path)) this.walk(path, result);
    }
  }

  private childNames(dir: string): string[] {
    const prefix = dir === '' ? '' : `${dir}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs.keys()]) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        names.add(path.slice(prefix.length));
      }
    }
    return [...names].sort();
  }

  private entryFor(path: string, name: string): FileEntry {
    const file = this.files.get(path);
    return {
      name,
      path,
      size: file ? file.bytes.length : 0,
      mtime: file ? file.mtime : (this.dirs.get(path) as number),
      isDir: !file,
      downloaded: file ? file.downloaded : true,
      writable: this.isWritable(path),
    };
  }

  private availableContent(
    op: 'readBytes' | 'digest',
    path: string,
  ): { bytes: Uint8Array } | { failure: FileStoreFailure } {
    const fault = this.takeFault(op, path);
    if (fault) return { failure: fault.failure };
    const file = this.files.get(path);
    if (!file) return { failure: failure('not_found', `No file at ${path}`) };
    if (!file.downloaded) return { failure: failure('not_downloaded', `${path} is not on the device`) };
    return { bytes: file.bytes };
  }

  private takeFault(op: FileStoreOperation, path: string): Fault | undefined {
    const fault = this.faults.find(
      (candidate) =>
        candidate.op === op &&
        candidate.remaining > 0 &&
        (candidate.path === undefined || candidate.path === path),
    );
    if (fault) fault.remaining -= 1;
    return fault;
  }

  private requireFile(path: string): StoredFile {
    const file = this.files.get(path);
    if (!file) throw new Error(`No file at ${path}`);
    return file;
  }

  private exists(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path);
  }

  private isDir(path: string): boolean {
    return path === '' || this.dirs.has(path);
  }

  private isWritable(path: string): boolean {
    return ![...this.readOnly].some((blocked) => isSameOrInside(path, blocked));
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }
}
