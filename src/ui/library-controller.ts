import { LibraryIndex, type ReconcileProgress, type ReconcileResult } from '../core/index';
import { LibraryManager, type ChooseFolderResult, type LibraryState } from '../core/library';
import type {
  Clock,
  FileStore,
  IdGenerator,
  LibraryAccess,
  LibraryRecordStore,
  SqlDatabaseHost,
} from '../core/ports';

/**
 * Everything the app needs from the platform. `loadNativeLibraryServices` provides the real ones,
 * and tests provide an in-memory store instead (`createTestLibrary`).
 */
export interface LibraryServices {
  access: LibraryAccess;
  records: LibraryRecordStore;
  databases: SqlDatabaseHost;
  ids: IdGenerator;
  clock: Clock;
}

export interface LibraryFailure {
  /** `startup`: the library layer never started, so `state` stays `starting`. */
  stage: 'startup' | 'access' | 'index';
  /** Plain language, for the user. */
  message: string;
  /** Diagnostic detail for logs. Not for display. */
  detail: string;
}

/** What the app knows about the library right now. Replaced whole on every change. */
export interface LibrarySnapshot {
  state: LibraryState;
  /**
   * The active library's index, or null while it is opening or when it couldn't be opened. It stays
   * set while the library is `unavailable`, so what was indexed can still be browsed. Never keep
   * this across renders: it is closed when the library changes.
   */
  index: LibraryIndex | null;
  /** The active library's store, or null unless `state` is `available`. */
  store: FileStore | null;
  /** True while a reconcile or rebuild runs. Everything keeps working meanwhile. */
  refreshing: boolean;
  /** How far the running reconcile or rebuild is. Null when none is, and until a note is done. */
  progress: ReconcileProgress | null;
  /**
   * When the index last matched a listing, even a partial one. Null until that first happens in
   * this run of the app. A failed listing leaves this alone.
   */
  lastRefreshAt: Date | null;
  /** The last run's outcome. `listing` and `listingFailures` tell what could not be reached. */
  lastResult: ReconcileResult | null;
  /**
   * Changes whenever indexed data may have changed, during a run as well as after it. Screens list
   * it as an effect dependency next to `index` to query again.
   */
  revision: number;
  /** The latest failure, or null. Cleared by the next successful run. */
  failure: LibraryFailure | null;
}

export type LibraryServicesLoader = () => Promise<LibraryServices>;

const STARTUP_MESSAGE = 'Roamlet couldn’t open its storage. Restarting the app may fix this.';
const ACCESS_MESSAGE = 'Roamlet couldn’t check access to this folder. Try again in a moment.';
const SWITCH_MESSAGE = 'Roamlet couldn’t open this location, so nothing changed.';
const INDEX_MESSAGE =
  'The note index couldn’t be updated, so browsing and search may be out of date. Your notes aren’t affected. Restarting the app may fix this.';

// A rebuild reports each note, and every update renders every screen using the context.
const PROGRESS_INTERVAL_MS = 250;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function storeOf(state: LibraryState): FileStore | null {
  return state.status === 'available' ? state.store : null;
}

/**
 * Runs the library's life outside React, so that its order can't depend on render timing: startup
 * goes restore, recovery, then reconcile, and a later refresh repeats the parts that apply. Index
 * work runs one job at a time, and every job starts from the current library, so a switch in the
 * middle can't mix two libraries.
 */
export class LibraryController {
  private snapshot: LibrarySnapshot = {
    state: { status: 'starting' },
    index: null,
    store: null,
    refreshing: false,
    progress: null,
    lastRefreshAt: null,
    lastResult: null,
    revision: 0,
    failure: null,
  };

  private readonly listeners = new Set<() => void>();
  private services: LibraryServices | null = null;
  private manager: LibraryManager | null = null;
  private unsubscribeManager: (() => void) | null = null;
  private opened: { libraryId: string; index: LibraryIndex } | null = null;
  private started: Promise<void> | null = null;
  private closed = false;

  private queue: Promise<unknown> = Promise.resolve();
  private queuedRefresh: Promise<void> | null = null;

  /** Valid once `state` has left `starting`. */
  readonly ids: IdGenerator = { newId: () => this.requireServices().ids.newId() };
  readonly clock: Clock = { now: () => this.requireServices().clock.now() };

  constructor(private readonly loadServices: LibraryServicesLoader) {}

  readonly getSnapshot = (): LibrarySnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Restores access, recovers, then reconciles. Safe to call again. Never rejects. */
  readonly start = (): Promise<void> => {
    this.started ??= this.runStartup();
    return this.started;
  };

  /**
   * Brings the index in line with the files. A call during a run gets one follow-up run, shared with
   * other such calls, so a change the running one may have missed is still picked up. Does nothing
   * unless the library is available. Never rejects: see `failure` and `lastResult`.
   */
  readonly refresh = (): Promise<void> => {
    this.queuedRefresh ??= this.enqueue(async () => {
      this.queuedRefresh = null;
      await this.runIndexJob('reconcile');
    });
    return this.queuedRefresh;
  };

  /** Deletes the index and builds it from the files. Never rejects. */
  readonly rebuild = (): Promise<void> => this.enqueue(() => this.runIndexJob('rebuild'));

  /** On return to the foreground: checks access again, then refreshes. */
  readonly foreground = async (): Promise<void> => {
    await this.recheckAccess();
    await this.refresh();
  };

