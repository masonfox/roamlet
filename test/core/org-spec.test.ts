import { scan } from '../../src/core/org';

// One test per scenario in openspec/changes/add-roamlet-mvp/specs/org-parsing/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const drawer = `:PROPERTIES:\n:ID: ${ID}\n:END:\n`;

describe('File-level node recognition', () => {
  it('Standard Org-roam file header', () => {
    const doc = scan(`${drawer}#+title: Zettel\n`);
    expect(doc.nodes).toEqual([{ id: ID, level: 0, title: 'Zettel', tags: [], startOffset: 0 }]);
  });

  it('Drawer after other content', () => {
    const doc = scan(`A paragraph.\n\n${drawer}#+title: Zettel\n`);
    expect(doc.nodes).toEqual([]);
    expect(doc.fileDrawer).toBeNull();
  });

  it('Comments before the drawer', () => {
    const doc = scan(`\n# a comment\n#\n\n${drawer}`);
    expect(doc.nodes.map((node) => node.id)).toEqual([ID]);
  });

  it('matches drawer and keyword names case-insensitively', () => {
    const doc = scan(`:properties:\n:id: ${ID}\n:end:\n#+TiTlE: Zettel\n`);
    expect(doc.nodes).toEqual([{ id: ID, level: 0, title: 'Zettel', tags: [], startOffset: 0 }]);
  });
});

describe('Heading-level node recognition', () => {
  it('Heading with an ID', () => {
    const prefix = 'Some text.\n';
    const doc = scan(`${prefix}* TODO [#A] Heading node :tag1:\n${drawer}`);
    expect(doc.nodes).toEqual([
      { id: ID, level: 1, title: 'Heading node', tags: ['tag1'], startOffset: prefix.length },
    ]);
  });

  it('Heading without an ID', () => {
    const doc = scan(`${drawer}#+title: File\n* No ID\nOwned text [[id:x]].\n`);
    expect(doc.nodes.map((node) => node.id)).toEqual([ID]);
    expect(doc.links[0].source).toBe(0);
    expect(doc.elements.filter((element) => element.kind === 'text')[0].owner).toBe(0);
  });

  it('File with heading nodes but no file-level ID', () => {
    const doc = scan(`* One\n${drawer}* Two\n:PROPERTIES:\n:ID: other\n:END:\n`);
    expect(doc.nodes.map((node) => [node.id, node.level])).toEqual([
      [ID, 1],
      ['other', 1],
    ]);
  });
});

describe('Node exclusion', () => {
  it('Excluded heading', () => {
    const text = `* Excluded\n:PROPERTIES:\n:ID: ${ID}\n:ROAM_EXCLUDE: t\n:END:\nBody\n`;
    const doc = scan(text);
    expect(doc.nodes).toEqual([]);
    const heading = doc.elements[0];
    expect(heading.kind === 'heading' && heading.node).toBeNull();
    expect(text.slice(heading.span.start, heading.span.end)).toBe('* Excluded');
  });
});

describe('File metadata extraction', () => {
  it('Keyword case and tag format', () => {
    const doc = scan('#+FILETAGS: :a:b:\n#+TITLE: Example\n');
    expect(doc.tags).toEqual(['a', 'b']);
    expect(doc.title).toBe('Example');
  });

  it('Missing title', () => {
    const doc = scan(`${drawer}Text.\n`, { fileName: '20260101120000-foo.org' });
    expect(doc.title).toBe('20260101120000-foo');
    expect(doc.titleKeyword).toBeNull();
    expect(doc.nodes[0].title).toBe('20260101120000-foo');
  });
});

describe('ID link recognition', () => {
  const inNode = (body: string) => scan(`${drawer}${body}\n`);

  it('Link with a description', () => {
    const body = 'See [[id:1111][a link]] here.';
    const doc = inNode(body);
    const start = drawer.length + body.indexOf('[[');
    expect(doc.links).toEqual([
      {
        target: '1111',
        description: 'a link',
        form: 'bracket',
        span: { start, end: start + '[[id:1111][a link]]'.length },
        source: 0,
      },
    ]);
  });

  it('recognizes a link without a description', () => {
    const doc = inNode('[[id:1111]]');
    expect(doc.links.map((link) => [link.target, link.description])).toEqual([['1111', null]]);
  });

  it('Link inside a source block', () => {
    expect(inNode('#+begin_src text\n[[id:1111]]\n#+end_src').links).toEqual([]);
  });

  it('ignores links in example blocks, comment lines, and fixed-width lines', () => {
    expect(inNode('#+begin_example\n[[id:1111]]\n#+end_example').links).toEqual([]);
    expect(inNode('# [[id:1111]]').links).toEqual([]);
    expect(inNode(': [[id:1111]]').links).toEqual([]);
  });

  it('Link inside inline verbatim markup', () => {
    expect(inNode('A =[[id:1111]]= b').links).toEqual([]);
    expect(inNode('A ~[[id:1111]]~ b').links).toEqual([]);
  });

  it('Link outside any node', () => {
    const doc = scan('Text [[id:1111]].\n* Heading\nText [[id:2222]].\n');
    expect(doc.nodes).toEqual([]);
    expect(doc.links.map((link) => link.source)).toEqual([null, null]);
  });
});

describe('Org block and heading precedence', () => {
  it('Comma-escaped heading in a source block', () => {
    const block = '#+begin_src org\n,* not a heading\n#+end_src';
    const doc = scan(`${block}\n`);
    expect(doc.elements.map((element) => element.kind)).toEqual(['block']);
    expect(doc.elements[0].span).toEqual({ start: 0, end: block.length });
  });

  it('treats an unescaped star line inside a block as a heading', () => {
    const doc = scan('#+begin_src org\n* a heading\n#+end_src\n');
    expect(doc.elements.map((element) => element.kind)).toEqual(['text', 'heading', 'text']);
  });

  it('Unterminated block', () => {
    const doc = scan(`${drawer}#+begin_src text\n[[id:1111]]\n* Next\n#+end_src\n`);
    expect(doc.elements.some((element) => element.kind === 'block')).toBe(false);
    expect(doc.links.map((link) => link.target)).toEqual(['1111']);
  });
});

describe('Tolerant parsing', () => {
  it('Malformed drawer', () => {
    const doc = scan(`:PROPERTIES:\n:ID: lost\n\n* Later\n${drawer}`);
    expect(doc.nodes.map((node) => node.id)).toEqual([ID]);
    const heading = doc.elements.find((element) => element.kind === 'heading');
    expect(heading?.kind === 'heading' && heading.title).toBe('Later');
  });

  it('Line endings', () => {
    const text = `${drawer}#+title: T\n#+filetags: :a:\n[[id:1][d]]\n* H\n${drawer}[[id:2]]\n`;
    const lf = scan(text);
    const crlf = scan(text.replace(/\n/g, '\r\n'));
    const summary = (doc: typeof lf) => ({
      title: doc.title,
      tags: doc.tags,
      nodes: doc.nodes.map(({ id, level, title, tags }) => ({ id, level, title, tags })),
      links: doc.links.map(({ target, description, source }) => ({ target, description, source })),
    });
    expect(lf.nodes).toHaveLength(2);
    expect(lf.links).toHaveLength(2);
    expect(summary(crlf)).toEqual(summary(lf));
  });
});
