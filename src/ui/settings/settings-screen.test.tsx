import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Sharing from 'expo-sharing';
import { unzipSync } from 'fflate';

import type { ExternalLibraryRoot } from '../../core/ports';
import { LibraryProvider } from '../library-context';
import { createTestLibrary, type TestLibrary } from '../test-library';
import { formatSize, SettingsScreen } from './settings-screen';

jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

const mockWritten: Uint8Array[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  File: class {
    uri = 'file:///cache/roamlet-export.zip';
    exists = false;
    delete() {}
    write(bytes: Uint8Array) {
      mockWritten.push(bytes);
    }
  },
}));

const ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID_MISSING = 'ffffffff-0000-4000-8000-000000000009';
const NOTE = (id: string, body = '') => `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: Note\n${body}\n`;
const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });

let library: TestLibrary;

afterEach(async () => {
  await library.dispose();
  mockWritten.length = 0;
  jest.clearAllMocks();
});

async function open(options: Parameters<typeof createTestLibrary>[0] = {}) {
  library = createTestLibrary(options);
  await render(
    <LibraryProvider controller={library.controller}>
      <SettingsScreen />
    </LibraryProvider>,
  );
  await act(() => library.controller.start());
  await settle();
  return library;
}

/** Lets the report's queries finish. */
async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

async function press(name: string | RegExp) {
  await fireEvent.press(screen.getByRole('button', { name }));
  await settle();
}

