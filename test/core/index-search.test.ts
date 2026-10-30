import * as fc from 'fast-check';

import { LibraryIndex } from '../../src/core/index';
import { MemoryFileStore } from '../support/memory-file-store';
import { useIndexHost } from './index-helpers';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_H = '00000000-0000-4000-8000-00000000000c';

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

describe('search', () => {
  const env = useIndexHost();
  let index: LibraryIndex;

  beforeEach(async () => {
    index = await LibraryIndex.open(env.host, 'lib');
  });
  afterEach(() => index.close());

  const titles = async (query: string) => (await index.search(query)).map((hit) => hit.title);

  it('Scenario: Title and body matches — both appear, with the title match first', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'a-body.org': note(ID_A, 'Unrelated', 'a sentence about gardening'),
        'z-title.org': note(ID_B, 'Gardening'),
      }),
    );

    expect(await titles('gardening')).toEqual(['Gardening', 'Unrelated']);
  });

  it('ranks a title match first even against a body that repeats the word', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'body.org': note(ID_A, 'Short', 'gardening '.repeat(200)),
        'title.org': note(ID_B, `Notes about many things and also gardening ${'word '.repeat(200)}`),
      }),
    );

    expect((await index.search('gardening')).map((hit) => hit.filePath)).toEqual([
      'title.org',
      'body.org',
    ]);
  });

  it('weights the title through bm25 when no result has every term in its title', async () => {
    // Same terms and lengths, so with equal column weights the path would put `b-` second.
    await index.reconcile(
      new MemoryFileStore({
        'a-title-word.org': note(ID_A, 'gardening', 'tomatoes padding'),
        'b-both-in-body.org': note(ID_H, 'unrelated', 'gardening tomatoes'),
        'z-title-word.org': note(ID_B, 'tomatoes', 'gardening padding'),
      }),
    );

    const hits = (await index.search('gardening tomatoes')).map((hit) => hit.filePath);

    expect(hits[hits.length - 1]).toBe('b-both-in-body.org');
  });

  it('Scenario: Heading-level node in results — marked as a heading, with its file', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'file.org': `${note(ID_A, 'The file')}* A heading topic\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\nOwned body words\n`,
      }),
    );

    expect(await index.search('topic')).toEqual([
      {
        filePath: 'file.org',
        fileTitle: 'The file',
        fileStatus: 'ok',
        nodeId: ID_H,
        level: 1,
        title: 'A heading topic',
        startOffset: expect.any(Number),
      },
    ]);
    expect((await index.search('owned'))[0].nodeId).toBe(ID_H);
    expect((await index.search('The file'))[0]).toMatchObject({ nodeId: ID_A, level: 0, startOffset: 0 });
  });

  it('gives text to its nearest node, and text outside any node to a file row', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'mixed.org': `#+title: Mixed\nloose words\n* Plain heading\nunderplain\n* Node heading\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\nnodewords\n** Sub plain\nsubwords\n`,
      }),
    );

    expect((await index.search('loose'))[0]).toMatchObject({ nodeId: null, title: 'Mixed', level: 0 });
    expect((await index.search('underplain'))[0]).toMatchObject({ nodeId: null });
    expect((await index.search('plain'))[0]).toMatchObject({ nodeId: null });
    expect((await index.search('nodewords'))[0]).toMatchObject({ nodeId: ID_H });
    expect((await index.search('subwords'))[0]).toMatchObject({ nodeId: ID_H });
    expect((await index.search('Mixed'))[0]).toMatchObject({ nodeId: null, filePath: 'mixed.org' });
  });

  it('finds files without nodes, including by a title from the file name', async () => {
    await index.reconcile(
      new MemoryFileStore({ 'nameonly.org': 'body words\n', 'titled.org': '#+title: Titled\n' }),
    );

    expect(await titles('nameonly')).toEqual(['nameonly']);
    expect(await titles('body')).toEqual(['nameonly']);
    expect(await titles('titled')).toEqual(['Titled']);
  });

  it('matches word prefixes as the user types, with every term required', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'a.org': note(ID_A, 'One', 'gardening tomatoes'),
        'b.org': note(ID_B, 'Two', 'gardening roses'),
      }),
    );

    expect(await titles('gard')).toEqual(expect.arrayContaining(['One', 'Two']));
    expect(await titles('ard')).toEqual([]);
    expect(await titles('gard tom')).toEqual(['One']);
    expect(await titles('tom rose')).toEqual([]);
  });

  it('Scenario: Search while offline — works with no file store at all', async () => {
    const store = new MemoryFileStore({ 'a.org': note(ID_A, 'Findable') });
    await index.reconcile(store);
    store.failOperation('list');
    store.failOperation('readBytes');
    store.calls = [];

    expect(await titles('findable')).toEqual(['Findable']);
    expect(store.calls).toEqual([]);
  });

  it('Scenario: Diacritics — cafe finds café, in either spelling and direction', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'nfc.org': note(ID_A, 'One', 'Café society'),
        'nfd.org': note(ID_B, 'Two', 'Café racer'),
      }),
    );

    expect((await titles('cafe')).sort()).toEqual(['One', 'Two']);
    expect((await titles('café')).sort()).toEqual(['One', 'Two']);
    expect((await titles('CAFÉ')).sort()).toEqual(['One', 'Two']);
  });

  it('Scenario: CJK text — finds a word inside an unsegmented run', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'body.org': note(ID_A, 'Body note', 'これは日本語のテキストです。'),
        'title.org': note(ID_B, '日本語のノート'),
        'other.org': note('00000000-0000-4000-8000-00000000000d', 'Other', '中文内容'),
      }),
    );

    expect(await titles('日本語')).toEqual(['日本語のノート', 'Body note']);
    expect(await titles('本語の')).toEqual(['日本語のノート', 'Body note']);
    expect(await titles('中文')).toEqual(['Other']);
    expect(await titles('韓国語')).toEqual([]);
  });

  it('finds Korean and Thai text the same way', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'ko.org': note(ID_A, 'Korean', '오늘은 한국어로 씁니다'),
        'th.org': note(ID_B, 'Thai', 'วันนี้อากาศดีมาก'),
      }),
    );

    expect(await titles('한국')).toEqual(['Korean']);
    expect(await titles('อากาศ')).toEqual(['Thai']);
  });

  it('matches CJK spelled with composed or decomposed marks', async () => {
    await index.reconcile(new MemoryFileStore({ 'a.org': note(ID_A, 'Kana', 'ガイド') }));

    expect(await titles('ガイド'.normalize('NFD'))).toEqual(['Kana']);
  });

  it('combines CJK and other terms, keeping prefix and diacritic handling for the latter', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'both.org': note(ID_A, 'Both', '日本語 and café'),
        'cjk.org': note(ID_B, 'Cjk', '日本語 only'),
        'latin.org': note(ID_H, 'Latin', 'café only'),
      }),
    );

    expect(await titles('日本語 caf')).toEqual(['Both']);
  });

  it('treats LIKE wildcards in a CJK query as literal', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'a.org': note(ID_A, 'Plain', '日本語'),
        'b.org': note(ID_B, 'Percent', '日%語 と 日_語'),
      }),
    );

    expect(await titles('日%語')).toEqual(['Percent']);
    expect(await titles('日_語')).toEqual(['Percent']);
    expect(await titles('語\\')).toEqual([]);
  });

  it('Scenario: No results — an empty list, and blank queries find nothing', async () => {
    await index.reconcile(new MemoryFileStore({ 'a.org': note(ID_A, 'A') }));

    expect(await index.search('zzzzz')).toEqual([]);
    expect(await index.search('')).toEqual([]);
    expect(await index.search('   ')).toEqual([]);
    expect(await index.search('--- *** "')).toEqual([]);
  });

  describe('metadata stays out', () => {
    beforeEach(async () => {
      await index.reconcile(
        new MemoryFileStore({
          'a.org': [
            ':PROPERTIES:',
            `:ID:       ${ID_A}`,
            ':CUSTOM:   propertyvalue',
            ':END:',
            '#+title: Visible',
            '#+filetags: :filetagword:',
            '#+author: keywordvalue',
            '# commentword',
            `A link [[id:${ID_B}][shownlabel]] and bare [[id:${ID_H}]] and <id:${ID_H}> too.`,
            'A [[https://example.com/urlword][sitelabel]] link.',
            '* TODO Heading :tagword:',
            'SCHEDULED: <2026-01-02 Fri>',
            ':PROPERTIES:',
            `:ID:       ${ID_H}`,
            ':END:',
            '#+begin_src python',
            'codeword = 1',
            '#+end_src',
            '#+begin_comment',
            'blockcomment',
            '#+end_comment',
            '',
          ].join('\n'),
        }),
      );
    });

    it.each([
      ['a file node ID', ID_A],
      ['part of an ID', '00000000'],
      ['the last group of an ID', ID_A.split('-')[4]],
      ['a heading node ID', ID_H],
      ['a link target ID', ID_B],
      ['the ID property key', 'PROPERTIES'],
      ['a property value', 'propertyvalue'],
      ['a keyword name', 'filetags'],
      ['a keyword value', 'keywordvalue'],
      ['a file tag', 'filetagword'],
      ['a heading tag', 'tagword'],
      ['a TODO keyword', 'TODO'],
      ['a planning line', 'SCHEDULED'],
      ['a comment line', 'commentword'],
      ['a block marker', 'begin_src'],
      ['a comment block', 'blockcomment'],
      ['a link target URL behind a description', 'urlword'],
    ])('does not match %s', async (_name, query) => {
      expect(await index.search(query)).toEqual([]);
    });

    it.each([
      ['a link description', 'shownlabel'],
      ['a web link description', 'sitelabel'],
      ['source block text', 'codeword'],
      ['the title', 'Visible'],
      ['a heading title', 'Heading'],
    ])('still matches %s', async (_name, query) => {
      expect((await index.search(query)).length).toBeGreaterThan(0);
    });

    it('does not match a raw ID through the CJK fallback either', async () => {
      expect(await index.search(`日本語 ${ID_A}`)).toEqual([]);
    });
  });

  it('removes markup from search text, and comma escapes from block text', async () => {
    await index.reconcile(
      new MemoryFileStore({
        'a.org': '#+title: T\nSome *日本語* in bold\n#+begin_example\n,* escaped\n#+end_example\n',
      }),
    );
    const db = await env.host.open('index-lib.db');
    const row = await db.get<{ body: string }>('SELECT body FROM search');
    await db.close();

    expect(row?.body).toBe('Some 日本語 in bold\n* escaped\n');
  });

  describe('FTS syntax in user queries', () => {
    beforeEach(async () => {
      await index.reconcile(
        new MemoryFileStore({
          'a.org': note(ID_A, 'C++ and AND or NOT near', 'Say "hello" (world) foo-bar title:thing a*b ^start'),
        }),
      );
    });

    it.each([
      'AND',
      'OR',
      'NOT',
      'NEAR',
      'NEAR(a b)',
      'near/2',
      'hello AND',
      'AND hello',
      'OR OR',
      'NOT hello',
      '"hello',
      'hello"',
      '"',
      '""',
      '"hello" "',
      '(hello',
      'hello)',
      '()',
      '*',
      'hello*',
      '*hello',
      '^hello',
      '^',
      '-hello',
      'foo-bar',
      '+',
      'c++',
      'title:',
      'title:hello',
      'body:hello',
      'nosuchcolumn:hello',
      '{title}:hello',
      '{title body}',
      ':',
      'a:b:c',
      ',',
      ';',
      "'",
      "' OR 1=1 --",
      '%',
      '_',
      '\\',
      '\u0000',
      'hello\u0000world',
      '😀',
      '\uD83D',
    ])('does not throw on %j', async (query) => {
      await expect(index.search(query)).resolves.toEqual(expect.any(Array));
    });

    it('reads operators and punctuation as literal words', async () => {
      expect(await titles('AND')).toHaveLength(1);
      expect(await titles('hello AND world')).toHaveLength(1);
      expect(await titles('NOT hello')).toHaveLength(1);
      expect(await titles('"hello"')).toHaveLength(1);
      expect(await titles('(world)')).toHaveLength(1);
      expect(await titles('foo-bar')).toHaveLength(1);
      expect(await titles('c++')).toHaveLength(1);
      expect(await titles('title:thing')).toHaveLength(1);
      expect(await titles('zzz OR hello')).toEqual([]);
      expect(await titles('title:hello')).toEqual([]);
    });

    it('never throws on arbitrary input', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string({ unit: 'binary', maxLength: 40 }), async (query) => {
          await expect(index.search(query)).resolves.toEqual(expect.any(Array));
        }),
        { numRuns: 200 },
      );
    });
  });

  it('honors the limit, and orders ties by path', async () => {
    const files: Record<string, string> = {};
    for (let i = 9; i >= 0; i -= 1) files[`n${i}.org`] = '#+title: same\n';
    await index.reconcile(new MemoryFileStore(files));

    const hits = await index.search('same', { limit: 3 });

    expect(hits.map((hit) => hit.filePath)).toEqual(['n0.org', 'n1.org', 'n2.org']);
  });
});
