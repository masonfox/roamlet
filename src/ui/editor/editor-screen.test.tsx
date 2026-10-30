import { act, fireEvent, screen } from '@testing-library/react-native';
import { router, Stack } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Alert, Text } from 'react-native';

import EditRoute from '../../../app/(tabs)/notes/edit';
import { scan } from '../../core/org';
import type { ExternalLibraryRoot, RecordWriteResult } from '../../core/ports';
import { DraftStore, DraftStoreContext, type DraftKey, type DraftStorage } from '../drafts';
import { LibraryProvider } from '../library-context';
import { createTestLibrary, type TestLibrary } from '../test-library';

const FILE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const HEADING_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_ID = 'cccccccc-0000-4000-8000-000000000003';
const DRAWER = `:PROPERTIES:\n:ID:       ${FILE_ID}\n:END:\n`;
const NOTE = `${DRAWER}#+title: Old title\n\nFirst words here.\n`;
const COMPLEX = `:PROPERTIES:\n:ID:   ${FILE_ID}\n:CUSTOM:  kept\n:END:\n#+TITLE:   Old\n\n* Heading\n:PROPERTIES:\n:ID:       ${HEADING_ID}\n:END:\n| a | b |\n#+begin_src python\nprint( 1 )\n#+end_src\n:CUSTOM:\nthing\n:END:\n`;
const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });

class MemoryDraftStorage implements DraftStorage {
  readonly saved = new Map<string, string>();
  failReads = false;
  private id = (key: DraftKey) => `${key.libraryId}|${key.path}`;

  async read(key: DraftKey) {
    if (this.failReads) {
      return { ok: false as const, failure: { kind: 'provider_error' as const, message: 'x' } };
    }
    return { ok: true as const, text: this.saved.get(this.id(key)) ?? null };
  }
  async write(key: DraftKey, text: string): Promise<RecordWriteResult> {
    this.saved.set(this.id(key), text);
    return { ok: true };
  }
  async remove(key: DraftKey): Promise<RecordWriteResult> {
    this.saved.delete(this.id(key));
    return { ok: true };
  }
}

let library: TestLibrary;
let storage: MemoryDraftStorage;
let drafts: DraftStore;

beforeEach(() => {
  storage = new MemoryDraftStorage();
  drafts = new DraftStore(storage, 0);
});

afterEach(async () => {
  await library.dispose();
  jest.restoreAllMocks();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <DraftStoreContext.Provider value={drafts}>
      <LibraryProvider controller={library.controller}>{children}</LibraryProvider>
    </DraftStoreContext.Provider>
  );
}

/** The real route in a stack over a home screen, as in the app. */
async function openEditor(
  options: Parameters<typeof createTestLibrary>[0] = {},
  path = 'note.org',
  prepare?: (lib: TestLibrary) => void | Promise<void>,
) {
  library = createTestLibrary(options);
  await library.controller.start();
  await prepare?.(library);
  const view = await renderRouter(
    {
      _layout: () => (
        <Providers>
          <Stack />
        </Providers>
      ),
      index: () => <Text>Home</Text>,
      edit: EditRoute,
    },
    { initialUrl: '/' },
  );
  // `renderRouter` turns on fake timers, and the library's work needs real ones.
  jest.useRealTimers();
  await act(async () => router.push({ pathname: '/edit', params: { path } }));
  await settle();
  return view;
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 15)));
}

const bodyField = () => screen.getByLabelText('Note text');
const titleField = () => screen.getByLabelText('Title');
const writes = (lib: TestLibrary) =>
  lib.store.calls.filter(({ op }) => op === 'replaceFile' || op === 'createExclusive');

async function type(field: ReturnType<typeof bodyField>, text: string) {
  await fireEvent.changeText(field, text);
  await settle();
}

async function press(name: string | RegExp) {
  await fireEvent.press(screen.getByRole('button', { name }));
  await settle();
}

function bodyOf(file: string): string {
  return file.slice(scan(file).headerEnd);
}

