import { compare, diff, scanFiles } from '../emacs/compare';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const drawer = (id: string) => `:PROPERTIES:\n:ID: ${id}\n:END:\n`;
const fileNode = (overrides = {}) => ({
  id: ID,
  file: 'a.org',
  level: 0,
  pos: 1,
  title: 'A',
  tags: [],
  ...overrides,
});
const scanned = (text: string) => scanFiles({ 'a.org': text });

describe('scanFiles', () => {
  it('puts nodes and links in the oracle shape', () => {
    const result = scanned(`${drawer(ID)}#+title: A\n#+filetags: :b:a:\n[[id:${OTHER}]]\n`);
    expect(result.files).toEqual(['a.org']);
    expect(result.nodes).toEqual([fileNode({ tags: ['a', 'b'] })]);
    expect(result.links).toEqual([{ source: ID, dest: OTHER }]);
  });

  it('leaves out links with no source', () => {
    expect(scanned(`[[id:${OTHER}]]\n`).links).toEqual([]);
  });

  it.each([
    ['LF', `é😀\n* T\n${drawer(ID)}`, 4],
    ['consistent CRLF, which Emacs hides', `é😀\n* T\n${drawer(ID)}`.replace(/\n/g, '\r\n'), 4],
    ['mixed line endings, which Emacs keeps', `é😀\r\n* T\n${drawer(ID)}`, 5],
    ['a BOM, which Emacs drops', `\ufeffé😀\n* T\n${drawer(ID)}`, 4],
  ])('converts offsets to Emacs positions with %s', (_name, text, pos) => {
    expect(scanned(text).nodes[0].pos).toBe(pos);
  });
});

describe('diff', () => {
  const base = { files: ['a.org'], nodes: [fileNode()], links: [{ source: ID, dest: OTHER }] };

  it('finds nothing in equal results', () => {
    expect(diff(base, base)).toEqual([]);
  });

  it('reports files on either side', () => {
    expect(diff(base, { ...base, files: ['b.org'] })).toEqual([
      'file-only-in-oracle a.org',
      'file-only-in-scanner b.org',
    ]);
  });

  it('reports nodes on either side', () => {
    expect(diff(base, { ...base, nodes: [] })).toEqual([`node-only-in-oracle a.org ${ID} "A"`]);
    expect(diff({ ...base, nodes: [] }, base)).toEqual([`node-only-in-scanner a.org ${ID} "A"`]);
  });

  it.each([
    ['level', { level: 1 }, 'oracle=0 scanner=1'],
    ['pos', { pos: 2 }, 'oracle=1 scanner=2'],
    ['title', { title: 'B' }, 'oracle="A" scanner="B"'],
    ['tags', { tags: ['x'] }, 'oracle=[] scanner=["x"]'],
  ])('reports a different %s', (field, change, values) => {
    expect(diff(base, { ...base, nodes: [fileNode(change)] })).toEqual([
      `node-${field} a.org ${ID} ${values}`,
    ]);
  });

  it('pairs a repeated ID with its own heading before reporting the rest', () => {
    const first = fileNode({ level: 1, pos: 10, title: 'First' });
    const second = fileNode({ level: 1, pos: 20, title: 'Second' });
    expect(diff({ ...base, nodes: [second] }, { ...base, nodes: [first, second] })).toEqual([
      `node-only-in-scanner a.org ${ID} "First"`,
    ]);
  });

  it('reports different link counts', () => {
    const link = { source: ID, dest: OTHER };
    expect(diff(base, { ...base, links: [link, link] })).toEqual([
      `link ${ID} -> ${OTHER} oracle=1 scanner=2`,
    ]);
    expect(diff(base, { ...base, links: [] })).toEqual([`link ${ID} -> ${OTHER} oracle=1 scanner=0`]);
  });
});

describe('compare', () => {
  it('passes a listed difference', () => {
    expect(compare(['x'], [{ difference: 'x', reason: 'because' }])).toEqual({
      unexpected: [],
      stale: [],
      unjustified: [],
    });
  });

  it('fails an unlisted difference', () => {
    expect(compare(['x'], []).unexpected).toEqual(['x']);
  });

  it('fails an entry that no longer applies', () => {
    expect(compare([], [{ difference: 'x', reason: 'because' }]).stale).toEqual(['x']);
  });

  it('fails an entry with no reason', () => {
    expect(compare(['x'], [{ difference: 'x', reason: ' ' }]).unjustified).toEqual(['x']);
  });
});
