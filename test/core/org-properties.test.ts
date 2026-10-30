import * as fc from 'fast-check';

import { scan, tokenizeInline } from '../../src/core/org';
import type { OrgDocument, Span } from '../../src/core/org';

// Fragments that form Org syntax, so random inputs reach deep paths rather than all being text.
const FRAGMENTS = [
  '\n',
  '\n',
  '\n',
  ' ',
  '* ',
  '** ',
  '*',
  '/',
  '_',
  '+',
  '=',
  '~',
  ',* ',
  'TODO ',
  'DONE ',
  '[#A] ',
  ':tag:',
  ':PROPERTIES:',
  ':properties:',
  ':END:',
  ':ID: abc',
  ':ID:',
  ':ROAM_EXCLUDE: t',
  ':LOGBOOK:',
  '#+title: ',
  '#+TITLE:',
  '#+filetags: :a:b:',
  '#+TODO: NEXT | DONE',
  '#+begin_src',
  '#+end_src',
  '#+BEGIN_QUOTE',
  '#+end_quote',
  '#+begin_example',
  '#+end_example',
  '# ',
  '#',
  ': ',
  ':',
  'SCHEDULED: <2026-01-01>',
  '- ',
  '| a |',
  '[[id:abc]]',
  '[[id:abc][desc]]',
  '[[',
  ']]',
  '][',
  'id:def',
  '<id:ghi>',
  'https://a.b',
  'text',
  'été',
  '日本語',
  '😀',
  ' ',
  ' ',
  '\t',
  '\\',
];

const orgLike = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 60 }).map((parts) => parts.join(''));

// Arbitrary text with any UTF-16 content, including lone surrogates and carriage returns.
const anyText = fc.oneof(
  orgLike,
  fc.string({ unit: 'grapheme', maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.array(fc.oneof(fc.constantFrom(...FRAGMENTS), fc.constantFrom('\r', '\r\n', '﻿')), {
    maxLength: 60,
  }).map((parts) => parts.join('')),
);

// Text with no carriage returns, whose line endings can be converted without ambiguity.
const lfText = fc.oneof(orgLike, fc.string({ unit: 'grapheme', maxLength: 200 })).map((text) =>
  text.replace(/\r/g, ''),
);

function collectSpans(value: unknown, spans: Span[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSpans(item, spans);
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.start === 'number' && typeof record.end === 'number') {
      spans.push(record as unknown as Span);
    }
    for (const item of Object.values(record)) collectSpans(item, spans);
  }
}

/** Rewrites every offset in a document scanned from LF text to where it falls in the CRLF form. */
function mapOffsets(doc: OrgDocument, lfText: string): unknown {
  const toCrlf = (offset: number) => {
    let newlines = 0;
    for (let i = lfText.indexOf('\n'); i !== -1 && i < offset; i = lfText.indexOf('\n', i + 1)) {
      newlines++;
    }
    return offset + newlines;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const isOffset =
        typeof item === 'number' &&
        (key === 'start' || key === 'end' || key === 'startOffset' || key === 'headerEnd' || key === 'length');
      copy[key] = isOffset ? toCrlf(item as number) : walk(item);
    }
    return copy;
  };
  return walk(doc);
}

const withoutEol = (doc: unknown) => ({ ...(doc as OrgDocument), eol: undefined });

describe('scanner properties', () => {
  it('never throws, on any text', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        scan(text);
      }),
      { numRuns: 2000 },
    );
  });

  it('keeps every offset within the text, with spans in order', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const doc = scan(text);
        const spans: Span[] = [];
        collectSpans(doc, spans);
        for (const span of spans) {
          expect(span.start).toBeGreaterThanOrEqual(0);
          expect(span.end).toBeGreaterThanOrEqual(span.start);
          expect(span.end).toBeLessThanOrEqual(text.length);
        }
        for (const node of doc.nodes) {
          expect(node.startOffset).toBeGreaterThanOrEqual(0);
          expect(node.startOffset).toBeLessThanOrEqual(text.length);
        }
        expect(doc.length).toBe(text.length);
        expect(doc.headerEnd).toBeGreaterThanOrEqual(doc.bomLength);
        expect(doc.headerEnd).toBeLessThanOrEqual(text.length);
        for (let i = 1; i < doc.elements.length; i++) {
          expect(doc.elements[i].span.start).toBeGreaterThanOrEqual(doc.elements[i - 1].span.start);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('reports values that match their spans exactly', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const doc = scan(text);
        for (const element of doc.elements) {
          if (element.kind === 'keyword') {
            const { start, end } = element.valueSpan;
            expect(text.slice(start, end)).toBe(element.value);
          }
          if (element.kind === 'drawer') {
            for (const property of element.properties) {
              const { start, end } = property.valueSpan;
              expect(text.slice(start, end)).toBe(property.value);
            }
          }
        }
        for (const link of doc.links) {
          // Bracket links unescape their targets and other forms don't, so compare without backslashes.
          const written = text.slice(link.span.start, link.span.end).replace(/\\/g, '');
          expect(written).toContain(link.target.replace(/\\/g, ''));
          if (link.source !== null) expect(doc.nodes[link.source]).toBeDefined();
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('gives equivalent results for the LF and CRLF forms of any text', () => {
    fc.assert(
      fc.property(lfText, (text) => {
        const crlf = scan(text.replace(/\n/g, '\r\n'));
        expect(withoutEol(crlf)).toEqual(withoutEol(mapOffsets(scan(text), text)));
      }),
      { numRuns: 2000 },
    );
  });

  it('recognizes the same content behind a BOM', () => {
    fc.assert(
      fc.property(orgLike, (text) => {
        const withBom = scan(`﻿${text}`);
        const without = scan(text);
        expect(withBom.nodes.map((node) => node.id)).toEqual(without.nodes.map((node) => node.id));
        expect(withBom.links.map((link) => link.target)).toEqual(
          without.links.map((link) => link.target),
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe('inline tokenizer properties', () => {
  it('covers its range with ordered tokens that never overlap', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const tokens = tokenizeInline(text);
        let position = 0;
        for (const token of tokens) {
          expect(token.span.start).toBe(position);
          position = token.span.end;
        }
        expect(position).toBe(text.length);
        const spans: Span[] = [];
        collectSpans(tokens, spans);
        for (const span of spans) {
          expect(span.start).toBeLessThanOrEqual(span.end);
          expect(span.end).toBeLessThanOrEqual(text.length);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
