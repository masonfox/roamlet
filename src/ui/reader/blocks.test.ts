import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scan } from '../../core/org';
import { blockIndexAt, buildBlocks, type ReaderBlock } from './blocks';

function blocksOf(text: string): ReaderBlock[] {
  return buildBlocks(text, scan(text));
}

function only<K extends ReaderBlock['kind']>(text: string, kind: K): ReaderBlock & { kind: K } {
  const blocks = blocksOf(text);
  expect(blocks.map((block) => block.kind)).toEqual([kind]);
  return blocks[0] as ReaderBlock & { kind: K };
}

describe('each block type', () => {
  it('heading keeps its keyword, priority, and tags', () => {
    const text = '** TODO [#A] Title here :one:two:\n';
    expect(only(text, 'heading')).toMatchObject({
      level: 2,
      todo: 'TODO',
      priority: 'A',
      tags: ['one', 'two'],
    });
  });

  it('paragraph covers its wrapped lines', () => {
    const text = 'One line\nand the next\n\nA second one\n';
    expect(blocksOf(text).map((block) => [block.kind, block.span])).toEqual([
      ['paragraph', { start: 0, end: 21 }],
      ['paragraph', { start: 23, end: 35 }],
    ]);
  });

  it('list item keeps its marker and indent', () => {
    const text = '- first\n  1. nested\n';
    const blocks = blocksOf(text);
    expect(blocks).toMatchObject([
      { kind: 'listItem', marker: '-', indent: 0 },
      { kind: 'listItem', marker: '1.', indent: 2 },
    ]);
  });

  it('table rows join into one block', () => {
    const text = '| a | b |\n|---+---|\n| 1 | 2 |\n';
    expect(only(text, 'table').content).toBe('| a | b |\n|---+---|\n| 1 | 2 |');
  });

  it('a blank line separates tables', () => {
    const blocks = blocksOf('| a |\n\n| b |\n');
    expect(blocks.map((block) => block.kind)).toEqual(['table', 'table']);
  });

  it('source block shows its unescaped content and language', () => {
    const text = '#+begin_src python :results output\n,* not a heading\nprint(1)\n#+end_src\n';
    expect(only(text, 'source')).toMatchObject({
      language: 'python',
      content: '* not a heading\nprint(1)',
    });
  });

  it('example block and fixed-width lines are preformatted', () => {
    expect(only('#+begin_example\nkept  as is\n#+end_example\n', 'example').content).toBe('kept  as is');
    expect(only(': one\n: two\n', 'example').content).toBe('one\ntwo');
  });

  it('quote contents are ordinary blocks marked as quoted', () => {
    const blocks = blocksOf('#+begin_quote\nQuoted words.\n- item\n#+end_quote\nAfter.\n');
    expect(blocks).toMatchObject([
      { kind: 'paragraph', quoted: true },
      { kind: 'listItem', quoted: true },
      { kind: 'paragraph', quoted: false },
    ]);
  });

  it('verse keeps its lines', () => {
    const block = only('#+begin_verse\nOne\n  Two\n#+end_verse\n', 'literal');
    expect(block).toMatchObject({ style: 'verse', content: 'One\n  Two' });
  });

  it('shows CRLF source without carriage returns', () => {
    expect(only('| a |\r\n| b |\r\n', 'table').content).toBe('| a |\n| b |');
    expect(only('#+begin_src\r\nx\r\ny\r\n#+end_src\r\n', 'source').content).toBe('x\ny');
  });
});

