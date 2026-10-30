import { router as routerApi } from 'expo-router';
import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { FlatList, Linking } from 'react-native';

import { note, renderNotesApp } from '../notes/test-app';
import { createTestLibrary, type TestLibrary } from '../test-library';

let library: TestLibrary;

function setUp(options: Parameters<typeof createTestLibrary>[0] = {}): TestLibrary {
  library = createTestLibrary(options);
  return library;
}

afterEach(async () => {
  await library.dispose();
  jest.restoreAllMocks();
});

function readUrl(path: string, node?: string): string {
  const query = `path=${encodeURIComponent(path)}`;
  return `/notes/read?${query}${node ? `&node=${node}` : ''}`;
}

async function read(lib: TestLibrary, path: string, node?: string) {
  const router = await renderNotesApp(lib, readUrl(path, node));
  await act(() => lib.controller.start());
  return router;
}

interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: (HostNode | string)[] | null;
}

function allHostNodes(tree: unknown): HostNode[] {
  if (!tree || typeof tree === 'string') return [];
  if (Array.isArray(tree)) return tree.flatMap(allHostNodes);
  const node = tree as HostNode;
  return [node, ...allHostNodes(node.children)];
}

function isInsideSideways(element: { parent: unknown }): boolean {
  let parent = element.parent as { props?: { horizontal?: boolean }; parent: unknown } | null;
  while (parent) {
    if (parent.props?.horizontal) return true;
    parent = parent.parent as typeof parent;
  }
  return false;
}

const FULL_NOTE = note(
  'full',
  'Everything',
  [
    'A paragraph with *bold*, /italic/, _under_, +gone+, =verbatim= and ~code~.',
    '',
    '* First heading',
    ':PROPERTIES:',
    ':ID:       heading-1',
    ':CUSTOM:   secret-property-value',
    ':END:',
    '- list item one',
    '- list item two',
    '',
    '#+begin_src python',
    'print("a very long line that would never fit on a phone screen without scrolling sideways")',
    '#+end_src',
    '',
    '| name | value |',
    '|------+-------|',
    '| a    | 1     |',
    '',
  ].join('\n'),
);

