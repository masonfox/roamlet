import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, AppState, type AppStateStatus } from 'react-native';

import { decodeUtf8 } from '../../core/library';
import { renderNewNote, scan } from '../../core/org';
import type { ExternalLibraryRoot, RecordWriteResult } from '../../core/ports';
import {
  CAPTURE_DRAFT_PATH,
  DraftStore,
  DraftStoreContext,
  type DraftKey,
  type DraftStorage,
} from '../drafts';
import { LibraryProvider } from '../library-context';
import { createTestLibrary, type TestLibrary } from '../test-library';
import { CaptureScreen } from './capture-screen';

const FOLDER: ExternalLibraryRoot = {
  kind: 'external',
  id: 'folder-1',
  name: 'org-roam',
  reference: 'bookmark-1',
};
const FOLDER_RECORD = JSON.stringify({ version: 1, root: FOLDER });
const LINK_TARGET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LINK_TARGET = `:PROPERTIES:\n:ID:       ${LINK_TARGET_ID}\n:END:\n#+title: Target note\n`;
const HEADING_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const HEADINGS = `#+title: Plan\n* Target heading\n:PROPERTIES:\n:ID:       ${HEADING_ID}\n:END:\n`;

class MemoryDraftStorage implements DraftStorage {
  readonly saved = new Map<string, string>();
  failReads = false;
  failWrites = false;
  private id = (key: DraftKey) => `${key.libraryId}|${key.path}`;

  async read(key: DraftKey) {
    if (this.failReads) {
      return { ok: false as const, failure: { kind: 'provider_error' as const, message: 'x' } };
    }
    return { ok: true as const, text: this.saved.get(this.id(key)) ?? null };
  }
  async write(key: DraftKey, text: string): Promise<RecordWriteResult> {
    if (this.failWrites) return { ok: false, failure: { kind: 'provider_error', message: 'x' } };
    this.saved.set(this.id(key), text);
    return { ok: true };
  }
  async remove(key: DraftKey): Promise<RecordWriteResult> {
    this.saved.delete(this.id(key));
    return { ok: true };
  }
}

let library: TestLibrary | null = null;
let storage: MemoryDraftStorage;

beforeEach(() => {
  storage = new MemoryDraftStorage();
});

afterEach(async () => {
  await library?.dispose();
  library = null;
  jest.restoreAllMocks();
});

const appDraftKey = `app-owned|${CAPTURE_DRAFT_PATH}`;

async function open(
  options: Parameters<typeof createTestLibrary>[0] = {},
  prepare: (lib: TestLibrary) => void = () => undefined,
) {
  library = createTestLibrary(options);
  prepare(library);
  await library.controller.start();
  return renderCapture(library);
}

/** Each call is a fresh launch of the UI, with a new draft store over the same storage. */
async function renderCapture(lib: TestLibrary, drafts = new DraftStore(storage, 5)) {
  const view = await render(
    <DraftStoreContext.Provider value={drafts}>
      <LibraryProvider controller={lib.controller}>
        <CaptureScreen />
      </LibraryProvider>
    </DraftStoreContext.Provider>,
  );
  await waitForEditable();
  return { view, drafts };
}

function input() {
  return screen.getByLabelText('Capture text');
}

async function waitForEditable() {
  await waitFor(() => expect(input().props.editable).toBe(true));
}

async function type(text: string) {
  await fireEvent.changeText(input(), text);
}

function saveButton() {
  return screen.getByRole('button', { name: 'Save' });
}

async function pressSave() {
  await fireEvent.press(saveButton());
  await waitFor(() => expect(input().props.value).toBe(''));
}

