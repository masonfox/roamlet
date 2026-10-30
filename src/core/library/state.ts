// The active library (Decision 3): exactly one at a time, of two kinds, restored at launch. Losing
// access changes the state and nothing else, so files are never treated as deleted, and drafts,
// which live outside the library, are never involved.

import type {
  CreateResult,
  DigestResult,
  ExternalLibraryRoot,
  FileStore,
  FileStoreFailure,
  LibraryAccess,
  LibraryRecordStore,
  LibraryRoot,
  ListResult,
  ReadResult,
  ReplaceResult,
  RequestDownloadResult,
  RestoreResult,
} from '../ports';

export const APP_OWNED_LIBRARY_ID = 'app-owned';

const RECORD_VERSION = 1;

/** Shown when choosing a folder on Android, where the picker refuses some locations outright. */
export const ANDROID_FOLDER_GUIDANCE =
  'Android doesn’t allow the storage root or the Download folder. Choose a subfolder instead.';

const READ_ONLY_MESSAGE =
  'This location can’t be written to. You can browse and read notes, but editing and capture are unavailable.';

const RECORD_LOST_NOTICE =
  'Roamlet couldn’t tell which folder you last used, so it opened its own folder. Your folder wasn’t changed, and you can open it again.';

export type UnavailableReason = 'revoked' | 'missing' | 'recovery_pending';

const UNAVAILABLE_MESSAGE: Record<UnavailableReason, string> = {
  revoked:
    'Roamlet no longer has access to this folder. Your files haven’t been deleted. Choose the folder again to reconnect.',
  missing:
    'This folder can’t be found. It may have been moved or deleted. Choose the folder again to reconnect.',
  recovery_pending:
    'Roamlet needs to finish an interrupted save in this folder but can’t reach it right now. It will finish when the folder is back.',
};

export type LibraryState =
  | { status: 'starting' }
  | {
      status: 'available';
      root: LibraryRoot;
      libraryId: string;
      /** Use this for every library operation. It stops working once this library is left. */
      store: FileStore;
      writable: boolean;
      /** Why editing and capture are unavailable, or null when the library can be written. */
      readOnlyMessage: string | null;
      /** True on first launch, until a folder is chosen. */
      offerFolderChoice: boolean;
      /** Something to tell the user once, or null. */
      notice: string | null;
    }
  | {
      status: 'unavailable';
      root: LibraryRoot;
      libraryId: string;
      reason: UnavailableReason;
      message: string;
    };

export type ChooseFolderResult =
  /** The folder is active. `reconnected` means it is the same folder that was active before. */
  | { status: 'activated'; reconnected: boolean }
  | { status: 'cancelled' }
  /** The current library is unaffected, and `message` explains why. */
  | { status: 'refused'; message: string };

export function libraryIdOf(root: LibraryRoot): string {
  return root.kind === 'app_owned' ? APP_OWNED_LIBRARY_ID : root.id;
}

/** Why capture and editing can't write right now, or null if they can. Their text stays a draft. */
export function whyNotWritable(state: LibraryState): string | null {
  if (state.status === 'available') return state.readOnlyMessage;
  if (state.status === 'unavailable') return state.message;
  return 'The library is still opening.';
}

function encodeRecord(root: LibraryRoot): string {
  return JSON.stringify({ version: RECORD_VERSION, root });
}

/** Null when the record isn't one this version can use. */
function decodeRecord(text: string): LibraryRoot | null {
  let record: { version?: unknown; root?: Partial<ExternalLibraryRoot> | { kind: 'app_owned' } | null } | null;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (record?.version !== RECORD_VERSION || !record.root) return null;
  const { root } = record;
  if (root.kind === 'app_owned') return { kind: 'app_owned' };
  if (
    root.kind === 'external' &&
    typeof root.id === 'string' &&
    typeof root.name === 'string' &&
    typeof root.reference === 'string'
  ) {
    return { kind: 'external', id: root.id, name: root.name, reference: root.reference };
  }
  return null;
}

/** Passes calls to a library's store until that library is left, and refuses writes if read-only. */
class GuardedFileStore implements FileStore {
  private closed = false;

  constructor(
    private readonly inner: FileStore,
    private readonly writable: boolean,
  ) {}

  close(): void {
    this.closed = true;
  }

  private refusal(path: string): FileStoreFailure {
    const why = this.closed ? 'is no longer the active library' : 'is read-only';
    return { kind: 'access_denied', message: `${path || 'The library'} ${why}` };
  }

  async list(): Promise<ListResult> {
    if (!this.closed) return this.inner.list();
    return { entries: [], failures: [{ path: '', failure: this.refusal('') }] };
  }

  async readBytes(path: string): Promise<ReadResult> {
    if (!this.closed) return this.inner.readBytes(path);
    return { ok: false, failure: this.refusal(path) };
  }

  async digest(path: string): Promise<DigestResult> {
    if (!this.closed) return this.inner.digest(path);
    return { ok: false, failure: this.refusal(path) };
  }

  async createExclusive(path: string, bytes: Uint8Array): Promise<CreateResult> {
    if (!this.closed && this.writable) return this.inner.createExclusive(path, bytes);
    return { status: 'failed', failure: this.refusal(path) };
  }

  async replaceFile(path: string, bytes: Uint8Array, expectedHash: string): Promise<ReplaceResult> {
    if (!this.closed && this.writable) return this.inner.replaceFile(path, bytes, expectedHash);
    return { status: 'failed', failure: this.refusal(path) };
  }

  async requestDownload(paths: string[]): Promise<RequestDownloadResult> {
    if (!this.closed) return this.inner.requestDownload(paths);
    return { failures: paths.map((path) => ({ path, failure: this.refusal(path) })) };
  }
}

