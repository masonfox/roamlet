import { editableBody, editableTitle, scan, spliceBody, spliceTitle } from '../../src/core/org';

// Scenarios from openspec/changes/add-roamlet-mvp/specs/note-capture-editing/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const BOM = '﻿';

function retitle(text: string, title: string) {
  return spliceTitle(text, scan(text), title);
}

describe('Non-destructive save: spliceTitle', () => {
  it('Title edit', () => {
    const text = `:PROPERTIES:\n:ID:   ${ID}\n:END:\n#+TITLE:   Old\nBody\n`;
    const start = text.indexOf('Old');
    expect(retitle(text, 'New')).toEqual({
      changed: true,
      text: `:PROPERTIES:\n:ID:   ${ID}\n:END:\n#+TITLE:   New\nBody\n`,
      span: { start, end: start + 'Old'.length },
      replacement: 'New',
    });
  });

  it('keeps blanks after the value and CRLF line endings', () => {
    const result = retitle('#+Title:\tOld  \r\nBody\r\n', 'New');
    expect(result.text).toBe('#+Title:\tNew  \r\nBody\r\n');
  });

  it('adds a blank after a keyword with no value', () => {
    expect(retitle('#+title:\nBody\n', 'New').text).toBe('#+title: New\nBody\n');
    expect(retitle('#+title:   \nBody\n', 'New').text).toBe('#+title:   New\nBody\n');
  });

  it('replaces only the first title keyword', () => {
    expect(retitle('#+title: One\n#+title: Two\n', 'New').text).toBe('#+title: New\n#+title: Two\n');
  });

  it('Title added to a file without one', () => {
    const drawer = `:PROPERTIES:\n:ID:   ${ID}\n:END:\n`;
    const result = retitle(`${drawer}Body\n`, 'New');
    expect(result).toEqual({
      changed: true,
      text: `${drawer}#+title: New\nBody\n`,
      span: { start: drawer.length, end: drawer.length },
      replacement: '#+title: New\n',
    });
  });

  it('Title added to a file without one, with no drawer', () => {
    expect(retitle('Body\n* Heading\n', 'New').text).toBe('#+title: New\nBody\n* Heading\n');
  });

  it('adds the title after the byte order mark', () => {
    expect(retitle(`${BOM}Body\n`, 'New').text).toBe(`${BOM}#+title: New\nBody\n`);
    expect(retitle(`${BOM}:PROPERTIES:\n:END:\nBody\n`, 'New').text).toBe(
      `${BOM}:PROPERTIES:\n:END:\n#+title: New\nBody\n`,
    );
  });

  it('adds the title using the line ending of the drawer', () => {
    expect(retitle(':PROPERTIES:\r\n:ID: a\r\n:END:\r\nBody\r\n', 'New').text).toBe(
      ':PROPERTIES:\r\n:ID: a\r\n:END:\r\n#+title: New\r\nBody\r\n',
    );
    expect(retitle('Body\r\n', 'New').text).toBe('#+title: New\r\nBody\r\n');
  });

  it('adds the title when the drawer ends the file without a line ending', () => {
    expect(retitle(':PROPERTIES:\n:ID: a\n:END:', 'New').text).toBe(
      ':PROPERTIES:\n:ID: a\n:END:\n#+title: New\n',
    );
  });

  it('adds the title to an empty file', () => {
    expect(retitle('', 'New').text).toBe('#+title: New\n');
  });

  it('places a new title after comments that precede the drawer', () => {
    const text = '# comment\n:PROPERTIES:\n:ID: a\n:END:\nBody\n';
    expect(retitle(text, 'New').text).toBe('# comment\n:PROPERTIES:\n:ID: a\n:END:\n#+title: New\nBody\n');
  });

  it('makes the added title the one the scanner finds', () => {
    const result = retitle(`:PROPERTIES:\n:ID: ${ID}\n:END:\nBody\n`, 'New');
    const doc = scan(result.text);
    expect(doc.title).toBe('New');
    expect(doc.nodes[0]).toMatchObject({ id: ID, title: 'New' });
    expect(editableBody(result.text, doc)).toBe('Body\n');
  });

  it('Save without changes', () => {
    const text = '#+TITLE:   Same  \nBody\n';
    expect(retitle(text, editableTitle(scan(text)))).toEqual({ changed: false, text });
  });

  it('does not add a title to a file that had none when the field stays empty', () => {
    const text = 'Body\n';
    const doc = scan(text, { fileName: 'note.org' });
    expect(doc.title).toBe('note');
    expect(editableTitle(doc)).toBe('');
    expect(spliceTitle(text, doc, editableTitle(doc))).toEqual({ changed: false, text });
  });

  it('keeps link syntax in a title that was not edited', () => {
    const text = '#+title: See [[id:abc][Other]]\n';
    const doc = scan(text);
    expect(doc.title).toBe('See Other');
    expect(spliceTitle(text, doc, editableTitle(doc)).changed).toBe(false);
  });

  it('keeps the title on one line', () => {
    expect(retitle('#+title: Old\nBody\n', ' Two\r\nlines\n').text).toBe('#+title: Two lines\nBody\n');
  });

  it('can clear a title, keeping the line', () => {
    expect(retitle('#+TITLE:   Old\nBody\n', '').text).toBe('#+TITLE:   \nBody\n');
  });

  it('combines with a body edit when the file is scanned again in between', () => {
    const text = `:PROPERTIES:\r\n:ID: ${ID}\r\n:END:\r\nBody\r\n`;
    const edited = spliceBody(text, scan(text), 'Changed\n');
    expect(retitle(edited.text, 'New').text).toBe(
      `:PROPERTIES:\r\n:ID: ${ID}\r\n:END:\r\n#+title: New\r\nChanged\r\n`,
    );
  });

  it('keeps both edits when the title keyword sits in the body', () => {
    const text = 'Some text\n#+title: Old\n';
    const doc = scan(text);
    const newBody = editableBody(text, doc).replace('Some', 'Other');
    const edited = spliceBody(text, doc, newBody);
    expect(retitle(edited.text, 'New').text).toBe('Other text\n#+title: New\n');
  });
});
