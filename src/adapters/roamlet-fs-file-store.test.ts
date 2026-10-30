import {
  fileStoreContractCases,
  runFileStoreContractCase,
} from '../../test/support/file-store-contract';
import { MemoryFileStore } from '../../test/support/memory-file-store';
import type { ExternalLibraryRoot, FileEntry, LibraryRoot } from '../core/ports';
import {
  openRoamletFsStore,
  roamletFsAccess,
  type RoamletFsRootApi,
} from './roamlet-fs-file-store';

const EXTERNAL: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'notes',
  reference: 'content://provider/tree/notes',
};
const ROOTS: LibraryRoot[] = [{ kind: 'app_owned' }, EXTERNAL];
const BYTES = new Uint8Array([1, 2, 3]);
const ENTRY: FileEntry = {
  name: 'a.org',
  path: 'a.org',
  size: 3,
  mtime: 1,
  isDir: false,
  downloaded: true,
  writable: true,
};

function mockedModule(): jest.Mocked<RoamletFsRootApi> {
  return {
    pickFolder: jest.fn(),
    restore: jest.fn(),
    recover: jest.fn(),
    list: jest.fn(),
    readBytes: jest.fn(),
    digest: jest.fn(),
    createExclusive: jest.fn(),
    replaceFile: jest.fn(),
    requestDownload: jest.fn(),
  };
}

describe.each(ROOTS)('openRoamletFsStore over a $kind root', (root) => {
  it('passes the root and arguments on, and every result back unchanged', async () => {
    const fs = mockedModule();
    const store = openRoamletFsStore(fs, root);

    const listed = { entries: [ENTRY], failures: [] };
    fs.list.mockResolvedValue(listed);
    await expect(store.list()).resolves.toBe(listed);
    expect(fs.list).toHaveBeenCalledWith(root);

    const read = { ok: true as const, bytes: BYTES };
    fs.readBytes.mockResolvedValue(read);
    await expect(store.readBytes('a.org')).resolves.toBe(read);
    expect(fs.readBytes).toHaveBeenCalledWith(root, 'a.org');

    const digested = { ok: true as const, hash: 'abc' };
    fs.digest.mockResolvedValue(digested);
    await expect(store.digest('a.org')).resolves.toBe(digested);
    expect(fs.digest).toHaveBeenCalledWith(root, 'a.org');

    const created = { status: 'created' as const, path: 'a.org' };
    fs.createExclusive.mockResolvedValue(created);
    await expect(store.createExclusive('a.org', BYTES)).resolves.toBe(created);
    expect(fs.createExclusive).toHaveBeenCalledWith(root, 'a.org', BYTES);

    const replaced = { status: 'replaced' as const, hash: 'def' };
    fs.replaceFile.mockResolvedValue(replaced);
    await expect(store.replaceFile('a.org', BYTES, 'abc')).resolves.toBe(replaced);
    expect(fs.replaceFile).toHaveBeenCalledWith(root, 'a.org', BYTES, 'abc');

    const requested = { failures: [] };
    fs.requestDownload.mockResolvedValue(requested);
    await expect(store.requestDownload(['a.org'])).resolves.toBe(requested);
    expect(fs.requestDownload).toHaveBeenCalledWith(root, ['a.org']);
  });

  it('passes typed failures through as they are', async () => {
    const fs = mockedModule();
    const store = openRoamletFsStore(fs, root);
    const failure = { kind: 'access_denied' as const, message: 'revoked' };

    fs.readBytes.mockResolvedValue({ ok: false, failure });
    await expect(store.readBytes('a.org')).resolves.toEqual({ ok: false, failure });

    fs.replaceFile.mockResolvedValue({ status: 'stale', currentHash: 'other' });
    await expect(store.replaceFile('a.org', BYTES, 'abc')).resolves.toEqual({
      status: 'stale',
      currentHash: 'other',
    });

    fs.createExclusive.mockResolvedValue({ status: 'exists' });
    await expect(store.createExclusive('a.org', BYTES)).resolves.toEqual({ status: 'exists' });
  });

  it('turns every rejection into a provider failure', async () => {
    const fs = mockedModule();
    const store = openRoamletFsStore(fs, root);
    const failure = { kind: 'provider_error', message: 'bridge broke' };
    const broken = new Error('bridge broke');

    fs.list.mockRejectedValue(broken);
    await expect(store.list()).resolves.toEqual({ entries: [], failures: [{ path: '', failure }] });

    fs.readBytes.mockRejectedValue(broken);
    await expect(store.readBytes('a.org')).resolves.toEqual({ ok: false, failure });

    fs.digest.mockRejectedValue(broken);
    await expect(store.digest('a.org')).resolves.toEqual({ ok: false, failure });

    fs.createExclusive.mockRejectedValue(broken);
    await expect(store.createExclusive('a.org', BYTES)).resolves.toEqual({
      status: 'failed',
      failure,
    });

    fs.replaceFile.mockRejectedValue(broken);
    await expect(store.replaceFile('a.org', BYTES, 'abc')).resolves.toEqual({
      status: 'failed',
      failure,
    });

    fs.requestDownload.mockRejectedValue(broken);
    await expect(store.requestDownload(['a.org', 'b.org'])).resolves.toEqual({
      failures: [
        { path: 'a.org', failure },
        { path: 'b.org', failure },
      ],
    });
  });

  it('refuses bytes that did not cross the bridge as a Uint8Array', async () => {
    const fs = mockedModule();
    fs.readBytes.mockResolvedValue({ ok: true, bytes: [1, 2, 3] as unknown as Uint8Array });
    const result = await openRoamletFsStore(fs, root).readBytes('a.org');
    expect(result).toMatchObject({ ok: false, failure: { kind: 'provider_error' } });
  });
});

