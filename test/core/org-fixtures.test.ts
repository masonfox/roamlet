import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scan } from '../../src/core/org';

const FIXTURES = join(__dirname, '..', 'fixtures');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const read = (name: string) => readFileSync(join(FIXTURES, name)).toString('utf8');
const load = (name: string) => scan(read(name), { fileName: name });
const orgFiles = readdirSync(FIXTURES).filter((name) => name.endsWith('.org'));

describe('fixture corpus', () => {
  it('documents every fixture in the README', () => {
    const readme = read('README.md');
    const missing = orgFiles.filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it('keeps line endings and BOMs byte-exact', () => {
    const bytes = (name: string) => readFileSync(join(FIXTURES, name));
    const crlfPairs = (text: string) => text.split('\r\n').length - 1;
    const lineFeeds = (text: string) => text.split('\n').length - 1;

    const lf = read('line-endings-lf.org');
    expect(lf).not.toContain('\r');
    const crlf = read('line-endings-crlf.org');
    expect(crlfPairs(crlf)).toBe(lineFeeds(crlf));
    const mixed = read('line-endings-mixed.org');
    expect(crlfPairs(mixed)).toBeGreaterThan(0);
    expect(crlfPairs(mixed)).toBeLessThan(lineFeeds(mixed));
    const bomCrlf = read('bom-crlf.org');
    expect(crlfPairs(bomCrlf)).toBe(lineFeeds(bomCrlf));

    for (const name of ['bom.org', 'bom-crlf.org']) {
      expect([...bytes(name).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect(read('bom.org')).not.toContain('\r');
  });

  it.each(orgFiles)('keeps offsets in bounds and values consistent in %s', (name) => {
    const text = read(name);
    const doc = scan(text, { fileName: name });
    for (const element of doc.elements) {
      expect(element.span.start).toBeGreaterThanOrEqual(0);
      expect(element.span.end).toBeLessThanOrEqual(text.length);
    }
    for (const link of doc.links) {
      expect(text.slice(link.span.start, link.span.end)).toContain(link.target);
    }
    if (doc.titleKeyword) {
      const { valueSpan, value } = doc.titleKeyword;
      expect(text.slice(valueSpan.start, valueSpan.end)).toBe(value);
    }
  });
});

describe('fixture expectations', () => {
  it('headings.org', () => {
    const doc = load('headings.org');
    expect(doc.nodes.map(({ id: nodeId, level, title, tags }) => [nodeId, level, title, tags])).toEqual([
      [id(1), 0, 'Headings', []],
      [id(2), 1, 'Heading node', ['tag1']],
      [id(3), 2, 'Nested node', ['tag1', 'tag2', 'tag_3']],
      [id(4), 1, 'Commented heading', []],
    ]);
    expect(doc.elements.filter((element) => element.kind === 'heading')).toHaveLength(6);
  });

  it('todo-keywords.org', () => {
    expect(load('todo-keywords.org').nodes.slice(1).map((node) => node.title)).toEqual([
      'Declared with a fast key',
      'Declared after the bar',
      'Declared through SEQ_TODO',
      'Declared through TYP_TODO',
      'Built in',
      'LATER Not declared stays in the title',
      'todo Lowercase stays in the title',
    ]);
  });

  it('property-drawers.org', () => {
    const doc = load('property-drawers.org');
    expect(doc.nodes.map((node) => node.id)).toEqual([id(13), id(14), id(15)]);
    expect(doc.fileDrawer!.properties.map((property) => property.key)).toEqual(['id', 'CUSTOM']);
    expect(doc.links.map((link) => [link.target, link.source])).toEqual([[id(13), 0]]);
  });

  it('source-blocks.org', () => {
    const doc = load('source-blocks.org');
    expect(doc.links.map((link) => link.description)).toEqual(['counted']);
    const blocks = doc.elements.filter((element) => element.kind === 'block');
    expect(blocks.map((block) => block.kind === 'block' && block.name)).toEqual([
      'src',
      'src',
      'example',
      'comment',
      'export',
      'src',
      'quote',
    ]);
  });

  it('comma-escapes.org', () => {
    const doc = load('comma-escapes.org');
    expect(doc.nodes.map((node) => node.title)).toEqual(['Comma escapes', 'Real heading']);
    expect(doc.links).toEqual([]);
  });

  it('links.org', () => {
    const doc = load('links.org');
    expect(doc.links.map((link) => [link.target, link.description, link.form, link.source])).toEqual([
      [id(1), 'link in a keyword', 'bracket', 0],
      [id(1), 'a link', 'bracket', 0],
      [id(2), null, 'bracket', 0],
      [id(3), 'bold', 'bracket', 0],
      [id(4), null, 'bracket', 0],
      [id(5), 'two\nlines', 'bracket', 0],
      [id(6), null, 'plain', 0],
      [id(7), null, 'angle', 0],
      [id(10), 'to a note', 'bracket', 1],
      [id(11), null, 'bracket', 1],
      [id(13), null, 'bracket', 1],
      [id(14), null, 'bracket', 1],
      [id(15), null, 'bracket', 0],
    ]);
  });

  it('links-no-file-node.org', () => {
    const doc = load('links-no-file-node.org');
    expect(doc.links.map((link) => [link.target, link.source])).toEqual([
      [id(1), null],
      [id(2), null],
      [id(3), 0],
    ]);
  });

  it('metadata.org', () => {
    const doc = load('metadata.org');
    expect(doc.title).toBe('Example');
    expect(doc.tags).toEqual(['a', 'b', 'c']);
    expect(doc.nodes).toEqual([]);
  });

  it('20260101120000-foo.org', () => {
    const doc = load('20260101120000-foo.org');
    expect(doc.nodes.map((node) => [node.id, node.title])).toEqual([[id(24), '20260101120000-foo']]);
  });

  it.each([
    ['comments-before-drawer.org', [id(25)]],
    ['drawer-after-content.org', []],
    ['keyword-before-drawer.org', []],
    ['heading-nodes-no-file-id.org', [id(28), id(29)]],
    ['excluded-file.org', [id(35)]],
    ['duplicate-ids-a.org', [id(52), id(53), id(53)]],
    ['duplicate-ids-b.org', [id(52)]],
  ])('%s', (name, ids) => {
    expect(load(name).nodes.map((node) => node.id)).toEqual(ids);
  });

  it('excluded.org', () => {
    const doc = load('excluded.org');
    expect(doc.nodes.map((node) => node.id)).toEqual([id(30), id(32), id(33)]);
    expect(doc.links.map((link) => link.source)).toEqual([0]);
  });

  it('line-endings-*.org', () => {
    const summary = (name: string) => {
      const doc = load(name);
      return {
        title: doc.title,
        tags: doc.tags,
        nodes: doc.nodes.map(({ level, title, tags }) => ({ level, title, tags })),
        links: doc.links.map(({ target, description, source }) => ({ target, description, source })),
      };
    };
    const lf = summary('line-endings-lf.org');
    expect(lf.nodes).toHaveLength(2);
    expect(lf.links.map((link) => link.target)).toEqual([id(1), id(3)]);
    expect(load('line-endings-lf.org').eol).toBe('lf');
    expect(load('line-endings-crlf.org').eol).toBe('crlf');
    expect(load('line-endings-mixed.org').eol).toBe('mixed');
    expect(summary('line-endings-crlf.org')).toEqual(lf);
    expect(summary('line-endings-mixed.org')).toEqual(lf);
  });

  it.each([
    ['bom.org', id(42)],
    ['bom-crlf.org', id(43)],
  ])('%s', (name, nodeId) => {
    const doc = load(name);
    expect(doc.bomLength).toBe(1);
    expect(doc.nodes.map((node) => node.id)).toEqual([nodeId]);
    expect(doc.title).toBe('With a BOM');
    expect(doc.links.map((link) => link.target)).toEqual([id(1)]);
  });

  it('unicode.org', () => {
    const text = read('unicode.org');
    const doc = scan(text);
    expect(doc.title).toBe('東京のカフェ ☕ Notes');
    expect(doc.tags).toEqual(['日本語', 'café']);
    expect(doc.nodes[1]).toMatchObject({ title: '見出し ノード', tags: ['日本語', 'café', 'タグ'] });
    expect(doc.links.map((link) => link.description)).toEqual(['説明 🎉', 'עולם', null]);
    const [first] = doc.links;
    expect(text.slice(first.span.start, first.span.end)).toBe(`[[id:${id(1)}][説明 🎉]]`);
  });

  it('malformed-drawers.org', () => {
    const doc = load('malformed-drawers.org');
    expect(doc.nodes.map((node) => [node.id, node.title])).toEqual([
      [id(49), 'Valid heading after the damage'],
    ]);
    expect(doc.links.map((link) => [link.target, link.source])).toEqual([
      [id(1), null],
      [id(2), 0],
    ]);
  });

  it('unterminated-block.org', () => {
    const doc = load('unterminated-block.org');
    expect(doc.nodes.map((node) => node.title)).toEqual([
      'Unterminated blocks',
      'Heading ends the unterminated block',
    ]);
    expect(doc.elements.some((element) => element.kind === 'block')).toBe(false);
    // The deliberate star line is a level 1 heading with no ID, which closes the heading node.
    expect(doc.elements.filter((element) => element.kind === 'heading')).toHaveLength(2);
    expect(doc.links.map((link) => [link.target, link.source])).toEqual([
      [id(1), 0],
      [id(2), 0],
      [id(3), 0],
    ]);
  });

  it('sync-conflict copies hold the same nodes as the original', () => {
    const ids = (name: string) => load(name).nodes.map((node) => node.id);
    expect(ids('note.org')).toEqual([id(54), id(55)]);
    expect(ids('note.sync-conflict-20260115-093000-ABCDEFG.org')).toEqual(ids('note.org'));
    expect(ids("note (Laptop's conflicted copy 2026-01-15).org")).toEqual(ids('note.org'));
  });

  it('broken-links.org', () => {
    const doc = load('broken-links.org');
    // Unclosed and empty-description bracket links leave a plain link behind (best guess, task 3.4).
    expect(doc.links.map((link) => [link.target, link.form])).toEqual([
      ['00000000-0000-4000-8000-999999999999', 'bracket'],
      [id(1), 'plain'],
      [id(1), 'plain'],
    ]);
    expect(doc.links[0].description).toBe('gone');
  });
});