/** The only `.org` file in a store that isn't one of `except`. */
function newFile(lib: TestLibrary, except: string[] = []) {
  const paths = lib.store.paths().filter((path) => !except.includes(path));
  expect(paths).toHaveLength(1);
  return { path: paths[0], text: lib.store.peekText(paths[0]) as string };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Quick capture', () => {
  it('One-line capture: the note has that title and an empty body', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Buy a better notebook');
    await pressSave();

    const { text } = newFile(lib);
    const doc = scan(text);
    expect(doc.title).toBe('Buy a better notebook');
    expect(text).toMatch(/#\+title: Buy a better notebook\n$/);
  });

  it('Multi-line capture: the first line is the title and the rest the body', async () => {
    await open();
    await type('\n  \nFirst line\nSecond line\n\nThird line\n');
    await pressSave();

    const { text } = newFile(library as TestLibrary);
    expect(text).toContain('#+title: First line\n');
    expect(text.endsWith('\n\nSecond line\n\nThird line\n')).toBe(true);
  });

  it('Long first line: the title is shortened and the body has the full text', async () => {
    await open();
    const line = `${'word '.repeat(30)}end`;
    await type(line);
    await pressSave();

    const { text } = newFile(library as TestLibrary);
    const title = scan(text).title;
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(line.startsWith(title)).toBe(true);
    expect(title.length).toBeLessThan(line.length);
    expect(text).toContain(`\n\n${line}\n`);
  });

  it.each(['', '   ', ' \n\t\n '])('Empty capture: saving is unavailable for %j', async (empty) => {
    const lib = (await open(), library as TestLibrary);
    await type(empty);
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(saveButton());
    expect(lib.store.paths()).toEqual([]);
  });
});

describe('New note format', () => {
  it('Generated file content: valid ID, title line, slugged file name, LF, trailing newline', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Café Notes!');
    await pressSave();

    const { path, text } = newFile(lib);
    expect(path).toMatch(/^\d{14}-cafe_notes\.org$/);
    expect(path).not.toContain('/');
    expect(text).toBe(
      ':PROPERTIES:\n:ID:       00000000-0000-4000-8000-000000000000\n:END:\n#+title: Café Notes!\n',
    );
    expect(scan(text).nodes[0]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000000',
      level: 0,
      title: 'Café Notes!',
    });
  });

  it('Title with no usable slug characters: the file name uses a placeholder slug', async () => {
    await open();
    await type('!!! ???');
    await pressSave();
    expect(newFile(library as TestLibrary).path).toMatch(/^\d{14}-untitled\.org$/);
  });

  it('Filename collision: picks a different name and leaves the existing file unchanged', async () => {
    library = createTestLibrary();
    const taken = renderNewNote(
      'Same title',
      library.services.ids,
      library.services.clock,
    )!.fileName;
    library.store.writeFile(taken, 'existing bytes');
    await library.controller.start();
    await renderCapture(library);

    await type('Same title');
    await pressSave();

    expect(library.store.peekText(taken)).toBe('existing bytes');
    const created = newFile(library, [taken]);
    expect(created.path).not.toBe(taken);
    expect(created.text).toContain('#+title: Same title\n');
  });

  it('Capture to a chosen folder: the note is written in that folder’s root', async () => {
    const lib = (await open({ record: FOLDER_RECORD }), library as TestLibrary);
    await type('In my folder');
    await pressSave();

    const folder = lib.storeFor(FOLDER);
    expect(folder.paths()).toHaveLength(1);
    expect(folder.paths()[0]).toMatch(/^\d{14}-in_my_folder\.org$/);
    expect(lib.store.paths()).toEqual([]);
  });

  describe('Capture when the library can’t be written', () => {
    it('read-only: keeps the draft, explains, and writes nothing', async () => {
      await open({}, (lib) => lib.setRestore({ status: 'ok', writable: false }));
      await type('Kept text');

      expect(
        screen.getByText(/can’t be written to.*Your text is kept here as a draft\./),
      ).toBeTruthy();
      expect(saveButton().props.accessibilityState.disabled).toBe(true);
      await fireEvent.press(saveButton());
      await act(() => wait(30));

      expect(input().props.value).toBe('Kept text');
      expect(storage.saved.get(appDraftKey)).toBe('Kept text');
      expect((library as TestLibrary).store.paths()).toEqual([]);
    });

    it('unavailable: keeps the draft, explains, and restores it once reconnected', async () => {
      await open({ record: FOLDER_RECORD }, (lib) => lib.setRestore({ status: 'revoked' }));
      await type('Kept while revoked');

      expect(
        screen.getByText(/no longer has access.*Your text is kept here as a draft\./),
      ).toBeTruthy();
      expect(saveButton().props.accessibilityState.disabled).toBe(true);
      await act(() => wait(30));
      expect(storage.saved.get(`folder-1|${CAPTURE_DRAFT_PATH}`)).toBe('Kept while revoked');

      const lib = library as TestLibrary;
      lib.setRestore({ status: 'ok', writable: true });
      await act(() => lib.controller.recheckAccess());
      await waitFor(() => expect(saveButton().props.accessibilityState.disabled).toBe(false));
      expect(input().props.value).toBe('Kept while revoked');
      await pressSave();
      expect(lib.storeFor(FOLDER).paths()).toHaveLength(1);
    });

    it('a provider refusal keeps the text and draft, shows why, and rechecks access', async () => {
      const lib = (await open(), library as TestLibrary);
      await type('Refused text');
      lib.store.failOperation('createExclusive', { kind: 'access_denied' });
      lib.setRestore({ status: 'revoked' });

      await fireEvent.press(saveButton());

      await waitFor(() => expect(lib.controller.getSnapshot().state.status).toBe('unavailable'));
      expect(input().props.value).toBe('Refused text');
      expect(lib.store.paths()).toEqual([]);
      await act(() => wait(30));
      expect(storage.saved.get(appDraftKey)).toBe('Refused text');
    });

    it('a failed save explains why and can be tried again', async () => {
      const lib = (await open(), library as TestLibrary);
      await type('Try twice');
      lib.store.failOperation('createExclusive', { kind: 'provider_error' });

      await fireEvent.press(saveButton());
      expect(await screen.findByText(/This note wasn’t saved\. The storage provider/)).toBeTruthy();
      expect(input().props.value).toBe('Try twice');

      lib.store.clearFaults();
      await pressSave();
      expect(lib.store.paths()).toHaveLength(1);
      expect(screen.queryByText(/This note wasn’t saved/)).toBeNull();
    });

    it('a store that rejects doesn’t lose the text', async () => {
      const lib = (await open(), library as TestLibrary);
      await type('Bug proof');
      jest.spyOn(lib.controller.getSnapshot().store!, 'list').mockRejectedValue(new Error('bug'));

      await fireEvent.press(saveButton());
      expect(await screen.findByText(/your text is still here/)).toBeTruthy();
      expect(input().props.value).toBe('Bug proof');
    });
  });
});

