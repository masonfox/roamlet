import * as fc from 'fast-check';

import { alternateFileName, parseCapture, renderNewNote, scan, slugify } from '../../src/core/org';
import type { Clock, IdGenerator } from '../../src/core/ports';

// Scenarios from openspec/changes/add-roamlet-mvp/specs/note-capture-editing/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const ids: IdGenerator = { newId: () => ID };
const clock: Clock = { now: () => new Date(2026, 0, 15, 9, 30, 0) };

function render(text: string) {
  const note = renderNewNote(text, ids, clock);
  if (!note) throw new Error('expected a note');
  return note;
}

describe('Quick capture', () => {
  it('One-line capture', () => {
    expect(parseCapture('Buy a better notebook')).toEqual({
      title: 'Buy a better notebook',
      body: '',
    });
    expect(render('Buy a better notebook').content).toBe(
      `:PROPERTIES:\n:ID:       ${ID}\n:END:\n#+title: Buy a better notebook\n`,
    );
  });

  it('Multi-line capture', () => {
    expect(parseCapture('First line\nSecond line\n\nThird line\n')).toEqual({
      title: 'First line',
      body: 'Second line\n\nThird line',
    });
  });

  it('Long first line', () => {
    const line = `${'word '.repeat(30)}end`;
    const { title, body } = parseCapture(`${line}\nMore`)!;
    expect(title).toBe('word '.repeat(16).trimEnd());
    expect(Array.from(title).length).toBeLessThanOrEqual(80);
    expect(body).toBe(`${line}\nMore`);
  });

  it('Empty capture', () => {
    for (const text of ['', '   ', '\n\n', ' \t\r\n  \n']) {
      expect(parseCapture(text)).toBeNull();
      expect(renderNewNote(text, ids, clock)).toBeNull();
    }
  });

  it('uses the first non-empty line, skipping lines of only whitespace', () => {
    expect(parseCapture('\n  \n\t\n  Title  \n\n  indented body\n\n')).toEqual({
      title: 'Title',
      body: '  indented body',
    });
  });

  it('accepts CRLF and lone CR', () => {
    expect(parseCapture('Title\r\nOne\r\nTwo\rThree')).toEqual({
      title: 'Title',
      body: 'One\nTwo\nThree',
    });
  });

  it('keeps a first line of exactly 80 characters whole', () => {
    const line = 'x'.repeat(80);
    expect(parseCapture(line)).toEqual({ title: line, body: '' });
  });

  it('cuts at the limit when the first word is longer', () => {
    const line = 'x'.repeat(100);
    expect(parseCapture(line)).toEqual({ title: 'x'.repeat(80), body: line });
  });

  it('uses a word that ends exactly at the limit', () => {
    const first = 'x'.repeat(80);
    expect(parseCapture(`${first} more`)!.title).toBe(first);
  });

  it('does not split a surrogate pair when shortening', () => {
    const line = '😀'.repeat(100);
    const { title } = parseCapture(line)!;
    expect(title).toBe('😀'.repeat(80));
  });
});

describe('New note format', () => {
  it('Generated file content', () => {
    const note = render('Café Notes!\nThe body');
    expect(note.fileName).toBe('20260115093000-cafe_notes.org');
    expect(note.content).toBe(
      `:PROPERTIES:\n:ID:       ${ID}\n:END:\n#+title: Café Notes!\n\nThe body\n`,
    );
    const doc = scan(note.content);
    expect(doc.nodes).toEqual([
      { id: ID, level: 0, title: 'Café Notes!', tags: [], startOffset: 0 },
    ]);
    expect(doc.eol).toBe('lf');
  });

  it('Title with no usable slug characters', () => {
    expect(render('!!! ???').fileName).toBe('20260115093000-untitled.org');
    expect(render('😀').fileName).toBe('20260115093000-untitled.org');
  });

  it('Filename collision', () => {
    const existing = new Map([
      ['20260115093000-note.org', 'first'],
      ['20260115093000-note_2.org', 'second'],
    ]);
    const note = render('Note');
    // What capture does with createExclusive: move on when a name is taken, leaving that file be.
    let fileName = note.fileName;
    for (let attempt = 1; existing.has(fileName); attempt++) {
      fileName = alternateFileName(note.fileName, attempt);
    }
    expect(fileName).toBe('20260115093000-note_3.org');
    expect(existing.get('20260115093000-note.org')).toBe('first');
    expect(existing.get('20260115093000-note_2.org')).toBe('second');
  });

  it('Capture to a chosen folder', () => {
    expect(render('Sub/dir: note').fileName).toBe('20260115093000-sub_dir_note.org');
  });

  it('takes the ID from the generator and the timestamp from the clock', () => {
    const note = renderNewNote(
      'Note',
      { newId: () => 'aaaaaaaa-0000-4000-8000-000000000000' },
      { now: () => new Date(1999, 11, 31, 23, 59, 58) },
    );
    expect(note).toMatchObject({
      id: 'aaaaaaaa-0000-4000-8000-000000000000',
      fileName: '19991231235958-note.org',
    });
  });

  it('ends every file with one newline, using only LF', () => {
    const text = fc.string({ unit: 'grapheme', maxLength: 200 });
    fc.assert(
      fc.property(text, (capture) => {
        const note = renderNewNote(capture, ids, clock);
        if (!note) return;
        expect(note.content.endsWith('\n')).toBe(true);
        expect(note.content.endsWith('\n\n')).toBe(false);
        expect(note.content).not.toContain('\r');
        expect(note.fileName).toMatch(/^\d{14}-[^/\\]+\.org$/);
        expect(scan(note.content).nodes[0]).toMatchObject({ id: ID, level: 0 });
      }),
      { numRuns: 1000 },
    );
  });
});

describe('slugify', () => {
  it.each([
    ['Café Notes!', 'cafe_notes'],
    ['  Leading and trailing  ', 'leading_and_trailing'],
    ['many___under   scores--here', 'many_under_scores_here'],
    ['Crème Brûlée', 'creme_brulee'],
    ['Ünïcödé', 'unicode'],
    ['日本語 ノート', '日本語_ノート'],
    ['한글 노트', '한글_노트'],
    ['Version 2.0', 'version_2_0'],
    ['', 'untitled'],
    ['___', 'untitled'],
    ['😀 🙂', 'untitled'],
  ])('%s becomes %s', (title, slug) => {
    expect(slugify(title)).toBe(slug);
  });

  it('keeps file names within common filesystem limits', () => {
    const encoder = new TextEncoder();
    const slug = slugify('語'.repeat(80));
    expect(encoder.encode(`20260115093000-${slug}_99.org`).length).toBeLessThanOrEqual(255);
    expect(slug).toBe('語'.repeat(66));
  });

  it('does not end in an underscore after shortening', () => {
    const slug = slugify(`${'x'.repeat(199)} y`);
    expect(slug).toBe('x'.repeat(199));
  });
});
