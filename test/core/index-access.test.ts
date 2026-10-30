import { LibraryIndex } from '../../src/core/index';
import { MemoryFileStore } from '../support/memory-file-store';
import { useIndexHost } from './index-helpers';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

function library(): MemoryFileStore {
  return new MemoryFileStore({
    'root.org': note(ID_A, 'Root'),
    'daily/day.org': note(ID_B, 'Day'),
    'daily/deep/older.org': note(ID_C, 'Older'),
    'daily.org': note('00000000-0000-4000-8000-00000000000d', 'Sibling of daily'),
    'daily/day.org.conflict-20260115093000': 'text',
  });
}

describe('index survives loss of access', () => {
  const env = useIndexHost();
  let index: LibraryIndex;
  let store: MemoryFileStore;

  beforeEach(async () => {
    index = await LibraryIndex.open(env.host, 'lib');
    store = library();
    await index.reconcile(store);
  });
  afterEach(() => index.close());

  it('Scenario: Folder access lost — a failed listing removes nothing and reports reconnect', async () => {
    const before = await index.counts();
    store.failOperation('list', { kind: 'access_denied' });

    const result = await index.reconcile(store);

    expect(result.listing).toBe('failed');
    expect(result.listingFailures).toEqual([
      { path: '', failure: expect.objectContaining({ kind: 'access_denied' }) },
    ]);
    expect(result.removed).toEqual([]);
    expect(await index.counts()).toEqual(before);
    expect(await index.resolveLink(ID_B)).toMatchObject({ filePath: 'daily/day.org' });
    expect((await index.search('Older')).map((hit) => hit.filePath)).toEqual(['daily/deep/older.org']);
    expect(await index.conflictCopies()).toHaveLength(1);
  });

  it('recovers once the folder can be listed again', async () => {
    store.failOperation('list', { times: 1 });
    await index.reconcile(store);
    store.remove('root.org');

    const result = await index.reconcile(store);

    expect(result.listing).toBe('complete');
    expect(result.removed).toEqual(['root.org']);
  });

  it('Scenario: One subfolder fails — entries under it are kept and other folders refresh', async () => {
    store.remove('daily/day.org');
    store.remove('daily/deep/older.org');
    store.remove('root.org');
    store.writeFile('new.org', note('00000000-0000-4000-8000-00000000000e', 'New'));
    store.failOperation('list', { path: 'daily' });

    const result = await index.reconcile(store);

    expect(result.listing).toBe('partial');
    expect(result.listingFailures.map((failure) => failure.path)).toEqual(['daily']);
    expect(result.removed).toEqual(['root.org']);
    expect(result.added).toEqual(['new.org']);
    expect(await index.getFile('daily/day.org')).not.toBeNull();
    expect(await index.getFile('daily/deep/older.org')).not.toBeNull();
    expect(await index.conflictCopies()).toHaveLength(1);
  });

  it('a failed folder does not protect a file whose name merely starts the same', async () => {
    store.remove('daily.org');
    store.failOperation('list', { path: 'daily' });

    const result = await index.reconcile(store);

    expect(result.removed).toEqual(['daily.org']);
    expect(await index.getFile('daily/day.org')).not.toBeNull();
  });

  it('a nested failure protects only that folder', async () => {
    store.remove('daily/day.org');
    store.remove('daily/deep/older.org');
    store.failOperation('list', { path: 'daily/deep' });

    const result = await index.reconcile(store);

    expect(result.removed).toEqual(['daily/day.org']);
    expect(await index.getFile('daily/deep/older.org')).not.toBeNull();
  });

  it('removes entries for a folder that a successful listing shows is gone', async () => {
    store.remove('daily');

    const result = await index.reconcile(store);

    expect(result.listing).toBe('complete');
    expect(result.removed.sort()).toEqual(['daily/day.org', 'daily/deep/older.org']);
    expect((await index.listFolder('')).folders).toEqual([]);
    expect(await index.conflictCopies()).toEqual([]);
  });

  it('Scenario: Local copy removed by a provider — entries are kept and it is marked', async () => {
    store.setDownloaded('daily/day.org', false);
    store.calls = [];

    const result = await index.reconcile(store);

    expect(store.calls).toEqual([{ op: 'list' }]);
    expect(result).toMatchObject({ added: [], changed: [], removed: [], downloadsRequested: [] });
    expect(await index.getFile('daily/day.org')).toMatchObject({
      status: 'not_downloaded',
      contentIndexed: true,
      hasNodes: true,
      title: 'Day',
    });
    expect(await index.resolveLink(ID_B)).toMatchObject({ title: 'Day' });
    expect((await index.search('Day')).map((hit) => hit.filePath)).toEqual(['daily/day.org']);
    expect((await index.problems()).notDownloaded).toEqual([
      { path: 'daily/day.org', contentIndexed: true },
    ]);
  });

  it('an evicted file comes back as ok when its content returns unchanged', async () => {
    store.setDownloaded('daily/day.org', false);
    await index.reconcile(store);
    store.setDownloaded('daily/day.org', true);

    await index.reconcile(store);

    expect(await index.getFile('daily/day.org')).toMatchObject({ status: 'ok', contentIndexed: true });
    expect((await index.problems()).notDownloaded).toEqual([]);
  });

  it('an evicted file changed at the provider is requested, and updates when it arrives', async () => {
    store.setDownloaded('daily/day.org', false);
    await index.reconcile(store);
    store.writeFile('daily/day.org', note(ID_B, 'Changed day'), { downloaded: false });

    const pending = await index.reconcile(store);

    expect(pending.downloadsRequested).toEqual(['daily/day.org']);
    expect(await index.resolveLink(ID_B)).toMatchObject({ title: 'Day' });

    store.setDownloaded('daily/day.org', true);
    const arrived = await index.reconcile(store);

    expect(arrived.changed).toEqual(['daily/day.org']);
    expect(await index.resolveLink(ID_B)).toMatchObject({ title: 'Changed day' });
  });

  it('a read failure on a known file keeps its rows, and clears when reads work again', async () => {
    store.writeFile('root.org', note(ID_A, 'Root changed'));
    store.failOperation('readBytes', { path: 'root.org', kind: 'access_denied', times: 1 });

    const failed = await index.reconcile(store);

    expect(failed.readFailures).toEqual([
      { path: 'root.org', failure: expect.objectContaining({ kind: 'access_denied' }) },
    ]);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'Root' });
    expect((await index.problems()).unreadable).toEqual(['root.org']);

    const retried = await index.reconcile(store);

    expect(retried.readFailures).toEqual([]);
    expect(await index.resolveLink(ID_A)).toMatchObject({ title: 'Root changed' });
    expect((await index.problems()).unreadable).toEqual([]);
  });

  it('a file gone between listing and reading is left for the next listing', async () => {
    store.writeFile('root.org', note(ID_A, 'Root changed'));
    store.failOperation('digest', { path: 'root.org', kind: 'not_found', times: 1 });

    const result = await index.reconcile(store);

    expect(result.readFailures).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(await index.getFile('root.org')).toMatchObject({ status: 'ok', title: 'Root' });
  });
});