/**
 * Owns which library is active. Operations run one at a time, so a foreground recheck can't overlap
 * a switch. Call `start` once at launch, before anything else.
 */
export class LibraryManager {
  private state: LibraryState = { status: 'starting' };
  private guard: GuardedFileStore | null = null;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly access: LibraryAccess,
    private readonly records: LibraryRecordStore,
  ) {}

  getState(): LibraryState {
    return this.state;
  }

  /** Calls `listener` after every state change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Restores the saved library, or sets up the app-owned folder on first launch. */
  start(): Promise<void> {
    return this.serialize(async () => {
      const saved = await this.records.read();
      const text = saved.ok ? saved.text : null;
      const root = text === null ? null : decodeRecord(text);
      if (root) {
        await this.enter(root, await this.restoreAndRefresh(root));
        return;
      }

      const recordLost = !saved.ok || text !== null;
      const appOwned: LibraryRoot = { kind: 'app_owned' };
      await this.enter(appOwned, await this.access.restore(appOwned), {
        offerFolderChoice: true,
        notice: recordLost ? RECORD_LOST_NOTICE : null,
      });
      // A record that can't be read stays until the user's next choice replaces it.
      if (!recordLost) await this.records.write(encodeRecord(appOwned));
    });
  }

  /**
   * Checks the active library's access again, on return to the foreground or after a problem with
   * `accessMayBeLost`. Moves between available, read-only, and unavailable as needed.
   */
  recheck(): Promise<void> {
    return this.serialize(async () => {
      if (this.state.status === 'starting') return;
      const { root } = this.state;
      const restored = await this.restoreAndRefresh(root);
      const unchanged =
        this.state.status === 'available' &&
        restored.status === 'ok' &&
        restored.writable === this.state.writable;
      if (!unchanged) await this.enter(root, restored);
    });
  }

  /**
   * Shows the system picker and activates the folder it gives. This is both choosing a folder and
   * reconnecting one. If the picker gives no folder, the current library stays as it was.
   */
  chooseFolder(): Promise<ChooseFolderResult> {
    return this.serialize(async () => {
      const picked = await this.access.pickFolder();
      switch (picked.status) {
        case 'cancelled':
          return { status: 'cancelled' };
        case 'unsupported_provider':
          return {
            status: 'refused',
            message: 'This provider doesn’t allow folder access, so it can’t be used as a library.',
          };
        case 'restricted_location':
          return { status: 'refused', message: ANDROID_FOLDER_GUIDANCE };
        case 'picker_failed':
          return {
            status: 'refused',
            message: 'The folder picker couldn’t open. Restarting the app may fix this.',
          };
      }
      const refused = await this.remember(picked.root);
      if (refused) return refused;
      const reconnected =
        this.state.status !== 'starting' && this.state.libraryId === libraryIdOf(picked.root);
      await this.enter(picked.root, { status: 'ok', writable: picked.writable });
      return { status: 'activated', reconnected };
    });
  }

  /** Switches to the app-owned folder. The previous library's files aren't touched. */
  useAppOwnedFolder(): Promise<ChooseFolderResult> {
    return this.serialize(async () => {
      const root: LibraryRoot = { kind: 'app_owned' };
      const restored = await this.access.restore(root);
      if (restored.status !== 'ok') {
        return { status: 'refused', message: 'Roamlet’s own folder couldn’t be opened.' };
      }
      const refused = await this.remember(root);
      if (refused) return refused;
      await this.enter(root, restored);
      return { status: 'activated', reconnected: false };
    });
  }

  private async remember(root: LibraryRoot): Promise<ChooseFolderResult | null> {
    const written = await this.records.write(encodeRecord(root));
    if (written.ok) return null;
    // Activating it anyway would silently bring back the old library at the next launch.
    return { status: 'refused', message: 'Roamlet couldn’t save this choice, so nothing changed.' };
  }

  /** A refreshed reference that can't be saved still works, and is refreshed again next time. */
  private async restoreAndRefresh(root: LibraryRoot): Promise<RestoreResult> {
    const restored = await this.access.restore(root);
    if (restored.status === 'stale') await this.records.write(encodeRecord(restored.root));
    return restored;
  }

  /** The only way into a library: any recovery finishes first, then it gets a fresh store. */
  private async enter(
    root: LibraryRoot,
    restored: RestoreResult,
    extras: { offerFolderChoice?: boolean; notice?: string | null } = {},
  ): Promise<void> {
    this.guard?.close();
    this.guard = null;

    if (restored.status === 'revoked' || restored.status === 'missing') {
      this.setUnavailable(root, restored.status);
      return;
    }
    const current = restored.status === 'stale' ? restored.root : root;
    const recovered = await this.access.recover(current);
    if (!recovered.ok) {
      this.setUnavailable(current, 'recovery_pending');
      return;
    }

    const { writable } = restored;
    this.guard = new GuardedFileStore(this.access.openStore(current), writable);
    this.setState({
      status: 'available',
      root: current,
      libraryId: libraryIdOf(current),
      store: this.guard,
      writable,
      readOnlyMessage: writable ? null : READ_ONLY_MESSAGE,
      offerFolderChoice: extras.offerFolderChoice ?? false,
      notice: extras.notice ?? null,
    });
  }

  private setUnavailable(root: LibraryRoot, reason: UnavailableReason): void {
    this.setState({
      status: 'unavailable',
      root,
      libraryId: libraryIdOf(root),
      reason,
      message: UNAVAILABLE_MESSAGE[reason],
    });
  }

  private setState(state: LibraryState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