describe('Plain-text editing', () => {
  it('Scenario: Editing a note with complex syntax', async () => {
    await openEditor({ files: { 'note.org': COMPLEX } });
    expect(titleField().props.value).toBe('Old');
    expect(bodyField().props.value).toBe(bodyOf(COMPLEX));
    expect(bodyField().props.value).toContain(':ID:       ' + HEADING_ID);
    expect(bodyField().props.value).toContain('#+begin_src python');
  });

  it('Scenario: File too large to edit', async () => {
    await openEditor({ files: { 'note.org': 'x'.repeat(512 * 1024 + 1) } });
    expect(screen.queryByLabelText('Note text')).toBeNull();
    expect(screen.getByText(/too large to edit.*still read it/)).toBeTruthy();
  });

  it('opens a file of exactly the size limit', async () => {
    await openEditor({ files: { 'note.org': 'x'.repeat(512 * 1024) } });
    expect(bodyField()).toBeTruthy();
  });

  it('Scenario: Read-only location', async () => {
    await openEditor({ record: FOLDER_RECORD }, 'note.org', async (lib) => {
      lib.storeFor(FOLDER).writeFile('note.org', NOTE);
      lib.setRestore({ status: 'ok', writable: false });
      await lib.controller.recheckAccess();
    });
    expect(screen.queryByLabelText('Note text')).toBeNull();
    expect(screen.getByText(/can’t be written to, so editing is unavailable/)).toBeTruthy();
  });

  it('Scenario: Invalid UTF-8', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41]);
    await openEditor({}, 'note.org', (lib) => lib.store.writeFile('note.org', bytes));
    expect(screen.queryByLabelText('Note text')).toBeNull();
    expect(screen.getByText(/isn’t valid UTF-8/)).toBeTruthy();
    expect(library.store.peek('note.org')).toEqual(bytes);
  });

  it('Scenario: Provider rejects a save', async () => {
    const lib = await openAndEdit();
    lib.store.failOperation('replaceFile');
    await press('Save');

    expect(screen.getByText(/Your changes weren’t saved/)).toBeTruthy();
    expect(bodyField().props.value).toContain('Changed');
    expect(lib.store.peekText('note.org')).toBe(NOTE);
    expect(storage.saved.size).toBe(1);
  });

  it('Scenario: Provider rejects a save when access is lost while editing', async () => {
    await openEditor({ record: FOLDER_RECORD }, 'note.org', (lib) =>
      lib.storeFor(FOLDER).writeFile('note.org', NOTE),
    );
    await type(bodyField(), 'My lasting words.\n');

    const store = library.storeFor(FOLDER);
    store.failOperation('replaceFile', { kind: 'access_denied' });
    library.setRestore({ status: 'revoked' });
    await press('Save');

    expect(screen.getByText(/Your text is kept here as a draft/)).toBeTruthy();
    expect(bodyField().props.value).toBe('My lasting words.\n');
    expect(store.peekText('note.org')).toBe(NOTE);
    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('Scenario: Reconnecting keeps the unsaved text, and it can then be saved', async () => {
    await openEditor({ record: FOLDER_RECORD }, 'note.org', (lib) =>
      lib.storeFor(FOLDER).writeFile('note.org', NOTE),
    );
    await type(bodyField(), 'Still here.\n');

    library.setRestore({ status: 'revoked' });
    await act(() => library.controller.recheckAccess());
    await settle();
    expect(bodyField().props.value).toBe('Still here.\n');

    library.setRestore({ status: 'ok', writable: true });
    library.setPick({ status: 'picked', root: FOLDER, writable: true });
    await act(async () => void (await library.controller.chooseFolder()));
    await settle();
    expect(bodyField().props.value).toBe('Still here.\n');

    await press('Save');
    expect(library.storeFor(FOLDER).peekText('note.org')).toBe(
      `${DRAWER}#+title: Old title\nStill here.\n`,
    );
  });

  it('does not save into another library after a switch', async () => {
    await openEditor({ record: FOLDER_RECORD, files: { 'note.org': 'other library\n' } }, 'note.org', (lib) =>
      lib.storeFor(FOLDER).writeFile('note.org', NOTE),
    );
    await type(bodyField(), 'For the folder.\n');

    await act(async () => void (await library.controller.switchToAppOwnedFolder()));
    await settle();

    expect(screen.getByText(/no longer active/)).toBeTruthy();
    expect(bodyField().props.value).toBe('For the folder.\n');
    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(library.store.peekText('note.org')).toBe('other library\n');
  });

  it('explains a note that cannot be opened and can try again', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', (lib) =>
      lib.store.failOperation('digest', { times: 1 }),
    );
    expect(screen.getByText(/couldn’t be opened/)).toBeTruthy();
    await press('Try again');
    expect(bodyField()).toBeTruthy();
  });

  it('Scenario: Opening an undownloaded note asks for it to be downloaded', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', (lib) =>
      lib.store.setDownloaded('note.org', false),
    );
    expect(screen.getByText(/isn’t on this device yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Note text')).toBeNull();
    expect(library.store.calls).toContainEqual({ op: 'requestDownload', path: 'note.org' });
  });
});