  /**
   * Checks the active library's access again, as after a `LibraryProblem` with `accessMayBeLost`.
   * Moves `state` as needed, and refreshes if that gave the library a new store. Never rejects.
   */
  readonly recheckAccess = async (): Promise<void> => {
    await this.start();
    if (!this.manager) return;
    const before = this.snapshot.store;
    try {
      await this.manager.recheck();
    } catch (error) {
      this.update({
        failure: { stage: 'access', message: ACCESS_MESSAGE, detail: detailOf(error) },
      });
      return;
    }
    if (this.snapshot.store && this.snapshot.store !== before) void this.refresh();
  };

  /**
   * Shows the folder picker and activates what it gives, which also reconnects a lost folder. This
   * resolves once the choice is made, and indexing carries on in `progress`. Never rejects: a
   * failure is a `refused` result, and the current library stays.
   */
  readonly chooseFolder = (): Promise<ChooseFolderResult> =>
    this.switchLibrary((manager) => manager.chooseFolder());

  /** Switches to the app-owned folder, as `chooseFolder` does. */
  readonly switchToAppOwnedFolder = (): Promise<ChooseFolderResult> =>
    this.switchLibrary((manager) => manager.useAppOwnedFolder());

  /** Stops index work and closes the index. The controller can't be used after this. */
  async close(): Promise<void> {
    await this.start();
    this.closed = true;
    await this.queue;
    this.unsubscribeManager?.();
    await this.closeOpenedIndex();
    this.listeners.clear();
  }

  private requireServices(): LibraryServices {
    if (!this.services) throw new Error('The library has not started');
    return this.services;
  }

  private async runStartup(): Promise<void> {
    try {
      this.services = await this.loadServices();
      this.manager = new LibraryManager(this.services.access, this.services.records);
      this.unsubscribeManager = this.manager.subscribe(this.onManagerChange);
      await this.manager.start();
    } catch (error) {
      this.update({
        failure: { stage: 'startup', message: STARTUP_MESSAGE, detail: detailOf(error) },
      });
      return;
    }
    await this.refresh();
  }

  private readonly onManagerChange = (): void => {
    const state = (this.manager as LibraryManager).getState();
    // The index goes at once, so nobody can pair the new library's store with the old one's index.
    const opened = this.opened;
    const sameLibrary = state.status !== 'starting' && state.libraryId === opened?.libraryId;
    this.update({ state, store: storeOf(state), index: sameLibrary ? opened.index : null });
  };

  private async switchLibrary(
    action: (manager: LibraryManager) => Promise<ChooseFolderResult>,
  ): Promise<ChooseFolderResult> {
    await this.start();
    if (!this.manager) return { status: 'refused', message: STARTUP_MESSAGE };
    try {
      const result = await action(this.manager);
      if (result.status === 'activated') void this.refresh();
      return result;
    } catch {
      return { status: 'refused', message: SWITCH_MESSAGE };
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work);
    this.queue = run;
    return run;
  }

  private async runIndexJob(mode: 'reconcile' | 'rebuild'): Promise<void> {
    const { state } = this.snapshot;
    if (this.closed || state.status === 'starting') return;

    const index = await this.indexFor(state.libraryId);
    if (!index || state.status !== 'available') return;

    this.update({ refreshing: true, progress: null });
    let lastEmit = 0;
    const onProgress = (progress: ReconcileProgress) => {
      const now = Date.now();
      if (progress.processed < progress.total && now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = now;
      this.update({ progress, revision: this.snapshot.revision + 1 });
    };

    try {
      const result = await this.updateIndex(mode, index, state.store, onProgress);
      const listed = result.listing !== 'failed';
      this.update({
        lastResult: result,
        lastRefreshAt: listed ? this.requireServices().clock.now() : this.snapshot.lastRefreshAt,
        revision: this.snapshot.revision + 1,
        failure: null,
      });
      // Nothing could be listed, so the folder may be gone. The queue must not wait on this.
      if (!listed) void this.recheckAccess();
    } catch (error) {
      await this.closeOpenedIndex();
      this.update({
        index: null,
        revision: this.snapshot.revision + 1,
        failure: { stage: 'index', message: INDEX_MESSAGE, detail: detailOf(error) },
      });
    } finally {
      this.update({ refreshing: false, progress: null });
    }
  }

  /**
   * A rejected reconcile means the database is damaged, and a rebuild is how the index recovers
   * (Decision 5). A requested rebuild waits for a complete listing, because deleting the database
   * while folders can't be reached would lose the entries a failed listing is meant to keep.
   */
  private async updateIndex(
    mode: 'reconcile' | 'rebuild',
    index: LibraryIndex,
    store: FileStore,
    onProgress: (progress: ReconcileProgress) => void,
  ): Promise<ReconcileResult> {
    if (mode === 'rebuild') {
      const { failures } = await store.list();
      if (failures.length === 0) return index.rebuild(store, { onProgress });
    }
    try {
      return await index.reconcile(store, { onProgress });
    } catch {
      return index.rebuild(store, { onProgress });
    }
  }

  private async indexFor(libraryId: string): Promise<LibraryIndex | null> {
    if (this.opened?.libraryId === libraryId) return this.opened.index;
    await this.closeOpenedIndex();
    try {
      const index = await LibraryIndex.open(this.requireServices().databases, libraryId);
      this.opened = { libraryId, index };
      this.update({ index, revision: this.snapshot.revision + 1, failure: null });
      return index;
    } catch (error) {
      this.update({
        index: null,
        failure: { stage: 'index', message: INDEX_MESSAGE, detail: detailOf(error) },
      });
      return null;
    }
  }

  private async closeOpenedIndex(): Promise<void> {
    const opened = this.opened;
    this.opened = null;
    // A damaged database may not close cleanly, and is being replaced anyway.
    await opened?.index.close().catch(() => undefined);
  }

  private update(changes: Partial<LibrarySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }
}
