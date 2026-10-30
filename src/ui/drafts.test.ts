import { AppState, type AppStateStatus } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { createElement, type ReactNode } from 'react';

import {
  DraftStore,
  DraftStoreContext,
  fileDraftStorage,
  useDraftFailed,
  useDraftStore,
  type DraftFiles,
  type DraftKey,
  type DraftStorage,
} from './drafts';

const KEY: DraftKey = { libraryId: 'lib-1', path: 'daily/a.org' };
const OTHER_PATH: DraftKey = { libraryId: 'lib-1', path: 'daily/b.org' };
const OTHER_LIBRARY: DraftKey = { libraryId: 'lib-2', path: 'daily/a.org' };
const DELAY_MS = 5;

function wait(ms = DELAY_MS * 4): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MemoryDraftFiles implements DraftFiles {
  readonly files = new Map<string, string>();
  writes: string[] = [];
  failing = false;

  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    if (this.failing) throw new Error('disk full');
    this.writes.push(text);
    this.files.set(path, text);
  }
  async move(from: string, to: string) {
    if (this.failing) throw new Error('disk full');
    this.files.set(to, this.files.get(from) as string);
    this.files.delete(from);
  }
  async delete(path: string) {
    this.files.delete(path);
  }
}

const identityHash = async (text: string) => encodeURIComponent(text);

function setUp(delayMs = DELAY_MS) {
  const files = new MemoryDraftFiles();
  const storage = fileDraftStorage(files, identityHash);
  return { files, storage, drafts: new DraftStore(storage, delayMs) };
}