describe('Reading view', () => {
  it('Supported constructs', async () => {
    const lib = setUp({ files: { 'full.org': FULL_NOTE } });
    await read(lib, 'full.org');

    expect(await screen.findAllByText('Everything')).not.toHaveLength(0);
    expect(screen.getByRole('header', { name: 'First heading' })).toBeTruthy();
    expect(screen.getByText('bold').props.style).toMatchObject({ fontWeight: '700' });
    expect(screen.getByText('italic').props.style).toMatchObject({ fontStyle: 'italic' });
    expect(screen.getByText('under').props.style).toMatchObject({ textDecorationLine: 'underline' });
    expect(screen.getByText('gone').props.style).toMatchObject({ textDecorationLine: 'line-through' });
    expect(screen.getByText('verbatim')).toBeTruthy();
    expect(screen.getByText('code')).toBeTruthy();
    expect(screen.getByText('list item one')).toBeTruthy();
    expect(screen.getByText('python')).toBeTruthy();

    // Wide content keeps its shape in a sideways scroller, rather than widening the page.
    const source = screen.getByText(/a very long line/);
    const table = screen.getByText(/\| name \| value \|/);
    for (const wide of [source, table]) {
      expect(isInsideSideways(wide)).toBe(true);
    }
  });

  it('hides property drawers and the file header', async () => {
    const lib = setUp({ files: { 'full.org': FULL_NOTE } });
    await read(lib, 'full.org');

    await screen.findByText('list item one');
    expect(screen.queryByText(/secret-property-value/)).toBeNull();
    expect(screen.queryByText(/:ID:/)).toBeNull();
    expect(screen.queryByText(/#\+title/)).toBeNull();
  });

  it('Unsupported construct', async () => {
    const latex = '\\begin{equation}\nx = *not bold*\n\\end{equation}';
    const dynamic = '#+BEGIN: clocktable :scope file';
    const lib = setUp({ files: { 'odd.org': note('o', 'Odd', `${latex}\n\n${dynamic}\n`) } });
    await read(lib, 'odd.org');

    expect(await screen.findByText(latex)).toBeTruthy();
    expect(screen.getByText(dynamic)).toBeTruthy();
  });

  it('reads the current file, not the index', async () => {
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha', 'Old words.') } });
    await read(lib, 'a.org');
    await screen.findByText('Old words.');

    lib.store.writeFile('a.org', note('a', 'Alpha', 'New words.'));
    await act(() => lib.controller.refresh());
    expect(await screen.findByText('New words.')).toBeTruthy();
    expect(screen.queryByText('Old words.')).toBeNull();
  });

  it('opens a file changed since the last refresh with what it says now', async () => {
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha', 'Old words.') } });
    await lib.controller.start();
    lib.store.writeFile('a.org', note('a', 'Alpha', 'Unindexed words.'));

    await read(lib, 'a.org');
    expect(await screen.findByText('Unindexed words.')).toBeTruthy();
  });

  it('never turns font scaling off', async () => {
    const lib = setUp({ files: { 'full.org': FULL_NOTE } });
    await read(lib, 'full.org');
    await screen.findByText('list item one');

    const texts = allHostNodes(screen.toJSON()).filter((node) => node.type === 'Text');
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect(text.props.allowFontScaling).not.toBe(false);
  });

  it('renders long notes through a virtualized list', async () => {
    const paragraphs = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const lib = setUp({ files: { 'long.org': note('l', 'Long', paragraphs) } });
    await read(lib, 'long.org');

    expect(await screen.findByText('Paragraph 0.')).toBeTruthy();
    // Rendered windows only, and 2000 paragraphs are nowhere near all there.
    const rendered = allHostNodes(screen.toJSON()).filter((node) => node.type === 'Text');
    expect(rendered.length).toBeLessThan(200);
    expect(screen.queryByText('Paragraph 1999.')).toBeNull();
  });

  it('Opening a heading-level node', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const lib = setUp({ files: { 'full.org': FULL_NOTE } });
    await read(lib, 'full.org', 'heading-1');
    await screen.findByText('list item one');

    // The paragraph is block 0, and the heading block 1.
    await waitFor(() =>
      expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ index: 1, viewPosition: 0 })),
    );
  });

  it('stays at the top for a file-level node, or a node no longer in the file', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const lib = setUp({ files: { 'full.org': FULL_NOTE } });
    await read(lib, 'full.org', 'gone-from-file');
    await screen.findByText('list item one');

    // renderRouter's fake timers, so this is a frame of made-up time.
    await act(() => jest.advanceTimersByTimeAsync(50));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('Note not available', async () => {
    const linked = note('target', 'Target', 'Link to [[id:other][Other]].');
    const lib = setUp({
      files: {
        'target.org': linked,
        'other.org': note('other', 'Other'),
        'source.org': note('source', 'Source', 'See [[id:target][it]].'),
      },
    });
    await lib.controller.start();
    lib.store.setDownloaded('target.org', false);
    await lib.controller.refresh();

    await read(lib, 'target.org');

    expect(await screen.findByText(/isn’t on this device yet/)).toBeTruthy();
    expect(lib.store.calls).toContainEqual({ op: 'requestDownload', path: 'target.org' });
    expect(await screen.findByLabelText('Backlink from Source, source.org')).toBeTruthy();
    expect(await screen.findByLabelText('Link to Other, other.org')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();

    lib.store.setDownloaded('target.org', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/^Link to/)).toBeTruthy();
  });

  it('explains when the whole library is unavailable, and keeps links viewable', async () => {
    const lib = setUp({
      files: { 'a.org': note('a', 'Alpha'), 'b.org': note('b', 'Beta', 'To [[id:a][alpha]].') },
    });
    await lib.controller.start();
    lib.setRestore({ status: 'missing' });
    await lib.controller.recheckAccess();

    await read(lib, 'a.org');
    expect(await screen.findByText(/folder can’t be found/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect folder' })).toBeTruthy();
    expect(await screen.findByLabelText('Backlink from Beta, b.org')).toBeTruthy();
  });

  it('explains a file that has gone, and rechecks access', async () => {
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha') } });
    await lib.controller.start();
    lib.store.remove('a.org');
    lib.log.length = 0;

    await read(lib, 'a.org');
    expect(await screen.findByText(/no longer there/)).toBeTruthy();
    expect(lib.log).toContain('restore');
  });

  it('explains a file that is not valid UTF-8', async () => {
    const lib = setUp({ files: { 'bad.org': new Uint8Array([0xff, 0xfe]) as unknown as string } });
    await read(lib, 'bad.org');

    expect(await screen.findByText(/isn’t valid UTF-8/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});

describe('Edit entry', () => {
  it('opens the editor for this file', async () => {
    const lib = setUp({ files: { 'daily/a.org': note('a', 'Alpha') } });
    const router = await read(lib, 'daily/a.org');

    await fireEvent.press(await screen.findByRole('button', { name: 'Edit Alpha' }));
    expect(router.getPathname()).toBe('/notes/edit');
    expect(router.getSearchParams().path).toBe('daily/a.org');
    expect(await screen.findByText('Editor stand-in')).toBeTruthy();
  });

  it('is absent from a read-only location, which says why', async () => {
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha', 'Words.') } });
    lib.setRestore({ status: 'ok', writable: false });
    await read(lib, 'a.org');

    await screen.findByText('Words.');
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
    expect(screen.getByText(/can’t be written to/)).toBeTruthy();
  });
});

describe('Link navigation', () => {
  it('Following a link', async () => {
    const lib = setUp({
      files: {
        'source.org': note('s', 'Source', 'Go to [[id:t][the target]] now.'),
        'target.org': note('t', 'Target', 'Target body.'),
      },
    });
    const router = await read(lib, 'source.org');

    await fireEvent.press(await screen.findByText('the target'));
    expect(await screen.findByText('Target body.')).toBeTruthy();
    expect(router.getSearchParams().path).toBe('target.org');

    await act(async () => routerApi.back());
    expect(router.getSearchParams().path).toBe('source.org');
    expect(await screen.findByText('the target')).toBeTruthy();
  });

  it('shows the target’s title for a link without a description', async () => {
    const lib = setUp({
      files: {
        'source.org': note('s', 'Source', 'See [[id:t]] and id:t too.'),
        'target.org': note('t', 'The Target Title'),
      },
    });
    await read(lib, 'source.org');

    expect(await screen.findAllByRole('link', { name: 'The Target Title' })).toHaveLength(2);
  });

  it('Link to a heading-level node', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => undefined);
    const lib = setUp({
      files: {
        'source.org': note('s', 'Source', 'To [[id:heading-1][the heading]].'),
        'full.org': FULL_NOTE,
      },
    });
    const router = await read(lib, 'source.org');

    await fireEvent.press(await screen.findByText('the heading'));
    expect(await screen.findByText('list item one')).toBeTruthy();
    expect(router.getSearchParams()).toMatchObject({ path: 'full.org', node: 'heading-1' });

    await waitFor(() => expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ index: 1 })));
  });

  it('Link types that are not navigable', async () => {
    const body =
      'A [[roam:Some Page]] and [[cite:smith2020][Smith]] and [[file:pic.png]] and [[Fuzzy]] end.';
    const source = note('s', 'Source', body);
    const lib = setUp({ files: { 'source.org': source } });
    const router = await read(lib, 'source.org');

    await screen.findByText(/end\./);
    expect(screen.getByText('roam:Some Page')).toBeTruthy();
    expect(screen.getByText('Smith')).toBeTruthy();
    expect(screen.getByText('file:pic.png')).toBeTruthy();
    expect(screen.getByText('Fuzzy')).toBeTruthy();
    expect(screen.queryAllByRole('link')).toHaveLength(0);

    await fireEvent.press(screen.getByText('Smith'));
    expect(router.getSearchParams().path).toBe('source.org');
    expect(lib.store.peekText('source.org')).toBe(source);
  });

  it('opens web links outside the app', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const lib = setUp({
      files: { 'a.org': note('a', 'Alpha', 'See [[https://example.com/x?y=1][the site]] and https://example.org.') },
    });
    const router = await read(lib, 'a.org');

    await fireEvent.press(await screen.findByRole('link', { name: 'the site, opens outside Roamlet' }));
    expect(openURL).toHaveBeenCalledWith('https://example.com/x?y=1');
    await fireEvent.press(screen.getByText('https://example.org'));
    expect(openURL).toHaveBeenCalledWith('https://example.org');
    expect(router.getSearchParams().path).toBe('a.org');
  });

  it('says so when a web link can’t open', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no browser'));
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha', '[[https://example.com][site]]') } });
    await read(lib, 'a.org');

    await fireEvent.press(await screen.findByText('site'));
    expect(await screen.findByText('This link couldn’t be opened.')).toBeTruthy();
  });
});

