import { act, fireEvent, screen } from 'expo-router/testing-library';

import type { ExternalLibraryRoot } from '../../core/ports';
import { createTestLibrary, type TestLibrary } from '../test-library';
import { note, renderNotesApp } from './test-app';

const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });

let library: TestLibrary;

function setUp(options: Parameters<typeof createTestLibrary>[0] = {}): TestLibrary {
  library = createTestLibrary(options);
  return library;
}

afterEach(async () => {
  await library.dispose();
});

async function open(lib: TestLibrary) {
  const router = await renderNotesApp(lib);
  await act(() => lib.controller.start());
  return router;
}

async function search(text: string) {
  await fireEvent.changeText(screen.getByLabelText('Search notes'), text);
}

describe('Folder tree', () => {
  it('Browsing folders', async () => {
    const lib = setUp({
      files: {
        'daily/2026-01-02.org': note('d1', 'January second'),
        '20260101-idea.org': note('i1', 'idea'),
      },
    });
    const router = await open(lib);

    expect(await screen.findByLabelText('Folder daily')).toBeTruthy();
    expect(screen.getByText('idea')).toBeTruthy();
    expect(screen.getByText('20260101-idea.org')).toBeTruthy();
    expect(screen.queryByText('January second')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Folder daily'));
    expect(await screen.findByText('January second')).toBeTruthy();
    expect(router.getPathname()).toBe('/notes');

    await fireEvent.press(screen.getByLabelText('Folder daily'));
    expect(screen.queryByText('January second')).toBeNull();
  });

  it('Matching the real folder', async () => {
    const lib = setUp({ files: { 'old/a.org': note('a1', 'Moved note') } });
    await open(lib);
    await fireEvent.press(await screen.findByLabelText('Folder old'));
    expect(await screen.findByText('Moved note')).toBeTruthy();

    lib.store.rename('old/a.org', 'new/a.org');
    lib.store.remove('old');
    lib.store.writeFile('added.org', note('b1', 'Added outside'));
    await act(() => lib.controller.foreground());

    expect(await screen.findByLabelText('Folder new')).toBeTruthy();
    expect(screen.queryByLabelText('Folder old')).toBeNull();
    expect(screen.getByText('Added outside')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Folder new'));
    expect(await screen.findByText('Moved note')).toBeTruthy();
  });

  it('Mixed library', async () => {
    const lib = setUp({
      files: {
        'with-id.org': note('w1', 'Has an ID'),
        'no-id.org': '#+title: Has no ID\n\nText.\n',
      },
    });
    lib.store.writeFile('cloud.org', note('c1', 'Elsewhere'), { downloaded: false });
    await open(lib);

    expect(await screen.findByLabelText('Note Has an ID, with-id.org')).toBeTruthy();
    expect(screen.getByLabelText('Note Has no ID, no-id.org, No ID')).toBeTruthy();
    expect(screen.getByLabelText('Note cloud, cloud.org, Not downloaded')).toBeTruthy();
    expect(screen.getByText('No ID')).toBeTruthy();
    expect(screen.getByText('Not downloaded')).toBeTruthy();
  });

  it('hides hidden folders and folders with no notes', async () => {
    const lib = setUp({
      files: { 'a.org': note('a1', 'Visible'), '.git/b.org': note('b1', 'Hidden'), 'empty/x.txt': 'x' },
    });
    await open(lib);

    expect(await screen.findByText('Visible')).toBeTruthy();
    expect(screen.queryByLabelText('Folder .git')).toBeNull();
    expect(screen.queryByLabelText('Folder empty')).toBeNull();
  });

  it('Empty library', async () => {
    const lib = setUp();
    const router = await open(lib);

    expect(await screen.findByText(/Capture a note to start one here, or open a folder/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Open a folder in Settings' }));
    expect(router.getPathname()).toBe('/settings');
  });

  it('does not call a library empty before its first listing ends', async () => {
    const lib = setUp();
    let finishListing = () => {};
    const { list } = lib.store;
    lib.store.list = () =>
      new Promise((resolve) => {
        finishListing = () => resolve(list.call(lib.store));
      });
    await renderNotesApp(lib);
    expect(await screen.findByText('Looking for notes…')).toBeTruthy();
    expect(screen.queryByText(/Capture a note to start/)).toBeNull();

    await act(async () => {
      finishListing();
      await lib.controller.start();
    });
    expect(await screen.findByText(/Capture a note to start/)).toBeTruthy();
  });

  it('Library unavailable', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.storeFor(FOLDER).writeFile('a.org', note('a1', 'Indexed note', 'Findable text'));
    await open(lib);
    expect(await screen.findByText('Indexed note')).toBeTruthy();

    lib.setRestore({ status: 'revoked' });
    await act(() => lib.controller.recheckAccess());

    expect(await screen.findByText(/files can’t be opened until access returns/)).toBeTruthy();
    expect(screen.getByText('Indexed note')).toBeTruthy();

    await search('findable');
    expect(await screen.findByLabelText('Indexed note, a.org')).toBeTruthy();

    lib.setPick({ status: 'picked', root: FOLDER, writable: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Reconnect folder' }));
    await act(() => lib.controller.refresh());
    expect(screen.queryByText(/files can’t be opened/)).toBeNull();
  });

  it('shows why reconnecting failed', async () => {
    const lib = setUp({ record: FOLDER_RECORD });
    lib.setRestore({ status: 'missing' });
    await open(lib);

    lib.setPick({ status: 'picker_failed', message: 'activity' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Reconnect folder' }));
    expect(await screen.findByText(/folder picker couldn’t open/)).toBeTruthy();
  });

  it('opens a note from the tree', async () => {
    const lib = setUp({ files: { 'daily/a b.org': note('a1', 'Spaced', 'Body words.') } });
    const router = await open(lib);

    await fireEvent.press(await screen.findByLabelText('Folder daily'));
    await fireEvent.press(await screen.findByLabelText('Note Spaced, a b.org'));

    expect(await screen.findByText('Body words.')).toBeTruthy();
    expect(router.getPathname()).toBe('/notes/read');
    expect(router.getSearchParams().path).toBe('daily/a b.org');
  });

  it('labels every row for screen readers', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Alpha'), 'sub/b.org': note('b1', 'Beta') } });
    await open(lib);

    const folder = await screen.findByRole('button', { name: 'Folder sub', expanded: false });
    await fireEvent.press(folder);
    expect(await screen.findByRole('button', { name: 'Folder sub', expanded: true })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Note Alpha, a.org' })).toBeTruthy();
  });
});

describe('Search', () => {
  it('Title and body matches', async () => {
    const lib = setUp({
      files: {
        'a-body.org': note('a1', 'Other', 'A word about zebra in the body, zebra zebra zebra.'),
        'b-title.org': note('b1', 'Zebra crossing'),
      },
    });
    await open(lib);
    await screen.findByText('Other');

    await search('zebra');
    const rows = await screen.findAllByRole('button', { name: /(Zebra crossing|Other), / });
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      'Zebra crossing, b-title.org',
      'Other, a-body.org',
    ]);
  });

  it('Heading-level node in results', async () => {
    const lib = setUp({
      files: {
        'project.org': `${note('p1', 'Project')}* Milestones\n:PROPERTIES:\n:ID: h1\n:END:\nText.\n`,
      },
    });
    const router = await open(lib);
    await screen.findByText('Project');

    await search('milestones');
    expect(await screen.findByText('Heading in Project')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: /^Milestones, Heading in Project/ }));
    expect(router.getSearchParams()).toMatchObject({ path: 'project.org', node: 'h1' });
  });

  it('Search while offline', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Alpha', 'Indexed words') } });
    await open(lib);
    await screen.findByText('Alpha');

    // Nothing else is reachable: search has only the index.
    for (const op of ['list', 'readBytes', 'digest', 'requestDownload'] as const) {
      lib.store.failOperation(op);
    }
    lib.store.calls = [];
    await search('indexed');

    expect(await screen.findByLabelText('Alpha, a.org')).toBeTruthy();
    expect(lib.store.calls).toEqual([]);
  });

  it('Diacritics', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Places', 'A small café nearby.') } });
    await open(lib);
    await screen.findByText('Places');

    await search('cafe');
    expect(await screen.findByLabelText('Places, a.org')).toBeTruthy();
  });

  it('CJK text', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Languages', 'これは日本語のノートです。') } });
    await open(lib);
    await screen.findByText('Languages');

    await search('日本語');
    expect(await screen.findByLabelText('Languages, a.org')).toBeTruthy();
  });

  it('No results', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Alpha') } });
    await open(lib);
    await screen.findByText('Alpha');

    await search('nothing-like-this');
    expect(await screen.findByText('No notes match “nothing-like-this”.')).toBeTruthy();
  });

  it('does not match raw IDs', async () => {
    const lib = setUp({ files: { 'a.org': note('uniqueidvalue', 'Alpha') } });
    await open(lib);
    await screen.findByText('Alpha');

    await search('uniqueidvalue');
    expect(await screen.findByText(/No notes match/)).toBeTruthy();
  });

  it('includes files without nodes, and marks those not downloaded', async () => {
    const lib = setUp({ files: { 'plain.org': '#+title: Plain findme\n' } });
    lib.store.writeFile('findme-cloud.org', note('c1', 'x'), { downloaded: false });
    await open(lib);
    await screen.findByText('Plain findme');

    await search('findme');
    expect(await screen.findByLabelText('Plain findme, plain.org')).toBeTruthy();
    expect(screen.getByLabelText('findme-cloud, findme-cloud.org, Not downloaded')).toBeTruthy();
  });

  it('clears back to the tree', async () => {
    const lib = setUp({ files: { 'a.org': note('a1', 'Alpha') } });
    await open(lib);
    await screen.findByText('Alpha');

    await search('zzz');
    await screen.findByText(/No notes match/);
    await fireEvent.press(screen.getByRole('button', { name: 'Clear search' }));

    expect(await screen.findByLabelText('Note Alpha, a.org')).toBeTruthy();
    expect(screen.getByLabelText('Search notes').props.value).toBe('');
  });
});