describe('literal fallback', () => {
  const cases: [string, string][] = [
    ['a LaTeX environment', '\\begin{equation}\nx_1 + _y_ = *z*\n\\end{equation}\n'],
    ['a dynamic block line', '#+BEGIN: clocktable :scope file\n'],
    ['an unknown block', '#+begin_foo bar\nInside *it*\n#+end_foo\n'],
    ['a comment block', '#+begin_comment\nHidden in Org, not here\n#+end_comment\n'],
    ['an export block', '#+begin_export html\n<b>x</b>\n#+end_export\n'],
    ['a drawer', 'Text.\n\n:LOGBOOK:\nCLOCK: [2026-01-01]\n:END:\n'],
    ['a planning line', '* H\nSCHEDULED: <2026-01-01>\n'],
    ['a keyword in the body', 'Text.\n\n#+RESULTS: x\n'],
    ['a comment in the body', 'Text.\n\n# a remark\n'],
    ['an unterminated block', '#+begin_src python\nprint(1)\n'],
  ];

  it.each(cases)('shows %s as written', (_name, text) => {
    const shown = blocksOf(text)
      .filter((block) => block.kind === 'literal')
      .map((block) => (block.kind === 'literal' ? block.content : ''))
      .join('\n');
    expect(shown).not.toBe('');
    const lastLines = text.trim().split('\n').slice(-1)[0];
    if (!text.startsWith('Text') && !text.startsWith('* H')) expect(shown).toContain(lastLines);
  });

  it('does not repeat what a literal block contains', () => {
    const blocks = blocksOf('#+begin_foo\nInside\n#+end_foo\n');
    expect(blocks).toHaveLength(1);
  });
});

describe('metadata', () => {
  it('hides file and heading property drawers and the header', () => {
    const text =
      ':PROPERTIES:\n:ID: a\n:END:\n#+title: T\n#+filetags: :x:\n# header remark\n\nBody.\n\n* H\n:PROPERTIES:\n:ID: b\n:END:\nMore.\n';
    const blocks = blocksOf(text);
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(blocks.some((block) => text.slice(block.span.start, block.span.end).includes(':ID:'))).toBe(
      false,
    );
  });
});

describe('the fixture corpus', () => {
  const directory = join(__dirname, '../../../test/fixtures');
  const names = readdirSync(directory).filter((name) => name.endsWith('.org'));

  it.each(names)('%s loses no line', (name) => {
    const text = readFileSync(join(directory, name), 'utf8');
    const doc = scan(text);
    const blocks = buildBlocks(text, doc);

    const shownSpans = blocks.map((block) => block.span);
    const accountedFor = [
      ...shownSpans,
      // Metadata the reader hides on purpose.
      ...doc.elements
        .filter(
          (element) =>
            (element.kind === 'drawer' && element.isPropertyDrawer) ||
            ((element.kind === 'keyword' || element.kind === 'comment') &&
              element.span.end <= doc.headerEnd),
        )
        .map((element) => element.span),
      // The lines that open and close a quote, which its inset stands in for.
      ...doc.elements.flatMap((element) =>
        element.kind === 'block' && (element.name === 'quote' || element.name === 'center')
          ? [
              { start: element.span.start, end: element.contentSpan.start },
              { start: element.contentSpan.end, end: element.span.end },
            ]
          : [],
      ),
    ];

    let offset = doc.bomLength;
    for (const line of text.slice(offset).split('\n')) {
      const end = offset + line.length;
      if (line.trim() !== '') {
        const covered = accountedFor.some((span) => span.start <= offset && end <= span.end + 1);
        if (!covered) throw new Error(`${name}: dropped line ${JSON.stringify(line)}`);
      }
      offset = end + 1;
    }

    // In document order, without overlap, which the list's keys and scrolling depend on.
    for (let i = 1; i < shownSpans.length; i++) {
      expect(shownSpans[i].start).toBeGreaterThanOrEqual(shownSpans[i - 1].end);
    }
  });
});

describe('blockIndexAt', () => {
  const text = 'Intro.\n\n* One\nText.\n\n* Two\n';
  const blocks = blocksOf(text);

  it('finds the block holding an offset', () => {
    expect(blockIndexAt(blocks, text.indexOf('* Two'))).toBe(3);
  });

  it('finds the next block from a gap', () => {
    expect(blockIndexAt(blocks, text.indexOf('* One') - 1)).toBe(1);
  });

  it('has no answer past the end', () => {
    expect(blockIndexAt(blocks, text.length)).toBeNull();
  });
});
