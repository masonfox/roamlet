import * as fc from 'fast-check';

import {
  editableBody,
  editableTitle,
  normalizeLineEndings,
  scan,
  spliceBody,
  spliceTitle,
} from '../../src/core/org';
import type { SpliceResult } from '../../src/core/org';

const BOM = '﻿';

// Fragments that form Org syntax and every kind of line ending, so inputs reach real headers.
const FRAGMENTS = [
  '\n',
  '\n',
  '\r\n',
  '\r\n',
  '\r',
  ' ',
  '\t',
  '* ',
  '** Heading',
  ':PROPERTIES:',
  ':properties:',
  ':END:',
  ':ID: abc',
  ':ID:       def',
  ':LOGBOOK:',
  '#+title: ',
  '#+TITLE:   Old',
  '#+title:',
  '#+filetags: :a:',
  '#+begin_src',
  '#+end_src',
  '# comment',
  '| a | b |',
  '[[id:abc][desc]]',
  'word',
  'été',
  '日本語',
  '😀',
  '🙂',
];

const fragments = (maxLength: number) =>
  fc.array(fc.constantFrom(...FRAGMENTS), { maxLength }).map((parts) => parts.join(''));

// Well-formed text only, so every string has an exact UTF-8 form (Decision 7 rejects the rest).
const orgFile = fc.oneof(
  fragments(40),
  fragments(40).map((text) => BOM + text),
  fc
    .tuple(fc.constantFrom('\n', '\r\n'), fragments(30))
    .map(([eol, text]) => `:PROPERTIES:${eol}:ID: abc${eol}:END:${eol}${text}`),
  fc.string({ unit: 'grapheme', maxLength: 100 }),
);

// An edit as a text input would make one: replace a range of the body with new text. Ranges are in
// code points, so the edit itself never breaks a character.
const bodyEdit = fc.record({
  from: fc.nat(),
  length: fc.nat({ max: 20 }),
  insert: fc.oneof(fragments(6), fc.string({ unit: 'grapheme', maxLength: 10 })),
});

function applyEdit(body: string, edit: { from: number; length: number; insert: string }): string {
  const points = Array.from(body);
  const from = points.length === 0 ? 0 : edit.from % (points.length + 1);
  return points.slice(0, from).join('') + edit.insert + points.slice(from + edit.length).join('');
}

