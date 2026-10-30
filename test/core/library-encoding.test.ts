import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as fc from 'fast-check';

import {
  decodeUtf8,
  encodeUtf8,
  firstInvalidUtf8Offset,
  MAX_EDITABLE_BYTES,
  openNote,
  saveNote,
  type Note,
} from '../../src/core/library';
import { editableBody, scan } from '../../src/core/org';
import { MemoryFileStore } from '../support/memory-file-store';

// Scenarios from specs/library-storage/spec.md, "Encoding preservation".
const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '../fixtures', name)));
const utf8 = (text: string) => new TextEncoder().encode(text);

function nodeAccepts(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

async function open(store: MemoryFileStore, path = 'note.org'): Promise<Note> {
  const result = await openNote(store, path);
  if (result.status !== 'opened') throw new Error(`could not open ${path}`);
  return result.note;
}

const INVALID: [string, number[], number][] = [
  ['a lone continuation byte', [0x61, 0x80], 1],
  ['a lead byte at the end', [0x61, 0xc3], 1],
  ['a truncated three-byte sequence', [0xe2, 0x82], 0],
  ['a truncated four-byte sequence', [0xf0, 0x9f, 0x98], 0],
  ['a lead byte before ASCII', [0xc3, 0x28], 0],
  ['an overlong two-byte form', [0xc0, 0xaf], 0],
  ['an overlong three-byte form', [0xe0, 0x80, 0xaf], 0],
  ['an overlong four-byte form', [0xf0, 0x80, 0x80, 0xaf], 0],
  ['a UTF-16 surrogate', [0xed, 0xa0, 0x80], 0],
  ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80], 0],
  ['an impossible byte', [0xff], 0],
  ['Latin-1 text', [...utf8('#+title: caf'), 0xe9, 0x0a], 12],
];

describe('UTF-8 validator', () => {
  it.each(INVALID)('rejects %s', (_name, bytes, offset) => {
    const input = new Uint8Array(bytes);
    expect(firstInvalidUtf8Offset(input)).toBe(offset);
    expect(decodeUtf8(input)).toBeNull();
    expect(nodeAccepts(input)).toBe(false);
  });

  it.each([
    ['nothing', []],
    ['the boundaries of each sequence length', [0x7f, 0xc2, 0x80, 0xdf, 0xbf, 0xe0, 0xa0, 0x80, 0xef, 0xbf, 0xbf]],
    ['the last code points around the surrogates', [0xed, 0x9f, 0xbf, 0xee, 0x80, 0x80]],
    ['the four-byte boundaries', [0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf]],
  ])('accepts %s', (_name, bytes) => {
    expect(firstInvalidUtf8Offset(new Uint8Array(bytes))).toBeNull();
    expect(nodeAccepts(new Uint8Array(bytes))).toBe(true);
  });

  it('agrees with Node on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        expect(firstInvalidUtf8Offset(bytes) === null).toBe(nodeAccepts(bytes));
      }),
      { numRuns: 2000 },
    );
  });

  it('agrees with Node near multi-byte boundaries', () => {
    const tricky = fc.constantFrom(0x7f, 0x80, 0x8f, 0x90, 0x9f, 0xa0, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5);
    fc.assert(
      fc.property(fc.array(tricky, { maxLength: 12 }), (values) => {
        const bytes = new Uint8Array(values);
        expect(firstInvalidUtf8Offset(bytes) === null).toBe(nodeAccepts(bytes));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('UTF-8 codec', () => {
  it('decodes and encodes exactly as the platform does, apart from keeping a BOM', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (text) => {
        const expected = new TextEncoder().encode(text);
        expect(encodeUtf8(text)).toEqual(expected);
        expect(decodeUtf8(expected)).toBe(new TextDecoder('utf-8', { ignoreBOM: true }).decode(expected));
      }),
      { numRuns: 2000 },
    );
  });

  it('round-trips any valid bytes exactly', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const text = decodeUtf8(bytes);
        if (text !== null) expect(encodeUtf8(text)).toEqual(bytes);
      }),
      { numRuns: 2000 },
    );
  });

  it('handles text longer than one decoding chunk', () => {
    const text = '😀é'.repeat(20_000);
    expect(decodeUtf8(utf8(text))).toBe(text);
    expect(encodeUtf8(text)).toEqual(utf8(text));
  });

  it('turns a lone surrogate from an editor into U+FFFD', () => {
    expect(encodeUtf8('a\ud800b')).toEqual(utf8('a�b'));
    expect(encodeUtf8('a\udc00')).toEqual(utf8('a�'));
  });
});

