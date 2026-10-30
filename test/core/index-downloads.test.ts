import { LibraryIndex } from '../../src/core/index';
import { MemoryFileStore } from '../support/memory-file-store';
import { useIndexHost } from './index-helpers';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

describe('files not on the device', () => {
  const env = useIndexHost();
  let index: LibraryIndex;

  beforeEach(async () => {
    index = await LibraryIndex.open(env.host, 'lib');
  });
  afterEach(() => index.close());

  function cloudStore(): MemoryFileStore {
    const store = new MemoryFileStore({
      'here.org': note(ID_A, 'Here', `[[id:${ID_B}][cloud]]`),
      'sub/20260101-cloud.org': note(ID_B, 'Cloud title', 'hiddenword'),
    });
    store.setDownloaded('sub/20260101-cloud.org', false);
    return store;
  }

  it('Scenario: File not yet downloaded — shown by name, content unsearchable, counted', async () => {
    const store = cloudStore();

    const result = await index.reconcile(store);

    expect(result.added).toEqual(['here.org']);
    expect(store.calls.filter((call) => call.path === 'sub/20260101-cloud.org').map((call) => call.op)).toEqual([
      'requestDownload',
    ]);
    expect((await index.listFolder('sub')).files).toEqual([
      expect.objectContaining({
        path: 'sub/20260101-cloud.org',
        name: '20260101-cloud.org',
        title: '20260101-cloud',
        status: 'not_downloaded',
        contentIndexed: false,
        hasNodes: false,
      }),
    ]);
    expect(await index.search('hiddenword')).toEqual([]);
    expect(await index.search('Cloud title')).toEqual([]);
    expect((await index.search('20260101')).map((hit) => hit.filePath)).toEqual([
      'sub/20260101-cloud.org',
    ]);
    const problems = await index.problems();
    expect(problems.notDownloaded).toEqual([{ path: 'sub/20260101-cloud.org', contentIndexed: false }]);
    expect(problems.filesWithoutIds).toEqual([]);
    expect(await index.resolveLink(ID_B)).toBeNull();
    expect((await index.outgoingLinks('here.org'))[0].target).toBeNull();
  });

  it('gains its content once available, and links to it resolve', async () => {
    const store = cloudStore();
    await index.reconcile(store);
    store.setDownloaded('sub/20260101-cloud.org', true);

    const result = await index.reconcile(store);

    expect(result.changed).toEqual(['sub/20260101-cloud.org']);
    expect(await index.getFile('sub/20260101-cloud.org')).toMatchObject({
      status: 'ok',
      title: 'Cloud title',
      contentIndexed: true,
      hasNodes: true,
    });
    expect((await index.search('hiddenword')).map((hit) => hit.title)).toEqual(['Cloud title']);
    expect(await index.search('20260101')).toEqual([]);
    expect((await index.outgoingLinks('here.org'))[0].target?.id).toBe(ID_B);
    expect((await index.problems()).notDownloaded).toEqual([]);
  });

  it('a file listed as downloaded but reported not_downloaded on read is handled the same', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'A') });
    store.failOperation('digest', { path: 'a.org', kind: 'not_downloaded', times: 1 });

    const result = await index.reconcile(store);

    expect(result.readFailures).toEqual([]);
    expect(await index.getFile('a.org')).toMatchObject({ status: 'not_downloaded', contentIndexed: false });
  });

  it('requests downloads in batches', async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `n${i}.org`);
    const store = new MemoryFileStore();
    for (const path of paths) store.writeFile(path, 'text', { downloaded: false });
    const batches: string[][] = [];
    const request = store.requestDownload.bind(store);
    store.requestDownload = (batch) => {
      batches.push(batch);
      return request(batch);
    };

    const result = await index.reconcile(store, { downloadBatchSize: 3 });

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toEqual(paths);
    expect(result.downloadsRequested).toEqual(paths);
  });

  it('keeps requesting on later reconciles until the file arrives', async () => {
    const store = cloudStore();
    await index.reconcile(store);

    expect((await index.reconcile(store)).downloadsRequested).toEqual(['sub/20260101-cloud.org']);

    store.setDownloaded('sub/20260101-cloud.org', true);
    expect((await index.reconcile(store)).downloadsRequested).toEqual([]);
  });

  it('reports a failed download request and carries on', async () => {
    const store = cloudStore();
    store.failOperation('requestDownload');

    const result = await index.reconcile(store);

    expect(result.downloadFailures).toEqual([
      {
        path: 'sub/20260101-cloud.org',
        failure: expect.objectContaining({ kind: 'provider_error' }),
      },
    ]);
    expect(await index.getFile('here.org')).not.toBeNull();
  });

  it('a removed not-downloaded file leaves the index', async () => {
    const store = cloudStore();
    await index.reconcile(store);
    store.remove('sub/20260101-cloud.org');

    expect((await index.reconcile(store)).removed).toEqual(['sub/20260101-cloud.org']);
    expect((await index.listFolder('')).folders).toEqual([]);
  });
});