async function openAndEdit(file = NOTE, next = 'Changed words here.\n') {
  await openEditor({ files: { 'note.org': file } });
  await type(bodyField(), next);
  return library;
}

describe('Non-destructive save', () => {
  it('Scenario: Body edit', async () => {
    const lib = await openEditor({ files: { 'note.org': COMPLEX } }).then(() => library);
    await type(bodyField(), bodyField().props.value.replace('print( 1 )', 'print( 2 )'));
    await press('Save');

    expect(lib.store.peekText('note.org')).toBe(COMPLEX.replace('print( 1 )', 'print( 2 )'));
    expect(screen.getByText('Saved.')).toBeTruthy();
    expect(writes(lib)).toHaveLength(1);
  });

  it('Scenario: Title edit', async () => {
    await openEditor({ files: { 'note.org': COMPLEX } });
    await type(titleField(), 'New');
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(COMPLEX.replace('#+TITLE:   Old', '#+TITLE:   New'));
    expect(library.store.paths()).toEqual(['note.org']);
  });

  it('saves the body before the title, so both edits land', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    await type(titleField(), 'New title');
    await type(bodyField(), 'New body.\n');
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(`${DRAWER}#+title: New title\nNew body.\n`);
  });

  it('Scenario: Save without changes', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    await press('Save');
    expect(writes(library)).toEqual([]);
    expect(screen.getByText('No changes to save.')).toBeTruthy();
  });

  it('does not write when a typed change is undone before saving', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    const original = bodyField().props.value;
    await type(bodyField(), 'Something else');
    await type(bodyField(), original);
    await press('Save');
    expect(writes(library)).toEqual([]);
    expect(storage.saved.size).toBe(0);
  });

  it('does not write for a title that differs only in surrounding space', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    await type(titleField(), '  Old title ');
    await press('Save');
    expect(writes(library)).toEqual([]);
    expect(titleField().props.value).toBe('Old title');
  });

  it('Scenario: CRLF file', async () => {
    const crlf = NOTE.replace(/\n/g, '\r\n');
    await openEditor({ files: { 'note.org': crlf } });
    expect(bodyField().props.value).not.toContain('\r');

    await type(bodyField(), '\nFirst words here.\nA new line.\n');
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(crlf.replace(
      'First words here.\r\n',
      'First words here.\r\nA new line.\r\n',
    ));
  });

  it('Scenario: Mixed line endings', async () => {
    const mixed = `${DRAWER}#+title: T\n\none\r\ntwo\nthree\r\n`;
    await openEditor({ files: { 'note.org': mixed } });
    await type(bodyField(), bodyField().props.value.replace('two', 'TWO'));
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(mixed.replace('two', 'TWO'));
  });

  it('keeps a byte order mark and everything else when the body changes', async () => {
    const withBom = `﻿${NOTE}`;
    await openEditor({ files: { 'note.org': withBom } });
    await type(bodyField(), bodyField().props.value.replace('First', 'Last'));
    await press('Save');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(library.store.peek('note.org'))).toBe(
      withBom.replace('First', 'Last'),
    );
  });

  it('Scenario: Title added to a file without one', async () => {
    const file = `${DRAWER}Body text.\n`;
    await openEditor({ files: { 'note.org': file } });
    await type(titleField(), 'Added');
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(`${DRAWER}#+title: Added\nBody text.\n`);
  });

  it('Scenario: Unicode content', async () => {
    const file = `${DRAWER}#+title: Café\n\n日本語 🦊 text\n`;
    await openEditor({ files: { 'note.org': file } });
    await type(bodyField(), bodyField().props.value.replace('text', 'テキスト 🦊'));
    await press('Save');
    expect(library.store.peekText('note.org')).toBe(file.replace('text', 'テキスト 🦊'));
  });

  it('Scenario: Files in subfolders', async () => {
    await openEditor({ files: { 'daily/2026-01-02.org': NOTE } }, 'daily/2026-01-02.org');
    await type(bodyField(), 'Daily.\n');
    await press('Save');
    expect(library.store.peekText('daily/2026-01-02.org')).toContain('Daily.');
  });

  it('updates the index and can save again from the new version', async () => {
    const lib = await openAndEdit(`${DRAWER}#+title: Old title\n\nFirst words here.\n`, 'findable-word\n');
    await press('Save');
    await act(() => lib.controller.refresh());

    const results = await lib.controller.getSnapshot().index!.search('findable');
    expect(results[0]).toMatchObject({ filePath: 'note.org' });

    await type(bodyField(), 'second-version\n');
    await press('Save');
    expect(lib.store.peekText('note.org')).toContain('second-version');
    expect(writes(lib)).toHaveLength(2);
    expect(storage.saved.size).toBe(0);
  });
});