describe('DraftStore', () => {
  it('writes only the latest text once typing pauses', async () => {
    const { files, drafts } = setUp();
    drafts.update(KEY, 'a');
    drafts.update(KEY, 'ab');
    drafts.update(KEY, 'abc');
    expect(files.writes).toEqual([]);
    await wait();
    expect(files.writes).toHaveLength(1);
    expect(files.writes[0]).toContain('abc');
  });

  it('flush writes at once without waiting for the pause', async () => {
    const { files, storage, drafts } = setUp(60_000);
    drafts.update(KEY, 'kept');
    await drafts.flush();
    expect(files.writes).toHaveLength(1);
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'kept' });
  });

  it('keeps drafts apart by library and by path', async () => {
    const { storage, drafts } = setUp();
    drafts.update(KEY, 'one');
    drafts.update(OTHER_PATH, 'two');
    drafts.update(OTHER_LIBRARY, 'three');
    await drafts.flush();
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'one' });
    expect(await storage.read(OTHER_PATH)).toEqual({ ok: true, text: 'two' });
    expect(await storage.read(OTHER_LIBRARY)).toEqual({ ok: true, text: 'three' });
  });

  it('reads text that has not reached storage yet', async () => {
    const { drafts } = setUp(60_000);
    drafts.update(KEY, 'typed just now');
    expect(await drafts.read(KEY)).toEqual({ ok: true, text: 'typed just now' });
    await drafts.discard(KEY);
  });

  it('reads nothing when there is no draft', async () => {
    const { drafts } = setUp();
    expect(await drafts.read(KEY)).toEqual({ ok: true, text: null });
  });

  it('discard removes a stored draft and cancels a waiting write', async () => {
    const { files, storage, drafts } = setUp();
    drafts.update(KEY, 'stored');
    await drafts.flush();
    drafts.update(KEY, 'waiting');
    await drafts.discard(KEY);
    await wait();
    expect(await storage.read(KEY)).toEqual({ ok: true, text: null });
    expect(files.files.size).toBe(0);
  });

  it('a discard after a write in flight still wins', async () => {
    const { storage, drafts } = setUp();
    drafts.update(KEY, 'text');
    const flushed = drafts.flush();
    await drafts.discard(KEY);
    await flushed;
    expect(await storage.read(KEY)).toEqual({ ok: true, text: null });
  });

  it('a failed write is reported, kept, and retried by the next flush', async () => {
    const { files, storage, drafts } = setUp();
    files.failing = true;
    drafts.update(KEY, 'precious');
    await drafts.flush();
    expect(drafts.hasFailed(KEY)).toBe(true);
    expect(await drafts.read(KEY)).toEqual({ ok: true, text: 'precious' });

    files.failing = false;
    await drafts.flush();
    expect(drafts.hasFailed(KEY)).toBe(false);
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'precious' });
  });

  it('a failed retry does not replace newer text', async () => {
    const { files, storage, drafts } = setUp(60_000);
    files.failing = true;
    drafts.update(KEY, 'old');
    const flushed = drafts.flush();
    drafts.update(KEY, 'new');
    await flushed;
    files.failing = false;
    await drafts.flush();
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'new' });
  });

  it('survives a storage adapter that rejects', async () => {
    const broken: DraftStorage = {
      read: () => Promise.reject(new Error('bug')),
      write: () => Promise.reject(new Error('bug')),
      remove: () => Promise.reject(new Error('bug')),
    };
    const drafts = new DraftStore(broken, 60_000);
    expect((await drafts.read(KEY)).ok).toBe(false);
    drafts.update(KEY, 'text');
    await drafts.flush();
    expect(drafts.hasFailed(KEY)).toBe(true);
    expect((await drafts.discard(KEY)).ok).toBe(false);
  });

  it('notifies subscribers only when the failed state changes', async () => {
    const { files, drafts } = setUp(60_000);
    const listener = jest.fn();
    const unsubscribe = drafts.subscribe(listener);
    files.failing = true;
    drafts.update(KEY, 'a');
    await drafts.flush();
    await drafts.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    files.failing = false;
    await drafts.flush();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('fileDraftStorage', () => {
  it('keeps drafts under the library’s internal drafts folder', async () => {
    const { files, storage } = setUp();
    await storage.write(KEY, 'text');
    expect([...files.files.keys()]).toEqual([
      `libraries/lib-1/drafts/${encodeURIComponent(KEY.path)}.json`,
    ]);
  });

  it('round-trips text exactly', async () => {
    const { storage } = setUp();
    const text = '  Café\r\n\n"quoted" \\ ✓\n';
    await storage.write(KEY, text);
    expect(await storage.read(KEY)).toEqual({ ok: true, text });
  });

  const draftPath = `libraries/lib-1/drafts/${encodeURIComponent(KEY.path)}.json`;
  const tempPath = `libraries/lib-1/drafts/${encodeURIComponent(KEY.path)}.tmp`;

  it('a kill while writing the temp file leaves the old draft', async () => {
    const { files, storage } = setUp();
    await storage.write(KEY, 'old');
    files.files.set(tempPath, '{"version":1,"pa');
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'old' });
  });

  it('a kill after the move deleted the old draft leaves the new one in the temp file', async () => {
    const { files, storage } = setUp();
    await storage.write(KEY, 'new');
    files.files.set(tempPath, files.files.get(draftPath) as string);
    files.files.delete(draftPath);
    expect(await storage.read(KEY)).toEqual({ ok: true, text: 'new' });
  });

  it('a first draft cut short by a kill reads as no draft', async () => {
    const { files, storage } = setUp();
    files.files.set(tempPath, '{"version":1,"pa');
    expect(await storage.read(KEY)).toEqual({ ok: true, text: null });
  });

  it('ignores a file holding another path’s draft', async () => {
    const { files, storage } = setUp();
    await storage.write(OTHER_PATH, 'not this one');
    const other = `libraries/lib-1/drafts/${encodeURIComponent(OTHER_PATH.path)}.json`;
    files.files.set(draftPath, files.files.get(other) as string);
    expect(await storage.read(KEY)).toEqual({ ok: true, text: null });
  });

  it('remove takes the temp file too', async () => {
    const { files, storage } = setUp();
    await storage.write(KEY, 'text');
    files.files.set(tempPath, 'left over');
    expect(await storage.remove(KEY)).toEqual({ ok: true });
    expect(files.files.size).toBe(0);
  });

  it('reports file errors as results', async () => {
    const { files, storage } = setUp();
    files.failing = true;
    const result = await storage.write(KEY, 'text');
    expect(result).toEqual({
      ok: false,
      failure: { kind: 'provider_error', message: 'disk full' },
    });
  });
});

describe('hooks', () => {
  function wrapperFor(drafts: DraftStore) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return createElement(DraftStoreContext.Provider, { value: drafts }, children);
    };
  }

  afterEach(() => jest.restoreAllMocks());

  it.each(['background', 'inactive'] as AppStateStatus[])(
    'useDraftStore writes waiting text on %s',
    async (status) => {
      let notify: (next: AppStateStatus) => void = () => undefined;
      const remove = jest.fn();
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
        notify = listener;
        return { remove } as never;
      });
      const { files, drafts } = setUp(60_000);
      const { unmount } = await renderHook(() => useDraftStore(), {
        wrapper: wrapperFor(drafts),
      });

      drafts.update(KEY, 'about to be killed');
      await act(async () => {
        notify(status);
        await wait();
      });
      expect(files.writes).toHaveLength(1);

      await unmount();
      expect(remove).toHaveBeenCalled();
    },
  );

  it('useDraftFailed follows the store', async () => {
    const { files, drafts } = setUp(60_000);
    const { result } = await renderHook(() => useDraftFailed(KEY), {
      wrapper: wrapperFor(drafts),
    });
    expect(result.current).toBe(false);

    files.failing = true;
    drafts.update(KEY, 'text');
    await act(() => drafts.flush());
    expect(result.current).toBe(true);
  });
});