function expectOnlySpanChanged(text: string, result: SpliceResult): void {
  if (!result.changed) {
    expect(result.text).toBe(text);
    return;
  }
  const { span, replacement } = result;
  expect(span.start).toBeLessThanOrEqual(span.end);
  expect(span.end).toBeLessThanOrEqual(text.length);
  expect(result.text.slice(0, span.start)).toBe(text.slice(0, span.start));
  expect(result.text.slice(span.start + replacement.length)).toBe(text.slice(span.end));

  const encoder = new TextEncoder();
  const prefix = encoder.encode(text.slice(0, span.start));
  const suffix = encoder.encode(text.slice(span.end));
  const bytes = encoder.encode(result.text);
  expect(Buffer.from(bytes.subarray(0, prefix.length)).equals(Buffer.from(prefix))).toBe(true);
  expect(Buffer.from(bytes.subarray(bytes.length - suffix.length)).equals(Buffer.from(suffix))).toBe(
    true,
  );
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A range boundary is inside a character if the code unit after it continues a pair. */
function splitsPair(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length && isLowSurrogate(text.charCodeAt(offset));
}

describe('spliceBody properties', () => {
  it('leaves all bytes outside the replacement identical', () => {
    fc.assert(
      fc.property(orgFile, bodyEdit, (text, edit) => {
        const doc = scan(text);
        const result = spliceBody(text, doc, applyEdit(editableBody(text, doc), edit));
        expectOnlySpanChanged(text, result);
        if (result.changed) expect(result.span.start).toBeGreaterThanOrEqual(doc.headerEnd);
      }),
      { numRuns: 3000 },
    );
  });

  it('produces the edited body, and the header stays as it was', () => {
    fc.assert(
      fc.property(orgFile, bodyEdit, (text, edit) => {
        const doc = scan(text);
        const newBody = applyEdit(editableBody(text, doc), edit);
        const result = spliceBody(text, doc, newBody);
        expect(result.text.slice(0, doc.headerEnd)).toBe(text.slice(0, doc.headerEnd));
        // A newline inserted right after a lone CR joins it into one CRLF. The bytes are still as
        // specified, but this comparison cannot see them apart.
        fc.pre(!text.replace(/\r\n/g, '').includes('\r'));
        const body = normalizeLineEndings(result.text.slice(doc.headerEnd));
        const headerOpen = doc.headerEnd === text.length && !text.endsWith('\n');
        const needsSeparator = result.changed && headerOpen && doc.headerEnd > doc.bomLength;
        expect(body).toBe((needsSeparator ? '\n' : '') + normalizeLineEndings(newBody));
      }),
      { numRuns: 3000 },
    );
  });

  it('does not report a change when the body is untouched', () => {
    fc.assert(
      fc.property(orgFile, (text) => {
        const doc = scan(text);
        expect(spliceBody(text, doc, editableBody(text, doc))).toEqual({ changed: false, text });
      }),
      { numRuns: 1000 },
    );
  });

  it('never splits a surrogate pair at the ends of the range', () => {
    const emoji = fc
      .array(fc.constantFrom('😀', '😁', '🙂', '𝒜', '𝒝', 'a', '\n'), { maxLength: 12 })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(emoji, emoji, (text, newBody) => {
        const result = spliceBody(text, scan(text), newBody);
        expectOnlySpanChanged(text, result);
        if (!result.changed) return;
        expect(splitsPair(text, result.span.start)).toBe(false);
        expect(splitsPair(text, result.span.end)).toBe(false);
        expect(isLowSurrogate(result.replacement.charCodeAt(0))).toBe(false);
        const lastCode = result.replacement.charCodeAt(result.replacement.length - 1);
        expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });

  it('writes only the file\'s line ending into the replacement of a uniform file', () => {
    const lines = fc.array(fc.constantFrom('a', 'b', 'word', ''), { minLength: 2, maxLength: 8 });
    fc.assert(
      fc.property(lines, lines, fc.constantFrom('\n', '\r\n'), (before, after, eol) => {
        const text = `${before.join(eol)}${eol}`;
        const result = spliceBody(text, scan(text), after.join('\n'));
        if (!result.changed) return;
        const bare = eol === '\n' ? /\r/ : /(?<!\r)\n/;
        expect(result.replacement).not.toMatch(bare);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('spliceTitle properties', () => {
  const titles = fc.constantFrom('New', 'Two words', '😀 emoji', '[x] and ]]', '#+title: y', ':ID: z');

  it('leaves all bytes outside the replacement identical', () => {
    fc.assert(
      fc.property(orgFile, titles, (text, title) => {
        const result = spliceTitle(text, scan(text), title);
        expectOnlySpanChanged(text, result);
      }),
      { numRuns: 3000 },
    );
  });

  it('sets the title without disturbing nodes or the body', () => {
    fc.assert(
      fc.property(orgFile, titles, (text, title) => {
        const doc = scan(text);
        const result = spliceTitle(text, doc, title);
        const after = scan(result.text);
        expect(editableTitle(after)).toBe(title);
        expect(after.nodes.map((node) => node.id)).toEqual(doc.nodes.map((node) => node.id));
        // Text before a `#+title` puts the keyword in the body, where editing it shows there too.
        if (!doc.titleKeyword || doc.titleKeyword.span.start < doc.headerEnd) {
          expect(editableBody(result.text, after)).toBe(editableBody(text, doc));
        }
      }),
      { numRuns: 3000 },
    );
  });
});