describe('ID protection during editing', () => {
  const HEADING = `#+title: T\n\n* Section\n:PROPERTIES:\n:ID:       ${HEADING_ID}\n:END:\nText.\n`;

  it('Scenario: Heading ID removed', async () => {
    await openEditor({ files: { 'note.org': HEADING } });
    await type(bodyField(), '* Section\nText.\n');
    await press('Save');

    expect(screen.getByText(/will no longer exist as a node/)).toBeTruthy();
    expect(writes(library)).toEqual([]);

    await press('Save anyway');
    expect(writes(library)).toHaveLength(1);
    expect(library.store.peekText('note.org')).toBe('#+title: T\n* Section\nText.\n');
  });

  it('returns to editing without saving, with the text kept', async () => {
    await openEditor({ files: { 'note.org': HEADING } });
    await type(bodyField(), '* Section\nText.\n');
    await press('Save');
    await press('Back to editing');

    expect(screen.queryByText(/will no longer exist/)).toBeNull();
    expect(bodyField().props.value).toBe('* Section\nText.\n');
    expect(writes(library)).toEqual([]);
    expect(library.store.peekText('note.org')).toBe(HEADING);
  });

  it('warns about a changed ID', async () => {
    await openEditor({ files: { 'note.org': HEADING } });
    await type(bodyField(), bodyField().props.value.replace(HEADING_ID, OTHER_ID));
    await press('Save');
    expect(screen.getByText(/will change ID/)).toBeTruthy();
    expect(writes(library)).toEqual([]);
  });

  it('warns about an ID already used by another file', async () => {
    const other = `:PROPERTIES:\n:ID:       ${OTHER_ID}\n:END:\n#+title: Other\n`;
    await openEditor({ files: { 'note.org': NOTE, 'other.org': other } });
    const added = `* New\n:PROPERTIES:\n:ID:       ${OTHER_ID}\n:END:\n`;
    await type(bodyField(), bodyField().props.value + added);
    await press('Save');
    expect(screen.getByText(/already in use/)).toBeTruthy();
    expect(writes(library)).toEqual([]);
  });

  it('Scenario: Editing a note without an ID', async () => {
    const file = '#+title: Plain\n\nWords.\n';
    await openEditor({ files: { 'note.org': file } });
    await type(bodyField(), '\nOther words.\n');
    await press('Save');
    expect(screen.queryByText(/no longer exist/)).toBeNull();
    expect(library.store.peekText('note.org')).toBe('#+title: Plain\n\nOther words.\n');
  });

  it('Scenario: Files without IDs', async () => {
    const file = 'Just text with no header.\n';
    await openEditor({ files: { 'note.org': file } });
    await type(bodyField(), 'Changed text.\n');
    await press('Save');
    expect(library.store.peekText('note.org')).toBe('Changed text.\n');
  });
});

