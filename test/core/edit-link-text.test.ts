import * as fc from 'fast-check';

import { insertLink, linkText, scan } from '../../src/core/org';

// Scenarios from openspec/changes/add-roamlet-mvp/specs/note-capture-editing/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const ZWSP = '​';

// Org's documented bracket link form: the target has no unescaped brackets, and the description
// runs to the first `]]`. Holds Roamlet to the same shape Org-roam's parser accepts.
const ORG_BRACKET_LINK = /^\[\[((?:[^[\]\\]|\\.)+)\](?:\[(.+?)\])?\]$/su;

/** The one link the scanner finds in a line holding `link`, with text around it. */
function parsed(link: string) {
  const doc = scan(`before ${link} after\n`);
  expect(doc.links).toHaveLength(1);
  return doc.links[0];
}

describe('Link insertion', () => {
  it('Insert a link', () => {
    const buffer = 'See  for more';
    const { text, cursor } = insertLink(buffer, { start: 4, end: 4 }, ID, 'Other note');
    expect(text).toBe(`See [[id:${ID}][Other note]] for more`);
    expect(text.slice(0, cursor)).toBe(`See [[id:${ID}][Other note]]`);
  });

  it('replaces the selection when one is active', () => {
    const { text, cursor } = insertLink('See this for more', { start: 4, end: 8 }, 'a', 'T');
    expect(text).toBe('See [[id:a][T]] for more');
    expect(cursor).toBe('See [[id:a][T]]'.length);
  });

  it('Link to a heading-level node', () => {
    const headingId = 'heading-id';
    const note = scan(`* Target heading\n:PROPERTIES:\n:ID: ${headingId}\n:END:\n`);
    const [node] = note.nodes;
    const link = linkText(node.id, node.title);
    expect(link).toBe(`[[id:${headingId}][Target heading]]`);
    expect(parsed(link)).toMatchObject({ target: headingId, description: 'Target heading' });
  });

  describe('Title containing brackets', () => {
    it.each([
      ['[x] task', `[[id:${ID}][[x] task]]`, '[x] task'],
      ['a [b] c', `[[id:${ID}][a [b] c]]`, 'a [b] c'],
      ['ends with [b]', `[[id:${ID}][ends with [b]${ZWSP}]]`, `ends with [b]${ZWSP}`],
      ['a ]] b', `[[id:${ID}][a ]${ZWSP}] b]]`, `a ]${ZWSP}] b`],
      [']]]', `[[id:${ID}][]${ZWSP}]${ZWSP}]${ZWSP}]]`, `]${ZWSP}]${ZWSP}]${ZWSP}`],
      ['[[nested]] link', `[[id:${ID}][[[nested]${ZWSP}] link]]`, `[[nested]${ZWSP}] link`],
      ['[', `[[id:${ID}][[]]`, '['],
    ])('%s', (title, link, description) => {
      expect(linkText(ID, title)).toBe(link);
      expect(link).toMatch(ORG_BRACKET_LINK);
      expect(parsed(link)).toMatchObject({ target: ID, description, form: 'bracket' });
    });

    it('stays well formed for any title', () => {
      const title = fc
        .array(fc.constantFrom('[', ']', ']]', '[[', '\\', ' ', 'a', '😀', '\n', 'id:x'), {
          maxLength: 12,
        })
        .map((parts) => parts.join(''));
      fc.assert(
        fc.property(title, (value) => {
          const link = linkText(ID, value);
          expect(link).toMatch(ORG_BRACKET_LINK);
          expect(link).not.toContain('\n');
          const doc = scan(`${link}\n`);
          expect(doc.links.map(({ target, span }) => ({ target, span }))).toEqual([
            { target: ID, span: { start: 0, end: link.length } },
          ]);
          const shown = doc.links[0].description ?? '';
          const visible = (text: string) => text.replace(/\s+/g, ' ').trim();
          expect(visible(shown.replaceAll(ZWSP, ''))).toBe(visible(value));
        }),
        { numRuns: 2000 },
      );
    });
  });

  it('Files without an ID', () => {
    expect(scan('#+title: No ID here\nBody\n').nodes).toEqual([]);
  });

  it('keeps a description on one line', () => {
    expect(linkText('a', 'Two\r\nlines')).toBe('[[id:a][Two lines]]');
  });

  it('leaves out an empty description', () => {
    expect(linkText('a', '  ')).toBe('[[id:a]]');
    expect(parsed('[[id:a]]')).toMatchObject({ target: 'a', description: null });
  });

  it.each(['with]bracket', 'with[bracket', 'slash\\]bracket', 'trailing\\'])(
    'escapes an unusual ID: %s',
    (id) => {
      const link = linkText(id, 'Title');
      expect(link).toMatch(ORG_BRACKET_LINK);
      expect(parsed(link)).toMatchObject({ target: id, description: 'Title' });
    },
  );
});
