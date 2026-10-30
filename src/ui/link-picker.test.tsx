import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { scan } from '../core/org';
import { LibraryContext, LibraryProvider, type LibraryContextValue } from './library-context';
import { LinkPicker, type PickedLink } from './link-picker';
import { createTestLibrary, type TestLibrary } from './test-library';

const ALPHA_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const HEADING_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const BRACKET_ID = 'cccccccc-0000-4000-8000-000000000003';

const ALPHA = `:PROPERTIES:\n:ID:       ${ALPHA_ID}\n:END:\n#+title: Alpha notes\n`;
const HEADINGS = `#+title: Project plan\n* Alpha milestone\n:PROPERTIES:\n:ID:       ${HEADING_ID}\n:END:\nDetails.\n`;
const BRACKETS = `:PROPERTIES:\n:ID:       ${BRACKET_ID}\n:END:\n#+title: Alpha [draft] [[2]]\n`;
const NO_ID = '#+title: Alpha without an id\nSome alpha text.\n';

let library: TestLibrary | null = null;

afterEach(async () => {
  await library?.dispose();
  library = null;
});

async function renderPicker(files: Record<string, string>) {
  library = createTestLibrary({ files });
  await library.controller.start();
  const onPick = jest.fn<void, [PickedLink]>();
  const onClose = jest.fn();
  await render(
    <LibraryProvider controller={library.controller}>
      <LinkPicker visible onPick={onPick} onClose={onClose} />
    </LibraryProvider>,
  );
  return { onPick, onClose };
}

async function search(query: string) {
  await fireEvent.changeText(screen.getByLabelText('Search for a note to link to'), query);
}

/** Search resolves in a macrotask of the SQLite driver at worst. */
async function settled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe('Link insertion', () => {
  it('Insert a link: selecting a note gives a valid ID link with its title as description', async () => {
    const { onPick } = await renderPicker({ 'alpha.org': ALPHA });
    await search('alpha');
    await fireEvent.press(await screen.findByLabelText(/^Link to Alpha notes/));
    expect(onPick).toHaveBeenCalledWith({
      id: ALPHA_ID,
      title: 'Alpha notes',
      linkText: `[[id:${ALPHA_ID}][Alpha notes]]`,
    });
  });

  it('Link to a heading-level node: the link uses that heading’s ID', async () => {
    const { onPick } = await renderPicker({ 'plan.org': HEADINGS });
    await search('milestone');
    const row = await screen.findByLabelText('Link to Alpha milestone. Heading in Project plan');
    await fireEvent.press(row);
    expect(onPick.mock.calls[0][0].linkText).toBe(`[[id:${HEADING_ID}][Alpha milestone]]`);
  });

  it('Title containing brackets: the link is well formed and resolves', async () => {
    const { onPick } = await renderPicker({ 'brackets.org': BRACKETS });
    await search('draft');
    await fireEvent.press(await screen.findByLabelText(/^Link to Alpha \[draft\]/));
    const picked = onPick.mock.calls[0][0];

    const [link] = scan(`:PROPERTIES:\n:ID: x\n:END:\n${picked.linkText}\n`).links;
    expect(link.target).toBe(BRACKET_ID);
    expect(picked.linkText.startsWith(`[[id:${BRACKET_ID}][`)).toBe(true);
    expect(picked.linkText.endsWith(']]')).toBe(true);
  });

  it('Files without an ID: a file without an ID that matches is not offered', async () => {
    await renderPicker({ 'alpha.org': ALPHA, 'no-id.org': NO_ID });
    await search('alpha');
    expect(await screen.findByLabelText(/^Link to Alpha notes/)).toBeTruthy();
    expect(screen.queryByLabelText(/Alpha without an id/)).toBeNull();
    expect(screen.queryByText('Alpha without an id')).toBeNull();
  });

  it('says so when only files without an ID match', async () => {
    await renderPicker({ 'no-id.org': NO_ID });
    await search('alpha');
    expect(await screen.findByText('No notes with an ID match this search.')).toBeTruthy();
  });
});

describe('the picker', () => {
  it('prompts for a search before one is typed', async () => {
    await renderPicker({ 'alpha.org': ALPHA });
    expect(screen.getByText('Search for a note or heading to link to.')).toBeTruthy();
  });

  it('offers a node once, even if a conflict copy has the same ID', async () => {
    await renderPicker({ 'alpha.org': ALPHA, 'alpha.sync-conflict-1.org': ALPHA });
    await search('alpha');
    expect(await screen.findAllByLabelText(/^Link to Alpha notes/)).toHaveLength(1);
  });

  it('labels the close button, and closing calls back', async () => {
    const { onClose } = await renderPicker({});
    await fireEvent.press(screen.getByRole('button', { name: 'Close link search' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('drops an answer to an older search', async () => {
    await renderPicker({ 'alpha.org': ALPHA, 'plan.org': HEADINGS });
    await search('alpha');
    await search('milestone');
    await settled();
    expect(screen.queryByLabelText(/^Link to Alpha notes/)).toBeNull();
    expect(screen.getByLabelText(/^Link to Alpha milestone/)).toBeTruthy();
  });

  it('explains when there is no index to search', async () => {
    library = createTestLibrary();
    // Not started, so no index is open.
    const value = { ...library.controller.getSnapshot() } as LibraryContextValue;
    await render(
      <LibraryContext.Provider value={value}>
        <LinkPicker visible onPick={() => undefined} onClose={() => undefined} />
      </LibraryContext.Provider>,
    );
    expect(screen.getByText('Search isn’t available right now.')).toBeTruthy();
  });

  it('shows nothing when not visible', async () => {
    library = createTestLibrary();
    await library.controller.start();
    await render(
      <LibraryProvider controller={library.controller}>
        <LinkPicker visible={false} onPick={() => undefined} onClose={() => undefined} />
      </LibraryProvider>,
    );
    expect(screen.queryByLabelText('Search for a note to link to')).toBeNull();
  });
});
