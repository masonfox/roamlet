import { scan, titleFromFileName, unescapeBlockContent } from '../../src/core/org';
import type { OrgElement, OrgHeading } from '../../src/core/org';

const kinds = (elements: OrgElement[]) => elements.map((element) => element.kind);
const headings = (elements: OrgElement[]) =>
  elements.filter((element): element is OrgHeading => element.kind === 'heading');

describe('line scanning', () => {
  it('classifies each kind of line', () => {
    const doc = scan(
      [
        '# comment',
        '#+key: value',
        ': fixed',
        '* Heading',
        'CLOSED: [2026-01-01 Thu]',
        ':LOGBOOK:',
        'inside',
        ':END:',
        '#+begin_quote',
        'quoted',
        '#+end_quote',
        '#+begin_src',
        'code',
        '#+end_src',
        'para one',
        'para two',
        '',
        '- item one',
        '- item two',
        '| a | b |',
        '| c | d |',
        '',
      ].join('\n'),
    );
    expect(kinds(doc.elements)).toEqual([
      'comment',
      'keyword',
      'fixedWidth',
      'heading',
      'planning',
      'drawer',
      'text',
      'block',
      'text',
      'block',
      'text',
      'text',
      'text',
      'text',
      'text',
    ]);
  });

  it('does not treat a planning line away from a heading as planning', () => {
    expect(kinds(scan('* H\nText\nDEADLINE: <2026-01-01>\n').elements)).toEqual(['heading', 'text']);
  });

  it('keeps unknown lines as text', () => {
    const doc = scan('#+end_src\n:END:\n\\begin{equation}\n#+begin: clocktable\n#+end:\n');
    expect(kinds(doc.elements)).toEqual(['text']);
  });

  it('marks a block with parameters and content offsets', () => {
    const text = '#+BEGIN_SRC python :results output  \ncode\n#+END_SRC\n';
    const block = scan(text).elements[0];
    if (block.kind !== 'block') throw new Error('expected a block');
    expect(block.name).toBe('src');
    expect(block.parameters).toBe('python :results output');
    expect(block.verbatim).toBe(true);
    expect(text.slice(block.contentSpan.start, block.contentSpan.end)).toBe('code\n');
  });

  it('unescapes block content', () => {
    expect(unescapeBlockContent(',* a\n,,* b\n  ,#+end_src\n,plain\n')).toBe(
      '* a\n,* b\n  #+end_src\n,plain\n',
    );
  });

  it('stays linear on many unterminated blocks and drawers', () => {
    const line = '#+begin_src x\n:FOO:\n*a *a [[a][b\n';
    expect(scan(line.repeat(50_000)).nodes).toEqual([]);
  });
});

describe('title and keywords', () => {
  it('exposes a title value span that excludes surrounding blanks', () => {
    const text = '#+TITLE:   Old title  \n';
    const keyword = scan(text).titleKeyword!;
    expect(keyword.value).toBe('Old title');
    expect(text.slice(keyword.valueSpan.start, keyword.valueSpan.end)).toBe('Old title');
    expect(text.slice(keyword.keySpan.start, keyword.keySpan.end)).toBe('TITLE');
  });

  it('reports an empty span for an empty title and falls back to the file name', () => {
    const doc = scan('#+title:\n', { fileName: 'dir/a.b.org' });
    expect(doc.titleKeyword!.valueSpan).toEqual({ start: 8, end: 8 });
    expect(doc.title).toBe('a.b');
  });

  it('uses the first title, even one below a heading', () => {
    expect(scan('* H\n#+title: Low\n#+title: Later\n').title).toBe('Low');
  });

  it('ignores keywords inside verbatim blocks', () => {
    const doc = scan('#+begin_src org\n#+title: No\n#+TODO: NOPE\n#+end_src\n* NOPE stays\n');
    expect(doc.titleKeyword).toBeNull();
    expect(headings(doc.elements)[0].title).toBe('NOPE stays');
  });

  it('shows link descriptions in titles', () => {
    expect(scan('#+title: See [[id:1][one]] and [[id:2]]\n').title).toBe('See one and id:2');
    expect(headings(scan('* See [[id:1][one]] :t:\n').elements)[0].title).toBe('See one');
  });

  it('derives the title from a file name', () => {
    expect(titleFromFileName('a/b/c.org')).toBe('c');
    expect(titleFromFileName('.hidden')).toBe('.hidden');
    expect(titleFromFileName('noext')).toBe('noext');
  });
});