describe('Index update', () => {
  it('a captured note appears at once in the tree and in search', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Findable thought\nWith searchable body');
    await pressSave();

    const created = newFile(lib).path;
    await waitFor(async () => {
      const { index } = lib.controller.getSnapshot();
      const listing = await index!.listFolder('');
      expect(listing.files.map((file) => file.path)).toEqual([created]);
    });
    const { index } = lib.controller.getSnapshot();
    const [hit] = await index!.search('searchable');
    expect(hit).toMatchObject({ filePath: created, title: 'Findable thought' });
    expect(hit.nodeId).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('Draft preservation', () => {
  it('App terminated during capture: the text is restored in Capture', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Half a thought');
    await act(() => wait(30));
    // Nothing runs on a kill: no flush, no unmount. A new store sees only what reached storage.
    await screen.unmount();

    await renderCapture(lib);
    expect(input().props.value).toBe('Half a thought');
  });

  it('leaving the foreground writes the draft straight away, within the typing pause', async () => {
    // The library provider listens too.
    const listeners: ((next: AppStateStatus) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      listeners.push(listener);
      return { remove: () => undefined } as never;
    });
    library = createTestLibrary();
    await library.controller.start();
    await renderCapture(library, new DraftStore(storage, 60_000));

    await type('Just typed');
    expect(storage.saved.size).toBe(0);
    await act(async () => {
      for (const listener of listeners) listener('background');
      await wait(10);
    });
    expect(storage.saved.get(appDraftKey)).toBe('Just typed');
  });

  it('saving clears the draft, so a later launch starts empty', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Finished thought');
    await act(() => wait(30));
    await pressSave();
    await waitFor(() => expect(storage.saved.size).toBe(0));
    await screen.unmount();

    await renderCapture(lib);
    expect(input().props.value).toBe('');
  });

  it('clearing the text removes the draft', async () => {
    await open();
    await type('Gone soon');
    await act(() => wait(30));
    await type('');
    await act(() => wait(30));
    expect(storage.saved.size).toBe(0);
  });

  it('discarding needs confirmation, and cancelling keeps the text', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await open();
    await type('Do I keep this?');
    await act(() => wait(30));

    await fireEvent.press(screen.getByRole('button', { name: 'Discard' }));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe('Do I keep this?');
    expect(storage.saved.get(appDraftKey)).toBe('Do I keep this?');

    const buttons = alert.mock.calls[0][2]!;
    expect(buttons.find((button) => button.style === 'cancel')?.onPress).toBeUndefined();

    await act(async () => {
      buttons.find((button) => button.style === 'destructive')!.onPress!();
      await wait(10);
    });
    expect(input().props.value).toBe('');
    expect(storage.saved.size).toBe(0);
    expect((library as TestLibrary).store.paths()).toEqual([]);
  });

  it('has nothing to discard when empty', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Discard' }).props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('warns when the draft can’t be written, and still saves', async () => {
    await open();
    storage.failWrites = true;
    await type('Unkept');
    expect(await screen.findByText(/couldn’t be kept as a draft/)).toBeTruthy();

    await pressSave();
    expect((library as TestLibrary).store.paths()).toHaveLength(1);
  });

  it('won’t overwrite a draft it couldn’t read, and can try again', async () => {
    storage.saved.set(appDraftKey, 'Unread draft');
    storage.failReads = true;
    library = createTestLibrary();
    await library.controller.start();
    await render(
      <DraftStoreContext.Provider value={new DraftStore(storage, 5)}>
        <LibraryProvider controller={library.controller}>
          <CaptureScreen />
        </LibraryProvider>
      </DraftStoreContext.Provider>,
    );

    expect(await screen.findByText(/couldn’t read your saved draft/)).toBeTruthy();
    expect(input().props.editable).toBe(false);
    await fireEvent.changeText(input(), 'Overwrite?');
    await act(() => wait(30));
    expect(storage.saved.get(appDraftKey)).toBe('Unread draft');

    storage.failReads = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    await waitForEditable();
    expect(input().props.value).toBe('Unread draft');
  });

  it('keeps each library’s draft to itself across a switch', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('For the app folder');

    lib.setPick({ status: 'picked', root: FOLDER, writable: true });
    await act(async () => {
      await lib.controller.chooseFolder();
    });
    await waitFor(() => expect(input().props.value).toBe(''));
    await waitForEditable();
    await type('For my folder');
    await act(() => wait(30));

    await act(async () => {
      await lib.controller.switchToAppOwnedFolder();
    });
    await waitFor(() => expect(input().props.value).toBe('For the app folder'));
  });
});

