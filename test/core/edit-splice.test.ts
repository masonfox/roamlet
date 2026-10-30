import { editableBody, scan, spliceBody } from '../../src/core/org';

// Scenarios from openspec/changes/add-roamlet-mvp/specs/note-capture-editing/spec.md.
const ID = '6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11';
const header = `:PROPERTIES:\n:ID:   ${ID}\n:END:\n#+TITLE:   Old\n`;

function editBody(text: string, edit: (body: string) => string) {
  const doc = scan(text);
  return spliceBody(text, doc, edit(editableBody(text, doc)));
}

function edited(text: string, edit: (body: string) => string): string {
  const result = editBody(text, edit);
  if (!result.changed) throw new Error('expected a change');
  return result.text;
}

describe('Plain-text editing', () => {
  it('Editing a note with complex syntax', () => {
    const body = [
      '* Heading',
      ':PROPERTIES:',
      ':ID: abc',
      ':END:',
      '#+begin_src python',
      'print("hi")',
      '#+end_src',
      '',
    ].join('\n');
    const text = header + body;
    expect(editableBody(text, scan(text))).toBe(body);
  });
});

describe('Non-destructive save: spliceBody', () => {
  it('Body edit', () => {
    const body = [
      '| a | b |',
      '|---+---|',
      '#+begin_src python',
      'print("word")',
      '#+end_src',
      ':CUSTOM:',
      'kept   as written',
      ':END:',
      'One word here.',
      '',
    ].join('\n');
    const text = header + body;
    const result = editBody(text, (current) => current.replace('word here', 'term here'));
    expect(result).toEqual({
      changed: true,
      text: text.replace('word here', 'term here'),
      span: { start: text.indexOf('word here'), end: text.indexOf('word here') + 'word'.length },
      replacement: 'term',
    });
  });

  it('Save without changes', () => {
    const text = `${header}Body\r\nwith\nmixed\rendings\n`;
    expect(editBody(text, (body) => body)).toEqual({ changed: false, text });
  });

  it('treats line endings a text input converted as no change', () => {
    const text = `${header}a\r\nb\rc\n`;
    const doc = scan(text);
    expect(spliceBody(text, doc, 'a\r\nb\nc\n').changed).toBe(false);
    expect(spliceBody(text, doc, 'a\nb\rc\r\n').changed).toBe(false);
  });

  it('CRLF file', () => {
    const text = 'Line one\r\nLine two\r\nLine three\r\n';
    expect(edited(text, (body) => body.replace('two', 'two\nand a half\n'))).toBe(
      'Line one\r\nLine two\r\nand a half\r\n\r\nLine three\r\n',
    );
  });

  it('Mixed line endings', () => {
    const text = 'crlf\r\nlf\nlone\rcrlf again\r\nlast\n';
    expect(edited(text, (body) => body.replace('crlf again', 'changed'))).toBe(
      'crlf\r\nlf\nlone\rchanged\r\nlast\n',
    );
  });

  it('follows the line being edited when inserting into mixed line endings', () => {
    expect(edited('a\r\nb\r\nc\nd', (body) => body.replace('a', 'a\nx'))).toBe(
      'a\r\nx\r\nb\r\nc\nd',
    );
    expect(edited('a\r\nb\nc', (body) => body.replace('b', 'b\nx'))).toBe('a\r\nb\nx\nc');
    expect(edited('a\r\nb\nc', (body) => `${body}\nx`)).toBe('a\r\nb\nc\nx');
  });

  it('uses LF in a file with no line endings', () => {
    expect(edited('one line', (body) => `${body}\nanother`)).toBe('one line\nanother');
  });

  it('never replaces more than the changed range when deleting a line ending', () => {
    const result = editBody('a\r\nb\r\nc\r\n', (body) => body.replace('a\n', ''));
    expect(result).toMatchObject({ text: 'b\r\nc\r\n', span: { start: 0, end: 3 }, replacement: '' });
  });

  it('keeps the byte order mark', () => {
    expect(edited('\uFEFFBody\n', (body) => body.replace('Body', 'New'))).toBe('\uFEFFNew\n');
    expect(edited(`\uFEFF${header}Body\n`, (body) => body.replace('Body', 'New'))).toBe(
      `\uFEFF${header}New\n`,
    );
  });

  it('keeps a body on its own line when the header ends the file without a line ending', () => {
    expect(edited(':PROPERTIES:\r\n:ID: a\r\n:END:', () => 'Body')).toBe(
      ':PROPERTIES:\r\n:ID: a\r\n:END:\r\nBody',
    );
    expect(edited('#+title: T', () => 'Body\n')).toBe('#+title: T\nBody\n');
  });

  it('does not split surrogate pairs at either end of the range', () => {
    const lowChanged = editBody('a😀b', () => 'a😁b');
    expect(lowChanged).toMatchObject({ span: { start: 1, end: 3 }, replacement: '😁' });
    const highChanged = editBody('a\u{1F600}b', () => 'a\u{2F600}b');
    expect(highChanged).toMatchObject({ span: { start: 1, end: 3 }, replacement: '\u{2F600}' });
  });

  it('handles repeated text without overlapping the prefix and suffix', () => {
    expect(editBody('aaa', () => 'aaaa')).toMatchObject({
      text: 'aaaa',
      span: { start: 3, end: 3 },
      replacement: 'a',
    });
    expect(editBody('aaaa', () => 'aaa')).toMatchObject({
      text: 'aaa',
      span: { start: 3, end: 4 },
      replacement: '',
    });
  });
});