describe('Library management in Settings', () => {
  it('Scenario: Choosing a folder from Settings', async () => {
    const lib = await open();
    const picked = lib.storeFor(FOLDER);
    picked.writeFile('one.org', NOTE(ID_A));
    picked.writeFile('two.org', NOTE(ID_MISSING));
    const before = picked.paths();

    // Holds the second note's read, so the run can be seen in progress.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = picked.readBytes.bind(picked);
    let reads = 0;
    jest.spyOn(picked, 'readBytes').mockImplementation(async (path) => {
      reads += 1;
      if (reads === 2) await gate;
      return read(path);
    });

    lib.setPick({ status: 'picked', root: FOLDER, writable: true });
    await press('Choose a folder');
    expect(screen.getByText('Indexing: 1 of 2 notes')).toBeTruthy();

    await act(async () => {
      release();
      await lib.controller.refresh();
    });
    await settle();

    expect(screen.queryByText(/^Indexing/)).toBeNull();
    expect(screen.getByText('org-roam')).toBeTruthy();
    const { index } = lib.controller.getSnapshot();
    expect((await index!.listFolder('')).files.map((file) => file.path)).toEqual([
      'one.org',
      'two.org',
    ]);
    expect(picked.paths()).toEqual(before);
    expect(picked.calls.filter(({ op }) => op === 'replaceFile' || op === 'createExclusive')).toEqual(
      [],
    );
  });

  it('Scenario: Picker failure', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A) } });
    const before = lib.controller.getSnapshot();

    lib.setPick({ status: 'picker_failed', message: 'activity' });
    await press('Choose a folder');

    expect(screen.getByText(/couldn’t open\. Restarting the app may fix this/)).toBeTruthy();
    const after = lib.controller.getSnapshot();
    expect(after.store).toBe(before.store);
    expect(after.index).toBe(before.index);
    expect(screen.getByText('Roamlet’s own folder')).toBeTruthy();
  });

  it('Scenario: Provider doesn’t allow folder access', async () => {
    const lib = await open();
    lib.setPick({ status: 'unsupported_provider' });
    await press('Choose a folder');
    expect(screen.getByText(/can’t be used as a library/)).toBeTruthy();
    expect(screen.getByText('Roamlet’s own folder')).toBeTruthy();
  });

  it('Scenario: Restricted Android location', async () => {
    const lib = await open();
    lib.setPick({ status: 'restricted_location' });
    await press('Choose a folder');
    expect(screen.getByText(/Choose a subfolder instead/)).toBeTruthy();
  });

  it('warns that notes in the app-owned folder stay behind before choosing', async () => {
    await open();
    expect(screen.getByText(/Notes in Roamlet’s own folder stay there/)).toBeTruthy();
  });

  it('Scenario: First launch offers the choice of opening an existing folder', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch to Roamlet/ })).toBeNull();
  });

  it('Scenario: Access state shown', async () => {
    const lib = await open({ record: FOLDER_RECORD });
    lib.setRestore({ status: 'revoked' });
    await act(() => lib.controller.recheckAccess());
    await settle();

    expect(screen.getByText('Access lost')).toBeTruthy();
    expect(screen.getByText(/no longer has access to this folder/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect folder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export library' }).props.accessibilityState).toMatchObject(
      { disabled: true },
    );
  });

  it('Scenario: Reconnecting', async () => {
    const lib = await open({ record: FOLDER_RECORD });
    lib.storeFor(FOLDER).writeFile('a.org', NOTE(ID_A));
    await act(() => lib.controller.refresh());
    lib.setRestore({ status: 'revoked' });
    await act(() => lib.controller.recheckAccess());
    await settle();

    const kept = lib.controller.getSnapshot().index;
    expect((await kept!.listFolder('')).files).toHaveLength(1);

    lib.setRestore({ status: 'ok', writable: true });
    lib.setPick({ status: 'picked', root: FOLDER, writable: true });
    await press('Reconnect folder');

    expect(screen.getByText(/Folder reconnected/)).toBeTruthy();
    expect(screen.getByText('Can be read and edited')).toBeTruthy();
    expect(lib.controller.getSnapshot().index).toBe(kept);
  });

  it('Scenario: Read-only location', async () => {
    const lib = await open({ record: FOLDER_RECORD });
    lib.setRestore({ status: 'ok', writable: false });
    await act(() => lib.controller.recheckAccess());
    await settle();
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText(/editing and capture are unavailable/)).toBeTruthy();
  });

  it('Scenario: Switching library', async () => {
    const lib = await open({
      record: FOLDER_RECORD,
      files: { 'own.org': NOTE(ID_A) },
    });
    lib.storeFor(FOLDER).writeFile('theirs.org', NOTE(ID_A));

    await press('Switch to Roamlet’s own folder');
    await act(() => lib.controller.refresh());
    await settle();

    expect(screen.getByText('Roamlet’s own folder')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeTruthy();
    const { index } = lib.controller.getSnapshot();
    expect((await index!.listFolder('')).files.map((file) => file.path)).toEqual(['own.org']);
    expect(lib.storeFor(FOLDER).paths()).toEqual(['theirs.org']);
  });

  it('shows the active library, its access, and how much space its notes use', async () => {
    await open({ files: { 'a.org': 'x'.repeat(2048) } });
    expect(screen.getByText('Roamlet’s own folder')).toBeTruthy();
    expect(screen.getByText('Can be read and edited')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('formats sizes', () => {
    library = createTestLibrary();
    expect(formatSize(12)).toBe('12 bytes');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('Rebuild Index', () => {
  it('rebuilds from the files, showing progress', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A), 'b.org': NOTE(ID_MISSING) } });
    const { deletes } = lib.databases;

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const read = lib.store.readBytes.bind(lib.store);
    let reads = 0;
    jest.spyOn(lib.store, 'readBytes').mockImplementation(async (path) => {
      reads += 1;
      if (reads === 2) await gate;
      return read(path);
    });

    await press('Rebuild Index');
    expect(screen.getByText('Rebuilding the index: 1 of 2 notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rebuild Index' }).props.accessibilityState).toMatchObject(
      { disabled: true },
    );

    await act(async () => release());
    await settle();

    expect(lib.databases.deletes).toBeGreaterThan(deletes);
    expect(screen.getByText('Index rebuilt.')).toBeTruthy();
    expect((await lib.controller.getSnapshot().index!.counts()).files).toBe(2);
  });

  it('says so when folders could not be listed, and keeps the index', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A), 'daily/b.org': NOTE(ID_MISSING) } });
    const { deletes } = lib.databases;
    lib.store.failOperation('list', { path: 'daily' });

    await press('Rebuild Index');

    expect(lib.databases.deletes).toBe(deletes);
    expect(screen.queryByText('Index rebuilt.')).toBeNull();
    expect(screen.getByText(/Some folders couldn’t be listed.*daily/)).toBeTruthy();
    expect((await lib.controller.getSnapshot().index!.counts()).files).toBe(2);
  });
});

describe('Export', () => {
  it('Scenario: Retrieving notes from the app-owned folder', async () => {
    const content = NOTE(ID_A, 'Café 日本語 🦊');
    await open({ files: { 'a.org': content, 'daily/b.org': content, 'image.png': 'not a note' } });

    await press('Export library');

    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      'file:///cache/roamlet-export.zip',
      expect.objectContaining({ mimeType: 'application/zip' }),
    );
    const files = unzipSync(mockWritten[0]);
    expect(Object.keys(files).sort()).toEqual(['a.org', 'daily/b.org']);
    expect(new TextDecoder().decode(files['daily/b.org'])).toBe(content);
    expect(screen.getByText('Archive prepared with 2 files.')).toBeTruthy();
  });

  it('Scenario: Files not on the device', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A), 'cloud.org': NOTE(ID_MISSING) } });
    lib.store.setDownloaded('cloud.org', false);

    await press('Export library');

    expect(Object.keys(unzipSync(mockWritten[0]))).toEqual(['a.org']);
    expect(screen.getByText('Archive prepared with 1 file.')).toBeTruthy();
    expect(screen.getByText(/Left out/)).toBeTruthy();
    expect(screen.getByText('cloud.org')).toBeTruthy();
  });

  it('opens no share sheet when there is nothing to export', async () => {
    await open();
    await press('Export library');
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/nothing on this device to export/)).toBeTruthy();
  });

  it('shows a message when the library cannot be listed', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A) } });
    lib.store.failOperation('list');
    await press('Export library');
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/couldn’t be exported/)).toBeTruthy();
  });

  it('shows a message when the share sheet fails', async () => {
    await open({ files: { 'a.org': NOTE(ID_A) } });
    (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('no activity'));
    await press('Export library');
    expect(screen.getByText(/share sheet didn’t open/)).toBeTruthy();
  });
});

