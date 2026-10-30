import { linkDisplayText, tokenizeInline } from '../../src/core/org';
import type { InlineToken } from '../../src/core/org';

/** A compact view: tokens as [type, text], with children nested. */
function view(text: string, tokens: InlineToken[]): unknown[] {
  return tokens.map((token) =>
    'children' in token
      ? [token.type, view(text, token.children)]
      : [token.type, text.slice(token.span.start, token.span.end)],
  );
}
const tokens = (text: string) => view(text, tokenizeInline(text));

describe('emphasis', () => {
  it.each([
    ['*bold*', 'bold'],
    ['/italic/', 'italic'],
    ['_underline_', 'underline'],
    ['+strike+', 'strike'],
  ])('recognizes %s', (text, type) => {
    expect(tokens(text)).toEqual([[type, [['text', text.slice(1, -1)]]]]);
  });

  it.each([
    ['=verbatim=', 'verbatim'],
    ['~code~', 'code'],
    ['=a=b=', 'verbatim'],
  ])('recognizes %s without parsing inside it', (text, type) => {
    expect(tokens(text)).toEqual([[type, text]]);
  });

  it('nests emphasis', () => {
    expect(tokens('*/both/*')).toEqual([['bold', [['italic', [['text', 'both']]]]]]);
  });

  it.each(['a*b*', '*a*b', '* a*', '*a *', '**', '2*3*4', 'file_name_here'])(
    'leaves %s as text',
    (text) => {
      expect(tokens(text)).toEqual([['text', text]]);
    },
  );

  it('accepts the documented neighbours', () => {
    expect(tokens('(*a*), "=b=". -~c~-')).toEqual([
      ['text', '('],
      ['bold', [['text', 'a']]],
      ['text', '), "'],
      ['verbatim', '=b='],
      ['text', '". -'],
      ['code', '~c~'],
      ['text', '-'],
    ]);
  });

  it('spans one line break but not two', () => {
    expect(tokens('=a\nb=')).toEqual([['verbatim', '=a\nb=']]);
    expect(tokens('=a\r\nb=')).toEqual([['verbatim', '=a\r\nb=']]);
    expect(tokens('=a\nb\nc=')).toEqual([['text', '=a\nb\nc=']]);
  });

  it('caps pathological nesting without overflowing the stack', () => {
    const text = `${'*a '.repeat(50_000)}a${'*'.repeat(50_000)}`;
    expect(() => tokenizeInline(text)).not.toThrow();
  });
});

describe('links', () => {
  const single = (text: string) => {
    const [token] = tokenizeInline(text);
    if (token.type !== 'link') throw new Error(`expected a link in ${text}`);
    return token;
  };

  it.each([
    ['[[id:abc]]', 'id', 'abc', null],
    ['[[id:abc][Desc]]', 'id', 'abc', 'Desc'],
    ['[[https://a.b/c][Web]]', 'https', '//a.b/c', 'Web'],
    ['[[file:a.org::*H]]', 'file', 'a.org::*H', null],
    ['[[Some heading]]', 'fuzzy', 'Some heading', null],
    ['[[a\\]b]]', 'fuzzy', 'a]b', null],
    ['[[id:x][with [inner] text]]', 'id', 'x', 'with [inner] text'],
    ['[[id:x][two\r\nlines]]', 'id', 'x', 'two\nlines'],
  ])('parses %s', (text, linkType, target, description) => {
    expect(single(text)).toMatchObject({ form: 'bracket', linkType, target, description });
  });

  it('reports spans against the original text', () => {
    const text = 'ab [[id:x][Desc]] cd';
    const [, link] = tokenizeInline(text);
    if (link.type !== 'link') throw new Error('expected a link');
    expect(text.slice(link.span.start, link.span.end)).toBe('[[id:x][Desc]]');
    expect(text.slice(link.descriptionSpan!.start, link.descriptionSpan!.end)).toBe('Desc');
  });

  it.each(['[[]]', '[[id:x', '[[id:x]', '[[id:x][]]', '[[id:x][desc', '[[a\nb]]', '[id:x]', '[[[id'])(
    'leaves %j without a bracket link',
    (text) => {
      const found = tokenizeInline(text).filter((token) => token.type === 'link');
      expect(found.filter((token) => token.type === 'link' && token.form === 'bracket')).toEqual([]);
    },
  );

  it('respects range bounds', () => {
    const text = 'x[[id:a]]y';
    expect(tokenizeInline(text, 1, 5)).toEqual([{ type: 'text', span: { start: 1, end: 5 } }]);
    expect(tokenizeInline(text, 1, 9)[0]).toMatchObject({ type: 'link', span: { start: 1, end: 9 } });
  });

  it('finds links inside emphasis', () => {
    expect(tokens('*[[id:a][b]]*')).toEqual([['bold', [['link', '[[id:a][b]]']]]]);
  });

  it('parses angle and plain forms', () => {
    expect(single('<https://a.b>')).toMatchObject({
      form: 'angle',
      linkType: 'https',
      target: '//a.b',
    });
    expect(single('id:abc.')).toMatchObject({ form: 'plain', linkType: 'id', target: 'abc' });
    expect(tokens('see https://a.b, then mid:x')).toEqual([
      ['text', 'see '],
      ['link', 'https://a.b'],
      ['text', ', then mid:x'],
    ]);
  });
});

describe('linkDisplayText', () => {
  it.each([
    ['plain', 'plain'],
    ['[[id:a][b]]', 'b'],
    ['[[id:a]]', 'id:a'],
    ['x [[id:a][b]] y [[c]] z', 'x b y c z'],
    ['[[broken', '[[broken'],
    ['[[ [[id:a][b]]', '[[ b'],
  ])('shows %s as %s', (raw, shown) => {
    expect(linkDisplayText(raw)).toBe(shown);
  });
});