describe('Encoding preservation', () => {
  describe('Invalid UTF-8', () => {
    it.each(INVALID)('flags and refuses to save %s', async (_name, bytes) => {
      const original = new Uint8Array(bytes);
      const store = new MemoryFileStore({ 'note.org': original });

      const note = await open(store);
      expect(note).toMatchObject({ editable: false, reason: 'invalid_utf8', text: null });
      if (!note.editable) expect(note.message).toContain('UTF-8');
      expect(note.bytes).toEqual(original);

      store.calls = [];
      const result = await saveNote(store, note, { title: 'New', body: 'New\n' });

      expect(result).toMatchObject({ status: 'not_editable', reason: 'invalid_utf8' });
      expect(store.calls).toEqual([]);
      expect(store.peek('note.org')).toEqual(original);
    });

    it('prefers the encoding reason in a read-only location', async () => {
      const store = new MemoryFileStore({ 'note.org': new Uint8Array([0xff]) });

      const result = await openNote(store, 'note.org', { writable: false });

      expect(result).toMatchObject({ status: 'opened', note: { reason: 'invalid_utf8' } });
    });
  });

  describe('Unicode content', () => {
    it('survives an edit elsewhere in the file', async () => {
      const original = fixture('unicode.org');
      const store = new MemoryFileStore({ 'note.org': original });
      const note = await open(store);
      if (!note.editable) throw new Error('expected an editable note');

      const body = editableBody(note.text, scan(note.text));
      const result = await saveNote(store, note, { body: `${body}Añadido 追加 🎉\n` });

      expect(result.status).toBe('saved');
      const saved = store.peek('note.org')!;
      const added = utf8('Añadido 追加 🎉\n');
      expect(saved.slice(0, original.length)).toEqual(original);
      expect(saved.slice(original.length)).toEqual(added);
    });
  });

  describe('Byte order mark', () => {
    it.each(['bom.org', 'bom-crlf.org'])('keeps the BOM of %s when the body is edited', async (name) => {
      const original = fixture(name);
      expect([...original.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const store = new MemoryFileStore({ [name]: original });
      const note = await open(store, name);
      if (!note.editable) throw new Error('expected an editable note');

      const body = editableBody(note.text, scan(note.text));
      expect((await saveNote(store, note, { body: `${body}x` })).status).toBe('saved');

      const saved = store.peek(name)!;
      expect(saved.slice(0, original.length)).toEqual(original);
      expect(saved.slice(original.length)).toEqual(utf8('x'));
    });

    it('keeps the BOM of a file gaining a title', async () => {
      const store = new MemoryFileStore({ 'note.org': new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]) });
      const note = await open(store);

      await saveNote(store, note, { title: 'New' });

      expect(store.peek('note.org')).toEqual(
        new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('#+title: New\na\n')]),
      );
    });

    it('keeps a BOM that opens with nothing else to change', async () => {
      const original = fixture('bom.org');
      const store = new MemoryFileStore({ 'note.org': original });
      const note = await open(store);
      if (!note.editable) throw new Error('expected an editable note');
      store.calls = [];

      const result = await saveNote(store, note, { body: editableBody(note.text, scan(note.text)) });

      expect(result.status).toBe('unchanged');
      expect(store.calls).toEqual([]);
    });
  });
});

describe('Read-only flagging', () => {
  it('Read-only location: the note can be read, and explains why it cannot be edited', async () => {
    const store = new MemoryFileStore({ 'note.org': 'Hello\n' });

    const result = await openNote(store, 'note.org', { writable: false });

    expect(result).toMatchObject({
      status: 'opened',
      note: { editable: false, reason: 'read_only_location', text: 'Hello\n' },
    });
    if (result.status === 'opened') {
      expect(await saveNote(store, result.note, { body: 'x' })).toMatchObject({ status: 'not_editable' });
      expect(store.peekText('note.org')).toBe('Hello\n');
    }
  });

  it('File too large to edit: it can still be read', async () => {
    const text = 'x'.repeat(MAX_EDITABLE_BYTES + 1);
    const store = new MemoryFileStore({ 'note.org': text });

    const result = await openNote(store, 'note.org');

    expect(result).toMatchObject({
      status: 'opened',
      note: { editable: false, reason: 'too_large', text },
    });
  });

  it('a file exactly at the limit is editable', async () => {
    const store = new MemoryFileStore({ 'note.org': 'x'.repeat(MAX_EDITABLE_BYTES) });

    expect(await openNote(store, 'note.org')).toMatchObject({
      status: 'opened',
      note: { editable: true },
    });
  });
});