describe('Library statistics and diagnostics', () => {
  it('Scenario: Healthy library', async () => {
    await open({ files: { 'a.org': NOTE(ID_A) } });
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  it('Scenario: Viewing problems', async () => {
    const lib = await open({
      files: {
        'a.org': NOTE(ID_A, `[[id:${ID_MISSING}][gone]]`),
        'copy.sync-conflict-20260115-093000-ABCDEFG.org': NOTE(ID_A),
        'plain.org': '#+title: Plain\n',
        'bad.org': new Uint8Array([0xff, 0xfe]) as unknown as string,
        'cloud.org': NOTE('bbbbbbbb-0000-4000-8000-000000000002'),
        'a.org.conflict-20260115093000': NOTE(ID_A),
      },
    });
    lib.store.setDownloaded('cloud.org', false);
    await act(() => lib.controller.refresh());
    await settle();

    expect(screen.queryByText('No problems found.')).toBeNull();

    const open_ = async (title: string, ...expected: (string | RegExp)[]) => {
      await press(new RegExp(`^${title}: 1$`));
      for (const line of expected) expect(screen.getAllByText(line).length).toBeGreaterThan(0);
    };
    await open_('Duplicate IDs', /^a\.org \(aaaaaaaa/, /^copy\.sync-conflict.*\(aaaaaaaa/);
    await open_('Unresolved links', new RegExp(`^a\\.org \\(${ID_MISSING}\\)$`));
    await open_('Files that aren’t valid UTF-8', 'bad.org');
    await open_('Files not on this device', 'cloud.org');
    await open_('Conflict copies', 'a.org.conflict-20260115093000');
    await press(/^Files without IDs: \d+$/);
    expect(screen.getByText('plain.org')).toBeTruthy();
  });

  it('lists a file that could not be read', async () => {
    const lib = await open({ files: { 'a.org': NOTE(ID_A), 'locked.org': NOTE(ID_MISSING) } });
    lib.store.writeFile('locked.org', NOTE(ID_MISSING, 'changed'));
    lib.store.failOperation('readBytes', { path: 'locked.org' });
    await act(() => lib.controller.refresh());
    await settle();
    await press('Files that couldn’t be read: 1');
    expect(screen.getByText('locked.org')).toBeTruthy();
  });

  it('shows counts of files, nodes, and links, and the last refresh', async () => {
    const lib = await open({
      files: {
        'a.org': NOTE(ID_A, `[[id:${ID_A}][self]]\n[[id:${ID_A}][again]]\n[[id:${ID_A}][more]]`),
        'b.org': NOTE('bbbbbbbb-0000-4000-8000-000000000002'),
        'c.org': NOTE('cccccccc-0000-4000-8000-000000000003'),
        'd.org': NOTE('dddddddd-0000-4000-8000-000000000004'),
        'e.org': '#+title: no id\n',
      },
    });
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    const stamp = lib.services.clock.now().toLocaleString();
    expect(screen.getByText(stamp)).toBeTruthy();
  });
});

describe('Accessibility of reading and writing', () => {
  it('Scenario: Screen reader', async () => {
    const lib = await open({
      record: FOLDER_RECORD,
    });
    lib.storeFor(FOLDER).writeFile('plain.org', '#+title: Plain\n');
    await act(() => lib.controller.refresh());
    await settle();

    for (const name of [
      'Change folder',
      'Switch to Roamlet’s own folder',
      'Export library',
      'Rebuild Index',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    const row = screen.getByRole('button', { name: 'Files without IDs: 1' });
    expect(row.props.accessibilityState).toMatchObject({ expanded: false });
    await press('Files without IDs: 1');
    expect(
      screen.getByRole('button', { name: 'Files without IDs: 1' }).props.accessibilityState,
    ).toMatchObject({ expanded: true });
  });

  it('Scenario: Larger text', async () => {
    await open();
    expect(JSON.stringify(screen.toJSON())).not.toContain('"allowFontScaling":false');
  });
});
