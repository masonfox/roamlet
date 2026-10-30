import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { FileStoreFailure, RecordReadResult, RecordWriteResult } from '../core/ports';

// Unsaved capture and edit text, in internal storage and never in the library (Decision 3), so it
// outlives losing access to the folder.

/** Whose text this is. Text is opaque here, so an editor can keep its title and body in one draft. */
export interface DraftKey {
  libraryId: string;
  /** The note's library-relative path, or `CAPTURE_DRAFT_PATH`. */
  path: string;
}

/** The library root, which no note can be at. */
export const CAPTURE_DRAFT_PATH = '';

/** How long typing must pause before a draft is written. */
export const DRAFT_DELAY_MS = 300;

/** Where drafts are kept. Expected failures are results, as for `LibraryRecordStore`. */
export interface DraftStorage {
  /** `text` is null when there is no draft. */
  read(key: DraftKey): Promise<RecordReadResult>;
  write(key: DraftKey, text: string): Promise<RecordWriteResult>;
  /** Fine if there is no draft. */
  remove(key: DraftKey): Promise<RecordWriteResult>;
}

function failureOf(error: unknown): FileStoreFailure {
  return {
    kind: 'provider_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Holds the latest text of each draft and writes it after a pause in typing. Storage calls run one
 * at a time in the order made, so an older write can't land on a newer one or on a discard. Text
 * that couldn't be written stays here and is tried again by the next `update` or `flush`.
 */
export class DraftStore {
  private readonly pending = new Map<string, { key: DraftKey; text: string }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: DraftStorage,
    private readonly delayMs: number = DRAFT_DELAY_MS,
  ) {}

  /** The draft as last updated, whether or not it has reached storage. */
  async read(key: DraftKey): Promise<RecordReadResult> {
    const id = idOf(key);
    const result = await this.enqueue(() => this.storage.read(key));
    const newest = this.pending.get(id);
    return newest ? { ok: true, text: newest.text } : result;
  }

  /** Records the text now, and writes it once typing pauses. */
  update(key: DraftKey, text: string): void {
    const id = idOf(key);
    this.pending.set(id, { key, text });
    this.cancelTimer(id);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.write(id);
      }, this.delayMs),
    );
  }

  /** Writes everything waiting, as when the app may be about to be killed. Never rejects. */
  async flush(): Promise<void> {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.cancelTimer(id);
    await Promise.all(ids.map((id) => this.write(id)));
  }

  /** Forgets the draft. On failure it may still come back after a restart. Never rejects. */
  async discard(key: DraftKey): Promise<RecordWriteResult> {
    const id = idOf(key);
    this.cancelTimer(id);
    this.pending.delete(id);
    const result = await this.enqueue(() => this.storage.remove(key));
    this.setFailed(id, !result.ok);
    return result;
  }

  /** True while the draft's latest text couldn't be written, so it would not survive a restart. */
  hasFailed(key: DraftKey): boolean {
    return this.failed.has(idOf(key));
  }

  /** Calls `listener` when `hasFailed` changes. Returns the unsubscribe function. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private async write(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    const result = await this.enqueue(() => this.storage.write(entry.key, entry.text));
    // Newer text, or a discard made while this was queued, has already replaced it.
    if (!result.ok && !this.pending.has(id)) this.pending.set(id, entry);
    this.setFailed(id, !result.ok);
  }

  /** A rejection is a broken adapter, and must not stop later drafts from being written. */
  private enqueue<T extends { ok: boolean }>(
    work: () => Promise<T>,
  ): Promise<T | { ok: false; failure: FileStoreFailure }> {
    const run = this.queue.then(work).catch((error: unknown) => ({
      ok: false as const,
      failure: failureOf(error),
    }));
    this.queue = run;
    return run;
  }

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private setFailed(id: string, failed: boolean): void {
    if (this.failed.has(id) === failed) return;
    if (failed) this.failed.add(id);
    else this.failed.delete(id);
    for (const listener of this.listeners) listener();
  }
}

function idOf(key: DraftKey): string {
  return JSON.stringify([key.libraryId, key.path]);
}

/** Plain files under a private directory. Paths are relative to it and `/`-separated. */
export interface DraftFiles {
  /** Null when the file doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Creates parent folders as needed, and replaces any file there. Not atomic. */
  write(path: string, text: string): Promise<void>;
  /** Moves over any file at `to`. Not atomic: `to` may be deleted first. */
  move(from: string, to: string): Promise<void>;
  /** Fine if the file doesn't exist. */
  delete(path: string): Promise<void>;
}

const DRAFT_FORMAT_VERSION = 1;