describe('Stale edit protection', () => {
  const CHANGED = `${DRAWER}#+title: Old title\n\nChanged by sync.\n`;

  it('Scenario: External change during editing', async () => {
    const lib = await openAndEdit();
    lib.store.writeFile('note.org', CHANGED);
    await press('Save');

    expect(lib.store.peekText('note.org')).toBe(CHANGED);
    expect(bodyField().props.value).toBe('Changed words here.\n');
    expect(screen.getByRole('button', { name: 'Reload the file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save my text as a conflict copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('reloads the file after confirmation', async () => {
    const lib = await openAndEdit();
    lib.store.writeFile('note.org', CHANGED);
    await press('Save');

    const alert = jest.spyOn(Alert, 'alert');
    await press('Reload the file');
    expect(bodyField().props.value).toBe('Changed words here.\n');
    const buttons = alert.mock.calls[0][2]!;
    await act(async () => buttons.find((button) => button.text === 'Reload')!.onPress!());
    await settle();

    expect(bodyField().props.value).toBe('\nChanged by sync.\n');
    expect(screen.queryByRole('button', { name: 'Reload the file' })).toBeNull();
    expect(storage.saved.size).toBe(0);

    await type(bodyField(), '\nNow my edit.\n');
    await press('Save');
    expect(lib.store.peekText('note.org')).toBe(`${DRAWER}#+title: Old title\n\nNow my edit.\n`);
  });

  it('Scenario: Saving a conflict copy', async () => {
    const lib = await openAndEdit();
    lib.store.writeFile('note.org', CHANGED);
    await press('Save');
    await press('Save my text as a conflict copy');
    await act(() => lib.controller.refresh());
    await settle();

    const copy = lib.store.paths().find((path) => path.includes('.conflict-'))!;
    expect(copy).toMatch(/^note\.org\.conflict-\d{14}$/);
    expect(lib.store.peekText(copy)).toBe(`${DRAWER}#+title: Old title\nChanged words here.\n`);
    expect(lib.store.peekText('note.org')).toBe(CHANGED);
    expect(screen.getByText(new RegExp(`saved as ${copy.replace(/\./g, '\\.')}`))).toBeTruthy();
    expect(bodyField().props.value).toBe('\nChanged by sync.\n');
    expect(storage.saved.size).toBe(0);

    const copies = await lib.controller.getSnapshot().index!.conflictCopies();
    expect(copies.map((listed) => listed.path)).toEqual([copy]);
  });

  it('keeps the text when the conflict copy fails', async () => {
    const lib = await openAndEdit();
    lib.store.writeFile('note.org', CHANGED);
    await press('Save');
    lib.store.failOperation('createExclusive');
    await press('Save my text as a conflict copy');

    expect(screen.getByText(/conflict copy wasn’t saved/)).toBeTruthy();
    expect(bodyField().props.value).toBe('Changed words here.\n');
    expect(screen.getByRole('button', { name: 'Reload the file' })).toBeTruthy();
  });

  it('treats a draft edited from an older file as stale', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', async (lib) => {
      storage.saved.set(
        'app-owned|note.org',
        JSON.stringify({ version: 1, title: 'Old title', body: 'From the draft.\n', baseHash: 'older' }),
      );
      lib.store.writeFile('note.org', CHANGED);
    });

    expect(bodyField().props.value).toBe('From the draft.\n');
    expect(screen.getByRole('button', { name: 'Reload the file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(library.store.peekText('note.org')).toBe(CHANGED);
  });

  it('keeps a restored draft stale through further typing and a restart', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', async (lib) => {
      storage.saved.set(
        'app-owned|note.org',
        JSON.stringify({ version: 1, title: 'Old title', body: 'From the draft.\n', baseHash: 'older' }),
      );
      lib.store.writeFile('note.org', CHANGED);
    });

    await type(bodyField(), 'From the draft, with more.\n');
    await act(() => drafts.flush());

    expect(JSON.parse(storage.saved.get('app-owned|note.org')!).baseHash).toBe('older');
    expect(screen.getByRole('button', { name: 'Reload the file' })).toBeTruthy();
  });
});