describe('roamletFsAccess', () => {
  it('passes results through and opens stores over the given root', async () => {
    const fs = mockedModule();
    const access = roamletFsAccess(fs);

    const picked = { status: 'picked' as const, root: EXTERNAL, writable: true };
    fs.pickFolder.mockResolvedValue(picked);
    await expect(access.pickFolder()).resolves.toBe(picked);

    const restored = { status: 'stale' as const, root: EXTERNAL, writable: false };
    fs.restore.mockResolvedValue(restored);
    await expect(access.restore(EXTERNAL)).resolves.toBe(restored);
    expect(fs.restore).toHaveBeenCalledWith(EXTERNAL);

    fs.recover.mockResolvedValue({ ok: true });
    await expect(access.recover(EXTERNAL)).resolves.toEqual({ ok: true });
    expect(fs.recover).toHaveBeenCalledWith(EXTERNAL);

    fs.digest.mockResolvedValue({ ok: true, hash: 'abc' });
    await access.openStore(EXTERNAL).digest('a.org');
    expect(fs.digest).toHaveBeenCalledWith(EXTERNAL, 'a.org');
  });

  it('maps a rejected picker to the result that asks for a restart', async () => {
    const fs = mockedModule();
    fs.pickFolder.mockRejectedValue(new Error('launcher gone'));
    await expect(roamletFsAccess(fs).pickFolder()).resolves.toEqual({
      status: 'picker_failed',
      message: 'launcher gone',
    });
  });

  it('maps a rejected recovery to a failure, so it can run again', async () => {
    const fs = mockedModule();
    fs.recover.mockRejectedValue(new Error('bridge broke'));
    await expect(roamletFsAccess(fs).recover(EXTERNAL)).resolves.toEqual({
      ok: false,
      failure: { kind: 'provider_error', message: 'bridge broke' },
    });
  });

  it('maps a rejected restore to missing, which keeps the index and drafts', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const fs = mockedModule();
    fs.restore.mockRejectedValue(new Error('bad reference'));
    await expect(roamletFsAccess(fs).restore(EXTERNAL)).resolves.toEqual({ status: 'missing' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad reference'));
    warn.mockRestore();
  });
});

describe('the contract through the adapter', () => {
  // Proves the mapping loses nothing the contract relies on. The native sides run it on a device.
  it.each(fileStoreContractCases.map((contractCase) => [contractCase.name, contractCase] as const))(
    '%s',
    async (_name, contractCase) => {
      await runFileStoreContractCase(contractCase, {
        open: async (files) => {
          const memory = new MemoryFileStore(files);
          const fs: RoamletFsRootApi = {
            ...mockedModule(),
            list: () => memory.list(),
            readBytes: (_root, path) => memory.readBytes(path),
            digest: (_root, path) => memory.digest(path),
            createExclusive: (_root, path, bytes) => memory.createExclusive(path, bytes),
            replaceFile: (_root, path, bytes, hash) => memory.replaceFile(path, bytes, hash),
            requestDownload: (_root, paths) => memory.requestDownload(paths),
          };
          return { store: openRoamletFsStore(fs, EXTERNAL) };
        },
      });
    },
  );
});