describe('Link insertion in Capture', () => {
  async function pickLink(query: string, rowName: RegExp) {
    await fireEvent.press(screen.getByRole('button', { name: 'Insert link' }));
    await fireEvent.changeText(screen.getByLabelText('Search for a note to link to'), query);
    await fireEvent.press(await screen.findByLabelText(rowName));
  }

  async function setSelection(start: number, end = start) {
    await fireEvent(input(), 'selectionChange', { nativeEvent: { selection: { start, end } } });
  }

  it('Insert a link: the link goes in at the cursor', async () => {
    await open({ files: { 'target.org': LINK_TARGET } });
    await type('See  for more');
    await setSelection(4);
    await pickLink('target', /^Link to Target note/);

    expect(input().props.value).toBe(`See [[id:${LINK_TARGET_ID}][Target note]] for more`);
    expect(screen.queryByLabelText('Search for a note to link to')).toBeNull();
    const cursor = 4 + `[[id:${LINK_TARGET_ID}][Target note]]`.length;
    expect(input().props.selection).toEqual({ start: cursor, end: cursor });
  });

  it('replaces selected text', async () => {
    await open({ files: { 'target.org': LINK_TARGET } });
    await type('See this now');
    await setSelection(4, 8);
    await pickLink('target', /^Link to Target note/);
    expect(input().props.value).toBe(`See [[id:${LINK_TARGET_ID}][Target note]] now`);
  });

  it('goes at the end when the field has not reported a cursor', async () => {
    await open({ files: { 'target.org': LINK_TARGET } });
    await type('See ');
    await pickLink('target', /^Link to Target note/);
    expect(input().props.value).toBe(`See [[id:${LINK_TARGET_ID}][Target note]]`);
  });

  it('uses the cursor from before the search, even if focus moved it', async () => {
    await open({ files: { 'target.org': LINK_TARGET } });
    await type('abcd');
    await setSelection(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Insert link' }));
    await setSelection(0);
    await fireEvent.changeText(screen.getByLabelText('Search for a note to link to'), 'target');
    await fireEvent.press(await screen.findByLabelText(/^Link to Target note/));
    expect(input().props.value).toBe(`ab[[id:${LINK_TARGET_ID}][Target note]]cd`);
  });

  it('Link to a heading-level node: the inserted link uses the heading’s ID', async () => {
    await open({ files: { 'plan.org': HEADINGS } });
    await pickLink('target', /^Link to Target heading/);
    expect(input().props.value).toBe(`[[id:${HEADING_ID}][Target heading]]`);
  });

  it('an inserted link resolves to its target in the saved note', async () => {
    const lib = (await open({ files: { 'target.org': LINK_TARGET } }), library as TestLibrary);
    await type('Linking note\n');
    await pickLink('target', /^Link to Target note/);
    await pressSave();

    const created = newFile(lib, ['target.org']).path;
    await waitFor(async () => {
      const backlinks = await lib.controller.getSnapshot().index!.backlinks(LINK_TARGET_ID);
      expect(backlinks.map((link) => link.source.filePath)).toEqual([created]);
    });
    const bytes = lib.store.peek(created) as Uint8Array;
    expect(decodeUtf8(bytes)).toContain(`[[id:${LINK_TARGET_ID}][Target note]]`);
  });

  it('closing the search leaves the text as it was', async () => {
    await open();
    await type('Unchanged');
    await fireEvent.press(screen.getByRole('button', { name: 'Insert link' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close link search' }));
    expect(input().props.value).toBe('Unchanged');
    expect(screen.queryByLabelText('Search for a note to link to')).toBeNull();
  });
});

describe('Saving', () => {
  it('a double tap creates one note', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Only once');

    // Holds the first save open, so the second tap lands while it is running.
    const store = lib.controller.getSnapshot().store!;
    const list = store.list.bind(store);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(store, 'list').mockImplementation(async () => {
      await held;
      return list();
    });

    await fireEvent.press(saveButton());
    expect(screen.getByRole('button', { name: 'Saving' }).props.accessibilityState.disabled).toBe(
      true,
    );
    expect(input().props.editable).toBe(false);
    await fireEvent.press(screen.getByRole('button', { name: 'Saving' }));
    release();

    await waitFor(() => expect(input().props.value).toBe(''));
    await waitFor(() => expect(input().props.editable).toBe(true));
    expect(lib.store.paths()).toHaveLength(1);
  });

  it('confirms the title, until the text changes', async () => {
    await open();
    await type('Confirmed');
    await pressSave();
    expect(await screen.findByText('Saved “Confirmed”.')).toBeTruthy();
    await type('Next');
    expect(screen.queryByText('Saved “Confirmed”.')).toBeNull();
  });

  it('two captures in one second both get a file', async () => {
    const lib = (await open(), library as TestLibrary);
    await type('Same');
    await pressSave();
    await waitFor(() => expect(saveButton().props.accessibilityState.disabled).toBe(true));
    await type('Same');
    await pressSave();
    expect(lib.store.paths()).toHaveLength(2);
  });
});

describe('accessibility', () => {
  it('labels every control and leaves font scaling on', async () => {
    await open();
    for (const name of ['Insert link', 'Discard', 'Save']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(input().props.accessibilityLabel).toBe('Capture text');
    expect(input().props.allowFontScaling).not.toBe(false);
  });
});

describe('before the library has opened', () => {
  it('can’t be edited, and shows a startup failure', async () => {
    library = createTestLibrary();
    const failing = new (
      library.controller.constructor as typeof import('../library-controller').LibraryController
    )(async () => {
      throw new Error('no storage');
    });
    await render(
      <DraftStoreContext.Provider value={new DraftStore(storage, 5)}>
        <LibraryProvider controller={failing}>
          <CaptureScreen />
        </LibraryProvider>
      </DraftStoreContext.Provider>,
    );
    expect(await screen.findByText(/couldn’t open its storage/)).toBeTruthy();
    expect(input().props.editable).toBe(false);
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
    await failing.close();
  });
});