describe('Draft preservation', () => {
  it('keeps edit text as a draft, restored after the app is terminated', async () => {
    await openAndEdit();
    await act(() => drafts.flush());
    const saved = JSON.parse(storage.saved.get('app-owned|note.org')!);
    expect(saved).toMatchObject({ title: 'Old title', body: 'Changed words here.\n' });

    expect(library.store.peekText('note.org')).toBe(NOTE);
  });

  it('restores a draft when the note opens', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', async (lib) => {
      const { hash } = (await lib.store.digest('note.org')) as { hash: string };
      storage.saved.set(
        'app-owned|note.org',
        JSON.stringify({ version: 1, title: 'Draft title', body: 'Draft body.\n', baseHash: hash }),
      );
    });
    expect(titleField().props.value).toBe('Draft title');
    expect(bodyField().props.value).toBe('Draft body.\n');
    expect(screen.queryByRole('button', { name: 'Reload the file' })).toBeNull();

    await press('Save');
    expect(library.store.peekText('note.org')).toBe(`${DRAWER}#+title: Draft title\nDraft body.\n`);
    expect(storage.saved.size).toBe(0);
  });

  it('does not overwrite a draft it could not read', async () => {
    await openEditor({ files: { 'note.org': NOTE } }, 'note.org', () => {
      storage.saved.set('app-owned|note.org', 'unreadable for now');
      storage.failReads = true;
    });
    expect(screen.getByText(/couldn’t read your saved draft/)).toBeTruthy();
    expect(screen.queryByLabelText('Note text')).toBeNull();

    storage.failReads = false;
    await press('Try again');
    expect(bodyField().props.value).toBe(bodyOf(NOTE));
  });

  it('Scenario: Discarding an edit', async () => {
    await openAndEdit();
    const alert = jest.spyOn(Alert, 'alert');

    await act(async () => router.back());
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Note text')).toBeTruthy();

    // Keeping leaves everything as it was.
    const buttons = alert.mock.calls[0][2]!;
    expect(buttons.map((button) => button.text)).toEqual(['Keep editing', 'Discard']);
    expect(bodyField().props.value).toBe('Changed words here.\n');

    await act(async () => buttons.find((button) => button.text === 'Discard')!.onPress!());
    await settle();
    expect(screen.getByText('Home')).toBeTruthy();
    expect(storage.saved.size).toBe(0);
    expect(library.store.peekText('note.org')).toBe(NOTE);
  });

  it('leaves without asking when nothing changed', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    const alert = jest.spyOn(Alert, 'alert');
    await act(async () => router.back());
    await settle();
    expect(alert).not.toHaveBeenCalled();
    expect(screen.getByText('Home')).toBeTruthy();
  });

  it('leaves without asking after a save', async () => {
    await openAndEdit();
    await press('Save');
    const alert = jest.spyOn(Alert, 'alert');
    await act(async () => router.back());
    await settle();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('Link insertion', () => {
  const TARGET = `:PROPERTIES:\n:ID:       ${OTHER_ID}\n:END:\n#+title: Target [draft]]\n`;
  const SECTION = `#+title: Plan\n* Target heading\n:PROPERTIES:\n:ID:       ${HEADING_ID}\n:END:\n`;

  async function pick(query: string, name: RegExp) {
    await press('Insert link');
    await fireEvent.changeText(screen.getByLabelText('Search for a note to link to'), query);
    await settle();
    await press(name);
  }

  it('Scenario: Insert a link', async () => {
    await openEditor({ files: { 'note.org': NOTE, 'target.org': TARGET } });
    const body = bodyField().props.value as string;
    const at = body.indexOf('words');
    await fireEvent(bodyField(), 'selectionChange', {
      nativeEvent: { selection: { start: at, end: at } },
    });

    await pick('Target', /^Link to Target/);

    const value = bodyField().props.value as string;
    expect(value.slice(0, at)).toBe(body.slice(0, at));
    expect(value).toContain(`[[id:${OTHER_ID}][`);
    expect(value.endsWith(body.slice(at))).toBe(true);

    await press('Save');
    const { links } = scan(library.store.peekText('note.org')!);
    expect(links.map((link) => link.target)).toContain(OTHER_ID);

    // It resolves in the app, and the target shows the note as a backlink.
    await act(() => library.controller.refresh());
    const { index } = library.controller.getSnapshot();
    expect(await index!.resolveLink(OTHER_ID)).toMatchObject({ filePath: 'target.org' });
    const backlinks = await index!.backlinks(OTHER_ID);
    expect(backlinks.map((backlink) => backlink.source.filePath)).toEqual(['note.org']);
  });

  it('Scenario: Link to a heading-level node', async () => {
    await openEditor({ files: { 'note.org': NOTE, 'plan.org': SECTION } });
    await pick('Target', /^Link to Target heading/);
    expect(bodyField().props.value).toContain(`[[id:${HEADING_ID}][Target heading]]`);
  });

  it('Scenario: Title containing brackets', async () => {
    await openEditor({ files: { 'note.org': NOTE, 'target.org': TARGET } });
    await pick('Target', /^Link to Target/);
    await press('Save');

    const link = scan(library.store.peekText('note.org')!).links.find(
      (found) => found.target === OTHER_ID,
    );
    expect(link).toBeDefined();
    expect(link!.description).toContain('Target [draft]');
  });
});

describe('Accessibility of reading and writing', () => {
  it('Scenario: Screen reader', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    expect(titleField()).toBeTruthy();
    expect(bodyField()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert link' })).toBeTruthy();
  });

  it('Scenario: Larger text', async () => {
    await openEditor({ files: { 'note.org': NOTE } });
    expect(bodyField().props.allowFontScaling).not.toBe(false);
    expect(titleField().props.allowFontScaling).not.toBe(false);
  });
});