describe('Backlinks and outgoing links', () => {
  it('Viewing backlinks', async () => {
    const lib = setUp({
      files: {
        'target.org': note('t', 'Target'),
        'one.org': note('one', 'First source', '[[id:t][a]] and again [[id:t][b]]'),
        'two.org': note('two', 'Second source', '[[id:t]]'),
      },
    });
    const router = await read(lib, 'target.org');

    expect(await screen.findByLabelText('Backlink from Second source, two.org')).toBeTruthy();
    // Two links from one note are one backlink.
    expect(screen.getAllByLabelText('Backlink from First source, one.org')).toHaveLength(1);

    await fireEvent.press(screen.getByLabelText('Backlink from First source, one.org'));
    expect(router.getSearchParams().path).toBe('one.org');
  });

  it('No backlinks', async () => {
    const lib = setUp({ files: { 'a.org': note('a', 'Alpha') } });
    await read(lib, 'a.org');

    expect(await screen.findByText('No notes link here.')).toBeTruthy();
    expect(screen.getByText('This note has no links to other notes.')).toBeTruthy();
  });

  it('lists outgoing links, resolved or not', async () => {
    const lib = setUp({
      files: {
        'a.org': note('a', 'Alpha', '[[id:b][to beta]] and [[id:nowhere][to nothing]]'),
        'b.org': note('b', 'Beta'),
      },
    });
    const router = await read(lib, 'a.org');

    expect(await screen.findByLabelText('Link to Beta, b.org')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Link to to nothing, Not in this library'));
    expect(await screen.findByText(/isn’t in this library/)).toBeTruthy();
    expect(router.getSearchParams().path).toBe('a.org');

    await fireEvent.press(screen.getByLabelText('Link to Beta, b.org'));
    expect(router.getSearchParams().path).toBe('b.org');
  });

  it('counts links to headings in the file as backlinks, opening at the source heading', async () => {
    const lib = setUp({
      files: {
        'full.org': FULL_NOTE,
        'src.org': `${note('s', 'Src')}* Sub\n:PROPERTIES:\n:ID: sub\n:END:\n[[id:heading-1][x]]\n`,
      },
    });
    const router = await read(lib, 'full.org');

    await fireEvent.press(await screen.findByLabelText('Backlink from Sub, src.org'));
    expect(router.getSearchParams()).toMatchObject({ path: 'src.org', node: 'sub' });
  });
});

describe('Unresolved link handling', () => {
  it('Tapping an unresolved link', async () => {
    const source = note('s', 'Source', 'A [[id:missing][broken one]] here.');
    const lib = setUp({ files: { 'source.org': source } });
    const router = await read(lib, 'source.org');

    const link = await screen.findByRole('link', { name: 'broken one, note not in this library' });
    await fireEvent.press(link);

    expect(await screen.findByText(/This note isn’t in this library/)).toBeTruthy();
    expect(router.getSearchParams().path).toBe('source.org');
    expect(lib.store.peekText('source.org')).toBe(source);

    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(screen.queryByText(/This note isn’t in this library/)).toBeNull();
  });

  it('marks it apart from a resolved link', async () => {
    const lib = setUp({
      files: {
        'source.org': note('s', 'Source', '[[id:missing][broken]] [[id:t][fine]]'),
        'target.org': note('t', 'Target'),
      },
    });
    await read(lib, 'source.org');

    const broken = await screen.findByRole('link', { name: 'broken, note not in this library' });
    const fine = screen.getByRole('link', { name: 'fine' });
    expect(broken.props.style.textDecorationLine).toBeUndefined();
    expect(fine.props.style.textDecorationLine).toBe('underline');
  });

  it('Target later appears', async () => {
    const source = note('s', 'Source', 'A [[id:later][pending]] link.');
    const lib = setUp({ files: { 'source.org': source } });
    const router = await read(lib, 'source.org');
    await screen.findByRole('link', { name: 'pending, note not in this library' });

    lib.store.writeFile('later.org', note('later', 'Arrived', 'Now here.'));
    await act(() => lib.controller.refresh());

    await fireEvent.press(await screen.findByRole('link', { name: 'pending' }));
    expect(await screen.findByText('Now here.')).toBeTruthy();
    expect(router.getSearchParams().path).toBe('later.org');
    expect(lib.store.peekText('source.org')).toBe(source);
  });
});