/**
 * Drafts as `libraries/<libraryId>/drafts/<hash of path>.json` (Decision 3). A path can be too long
 * for a file name, hence the hash. Neither file operation is atomic, so a draft goes to a temp file
 * first: a kill leaves the complete old draft, or the complete new one in the temp file, which is
 * only used when the draft itself is missing. A file cut short by a kill fails to parse and is
 * ignored.
 */
export function fileDraftStorage(
  files: DraftFiles,
  hash: (text: string) => Promise<string>,
): DraftStorage {
  const locate = async (key: DraftKey) => {
    const base = `libraries/${key.libraryId}/drafts/${await hash(key.path)}`;
    return { draft: `${base}.json`, temp: `${base}.tmp` };
  };

  const decode = (content: string | null, path: string): string | null => {
    if (content === null) return null;
    try {
      const parsed = JSON.parse(content);
      const usable =
        parsed?.version === DRAFT_FORMAT_VERSION &&
        parsed.path === path &&
        typeof parsed.text === 'string';
      return usable ? parsed.text : null;
    } catch {
      return null;
    }
  };

  return {
    read: async (key) => {
      try {
        const { draft, temp } = await locate(key);
        const text = decode(await files.read(draft), key.path);
        return { ok: true, text: text ?? decode(await files.read(temp), key.path) };
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    write: async (key, text) => {
      try {
        const { draft, temp } = await locate(key);
        const content = JSON.stringify({ version: DRAFT_FORMAT_VERSION, path: key.path, text });
        await files.write(temp, content);
        await files.move(temp, draft);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    remove: async (key) => {
      try {
        const { draft, temp } = await locate(key);
        // In this order, a kill can't leave an older temp file to come back as the draft.
        await files.delete(temp);
        await files.delete(draft);
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
  };
}

/**
 * The real storage. Native modules load on first use, because merely importing `roamlet-fs` throws
 * wherever its native side is missing, such as in Jest. A failed load is a failed call.
 */
function nativeDraftStorage(): DraftStorage {
  let loaded: Promise<DraftStorage> | null = null;
  const load = (): Promise<DraftStorage> => {
    loaded ??= loadNativeDraftStorage().catch((error: unknown) => {
      loaded = null;
      throw error;
    });
    return loaded;
  };
  return {
    read: async (key) => {
      try {
        return await (await load()).read(key);
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    write: async (key, text) => {
      try {
        return await (await load()).write(key, text);
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
    remove: async (key) => {
      try {
        return await (await load()).remove(key);
      } catch (error) {
        return { ok: false, failure: failureOf(error) };
      }
    },
  };
}

async function loadNativeDraftStorage(): Promise<DraftStorage> {
  const [{ RoamletFs }, { File }, { CryptoDigestAlgorithm, digestStringAsync }] = await Promise.all(
    [import('../../modules/roamlet-fs'), import('expo-file-system'), import('expo-crypto')],
  );

  // The path has spaces on iOS (`Application Support`), so it needs encoding as a URI.
  const root = `file://${encodeURI(RoamletFs.internalDirectory())}`;
  const fileAt = (path: string) => new File(root, path);

  const files: DraftFiles = {
    read: async (path) => {
      const file = fileAt(path);
      return file.exists ? file.text() : null;
    },
    write: async (path, text) => {
      const file = fileAt(path);
      file.parentDirectory.create({ intermediates: true, idempotent: true });
      if (file.exists) file.delete();
      file.write(text);
    },
    move: async (from, to) => {
      fileAt(from).move(fileAt(to), { overwrite: true });
    },
    delete: async (path) => {
      const file = fileAt(path);
      if (file.exists) file.delete();
    },
  };
  return fileDraftStorage(files, (text) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text));
}

/** Exported so a test can provide its own store. The app uses the real one, so needs no provider. */
export const DraftStoreContext = createContext<DraftStore>(new DraftStore(nativeDraftStorage()));

/** The app's drafts. While a screen uses this, leaving the foreground writes all waiting text. */
export function useDraftStore(): DraftStore {
  const store = useContext(DraftStoreContext);
  useEffect(() => {
    // `inactive` too: iOS can kill the app from there, and may not report `background` in time.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void store.flush();
    });
    return () => subscription.remove();
  }, [store]);
  return store;
}

/** True while this draft's latest text wouldn't survive a restart, so the user can be told. */
export function useDraftFailed(key: DraftKey | null): boolean {
  const store = useContext(DraftStoreContext);
  return useSyncExternalStore(store.subscribe, () => (key ? store.hasFailed(key) : false));
}
