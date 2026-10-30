import { fileStoreContractCases, runFileStoreContract } from '../../test/support/file-store-contract';
import { MemoryFileStore } from '../../test/support/memory-file-store';
import {
  runContractOnDevice,
  scopedFileStore,
  scratchContractHarness,
  type ScratchFolders,
} from './roamlet-fs-contract';
import type { RoamletFsRootApi } from './roamlet-fs-file-store';

const folderOps = (memory: MemoryFileStore): ScratchFolders => ({
  make: async (path) => memory.mkdir(path),
  remove: async (path) => memory.remove(path),
});

describe('scratchContractHarness', () => {
  it('passes every contract case in scratch folders, beside untouched notes', async () => {
    const memory = new MemoryFileStore({ 'mine.org': 'keep', 'daily/mine.org': 'keep too' });

    const results = await runFileStoreContract(
      scratchContractHarness(memory, folderOps(memory), 'run'),
    );

    expect(results.filter((result) => result.error !== undefined)).toEqual([]);
    expect(results).toHaveLength(fileStoreContractCases.length);
    expect(memory.paths().sort()).toEqual(['daily/mine.org', 'mine.org']);
    expect(memory.peekText('mine.org')).toBe('keep');
  });

  it('cleans up when seeding fails, and reports the failure', async () => {
    const memory = new MemoryFileStore();
    memory.failOperation('createExclusive');

    await expect(
      scratchContractHarness(memory, folderOps(memory), 'run').open({
        'a.org': new Uint8Array([1]),
      }),
    ).rejects.toThrow('seeding a.org');
    expect((await memory.list()).entries).toEqual([]);
  });
});

describe('scopedFileStore', () => {
  it('reports only failures in its folder, relative to it', async () => {
    const memory = new MemoryFileStore({ 'scratch/deep/a.org': 'a', 'other/b.org': 'b' });
    const scoped = scopedFileStore(memory, 'scratch');

    memory.failOperation('list', { path: 'other' });
    expect((await scoped.list()).failures).toEqual([]);

    memory.clearFaults();
    memory.failOperation('list', { path: 'scratch/deep' });
    expect((await scoped.list()).failures).toMatchObject([{ path: 'deep' }]);

    memory.clearFaults();
    memory.failOperation('list', { path: 'scratch' });
    expect((await scoped.list()).failures).toMatchObject([{ path: '' }]);

    memory.clearFaults();
    memory.failOperation('list');
    expect((await scoped.list()).failures).toMatchObject([{ path: '' }]);
  });

  it('maps requested download failures back to its own paths', async () => {
    const memory = new MemoryFileStore({ 'scratch/a.org': 'a' });
    memory.failOperation('requestDownload');
    expect(await scopedFileStore(memory, 'scratch').requestDownload(['a.org'])).toMatchObject({
      failures: [{ path: 'a.org' }],
    });
  });
});

describe('runContractOnDevice', () => {
  const external = { kind: 'external', id: 'x', name: 'x', reference: 'content://x' } as const;

  function moduleWith(overrides: Partial<RoamletFsRootApi>): RoamletFsRootApi {
    const missing = () => Promise.reject(new Error('not expected'));
    return {
      pickFolder: missing,
      restore: () => Promise.resolve({ status: 'ok', writable: true }),
      recover: missing,
      list: () => Promise.resolve({ entries: [], failures: [] }),
      readBytes: missing,
      digest: missing,
      createExclusive: missing,
      replaceFile: missing,
      requestDownload: missing,
      ...overrides,
    };
  }

  it('refuses an external folder on iOS', async () => {
    await expect(runContractOnDevice(moduleWith({}), external, 'ios')).rejects.toThrow('Android');
  });

  it('refuses a folder it could not restore', async () => {
    const fs = moduleWith({ restore: () => Promise.resolve({ status: 'revoked' }) });
    await expect(runContractOnDevice(fs, external, 'android')).rejects.toThrow('revoked');
  });

  it('refuses an external folder with anything in it', async () => {
    const fs = moduleWith({
      list: () =>
        Promise.resolve({
          entries: [
            {
              name: 'note.org',
              path: 'note.org',
              size: 1,
              mtime: 1,
              isDir: false,
              downloaded: true,
              writable: true,
            },
          ],
          failures: [],
        }),
    });
    await expect(runContractOnDevice(fs, external, 'android')).rejects.toThrow('empty');
  });
});