describe('heading parsing', () => {
  const parse = (line: string) => headings(scan(`${line}\n`).elements)[0];

  it.each([
    ['* Title', null, null, 'Title', []],
    ['* TODO', 'TODO', null, '', []],
    ['* DONE [#1] T', 'DONE', '1', 'T', []],
    ['* [#A]No space', null, 'A', 'No space', []],
    ['* T :a:b:', null, null, 'T', ['a', 'b']],
    ['* :only:', null, null, '', ['only']],
    ['* T :not tags:', null, null, 'T :not tags:', []],
    ['* T a:b:', null, null, 'T a:b:', []],
    ['* Todo soon', null, null, 'Todo soon', []],
    ['*   Spaced   :x:  ', null, null, 'Spaced', ['x']],
    ['** COMMENT Kept', null, null, 'COMMENT Kept', []],
  ])('parses %j', (line, todo, priority, title, tags) => {
    expect(parse(line)).toMatchObject({ todo, priority, title, tags });
  });

  it('inherits tags from the file and ancestors, but not siblings', () => {
    const id = (n: number) => `:PROPERTIES:\n:ID: ${n}\n:END:\n`;
    const doc = scan(`#+filetags: :f:\n* A :a:\n${id(1)}** B :b:\n${id(2)}* C :c:\n${id(3)}`);
    expect(doc.nodes.map((node) => node.tags)).toEqual([
      ['f', 'a'],
      ['f', 'a', 'b'],
      ['f', 'c'],
    ]);
  });

  it('attributes text to the nearest enclosing node after shallower headings close', () => {
    const id = (n: number) => `:PROPERTIES:\n:ID: ${n}\n:END:\n`;
    const doc = scan(
      `${id(0)}* A\n${id(1)}a [[id:x]]\n** B\nb [[id:x]]\n*** C\n${id(2)}c [[id:x]]\n** D\nd [[id:x]]\n* E\ne [[id:x]]\n`,
    );
    expect(doc.links.map((link) => link.source)).toEqual([1, 1, 2, 1, 0]);
  });
});

describe('document facts', () => {
  it.each([
    ['', 'none'],
    ['a', 'none'],
    ['a\nb', 'lf'],
    ['a\r\nb\r\n', 'crlf'],
    ['a\r\nb\n', 'mixed'],
  ])('detects the line ending of %j', (text, eol) => {
    expect(scan(text).eol).toBe(eol);
  });

  it('keeps a lone carriage return as text, not a line ending', () => {
    const doc = scan('a\rb\n* H\r\n');
    expect(kinds(doc.elements)).toEqual(['text', 'heading']);
  });

  it('finds the end of the metadata header', () => {
    const header = ':PROPERTIES:\n:ID: x\n:END:\n#+title: T\n\n# note\n#+filetags: :a:\n';
    expect(scan(`${header}\nBody\n* H\n`).headerEnd).toBe(header.length);
    expect(scan('Body\n#+title: T\n').headerEnd).toBe(0);
    expect(scan('\uFEFFBody\n').headerEnd).toBe(1);
    expect(scan('#+title: T').headerEnd).toBe(10);
  });

  it('counts a BOM in offsets but not as content', () => {
    const doc = scan('\uFEFF:PROPERTIES:\n:ID: x\n:END:\n#+title: T\n');
    expect(doc.bomLength).toBe(1);
    expect(doc.nodes.map((node) => node.id)).toEqual(['x']);
    expect(doc.fileDrawer!.span.start).toBe(1);
  });

  it('only treats a BOM at the very start as a BOM', () => {
    expect(scan('\n\uFEFF* H\n').elements.map((element) => element.kind)).toEqual(['text']);
  });
});

describe('behaviors settled by conformance (task 3.4)', () => {
  const id = ':PROPERTIES:\n:ID: x\n:END:\n';

  it('replaces the default TODO keywords when a file declares any', () => {
    const doc = scan('#+TODO: NEXT | DROPPED\n* NEXT A\n* TODO B\n* DONE C\n');
    const titles = doc.elements.flatMap((element) => (element.kind === 'heading' ? [element.title] : []));
    expect(titles).toEqual(['A', 'TODO B', 'DONE C']);
    expect(doc.todoKeywords).toEqual(['NEXT', 'DROPPED']);
  });

  it.each([
    [':ROAM_EXCLUDE:', []],
    [':ROAM_EXCLUDE: t', []],
    [':ROAM_EXCLUDE: false', []],
    [':roam_exclude: t', []],
    [':ROAM_EXCLUDE: nil', ['a']],
  ])('treats %s as excluded unless it is nil', (property, ids) => {
    const doc = scan(`* A\n:PROPERTIES:\n:ID: a\n${property}\n:END:\n`);
    expect(doc.nodes.map((node) => node.id)).toEqual(ids);
  });

  it('allows spaces inside an angle link, not across lines', () => {
    const targets = (body: string) => scan(`${id}${body}\n`).links.map((link) => link.target);
    expect(targets('<id:a b>')).toEqual(['a b']);
    expect(targets('<id:a b\nc>')).toEqual(['a']);
  });

  it('does not inherit ROAM_EXCLUDE', () => {
    const doc = scan(`* A\n:PROPERTIES:\n:ID: a\n:ROAM_EXCLUDE: t\n:END:\n** B\n${id}`);
    expect(doc.nodes.map((node) => node.id)).toEqual(['x']);
  });

  it('records plain and angle id links', () => {
    const doc = scan(`${id}Plain id:abc, angle <id:def>, and not grid:abc.\n`);
    expect(doc.links.map((link) => [link.target, link.form])).toEqual([
      ['abc', 'plain'],
      ['def', 'angle'],
    ]);
  });

  it('records links in keywords and properties, except ROAM_REFS and transclude', () => {
    const doc = scan(
      ':PROPERTIES:\n:ID: x\n:SEE: [[id:a]]\n:ROAM_REFS: [[id:b]]\n:END:\n#+see: [[id:c]]\n#+transclude: [[id:d]]\n',
    );
    expect(doc.links.map((link) => link.target)).toEqual(['a', 'c']);
  });

  it('keeps each occurrence of a duplicate ID as a node', () => {
    const doc = scan(`* A\n${id}* B\n${id}`);
    expect(doc.nodes.map((node) => node.id)).toEqual(['x', 'x']);
  });
});
