import type { OrgDocument, Span } from './types';

// Saves are `prefix + replacement + suffix` over the file's original text (Decision 1). Nothing here
// serializes a parse tree, so every byte outside `span` is preserved by construction.

export type SpliceResult =
  /** Nothing to save. `text` is the original, and the file must not be rewritten. */
  | { changed: false; text: string }
  /** `text` is the original with `span` replaced by `replacement`. */
  | { changed: true; text: string; span: Span; replacement: string };

/** The form the editor works on (Decision 7). Lone CRs count too, since text inputs may convert them. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The body as the editor shows it: everything after the metadata header, with LF line endings. */
export function editableBody(text: string, doc: OrgDocument): string {
  return normalizeLineEndings(text.slice(doc.headerEnd));
}

/**
 * Applies an edited body to the file. `newBody` is what the editor produced from `editableBody`.
 * The change becomes one range, from the common prefix and suffix, and only that range's line
 * endings are converted to the file's style.
 */
export function spliceBody(text: string, doc: OrgDocument, newBody: string): SpliceResult {
  const before = editableBody(text, doc);
  const after = normalizeLineEndings(newBody);
  if (before === after) return { changed: false, text };

  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const span = {
    start: originalOffset(text, doc.headerEnd, prefix),
    end: originalOffset(text, doc.headerEnd, before.length - suffix),
  };
  const eol = lineEndingNear(text, span.start);
  let replacement = after.slice(prefix, after.length - suffix).replace(/\n/g, eol);
  // A header on the file's last line has no line ending for the body to follow.
  const { headerEnd, bomLength } = doc;
  if (headerEnd > bomLength && headerEnd === text.length && text[headerEnd - 1] !== '\n') {
    replacement = eol + replacement;
  }
  return { changed: true, text: splice(text, span, replacement), span, replacement };
}

/** The title as the editor shows it: as written, so an untouched title is not a change. */
export function editableTitle(doc: OrgDocument): string {
  return doc.titleKeyword ? doc.titleKeyword.value : '';
}

/**
 * Applies an edited title to the file. Replaces only the value of the title keyword, or adds a
 * `#+title` line after the file's drawer, or at the start of a file with no drawer. Touching only
 * the header keeps `headerEnd` where the body expects it, so title and body edits can follow each
 * other as long as the file is scanned again in between.
 */
export function spliceTitle(text: string, doc: OrgDocument, newTitle: string): SpliceResult {
  const title = newTitle.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (title === editableTitle(doc)) return { changed: false, text };

  const keyword = doc.titleKeyword;
  if (keyword) {
    const { valueSpan } = keyword;
    // `#+title:` with no value has no blank to keep, and the new value reads better with one.
    const blank = title !== '' && text[valueSpan.start - 1] === ':' ? ' ' : '';
    const replacement = blank + title;
    return { changed: true, text: splice(text, valueSpan, replacement), span: valueSpan, replacement };
  }

  const drawerEnd = doc.fileDrawer ? doc.fileDrawer.span.end : null;
  const eol = lineEndingNear(text, drawerEnd ?? doc.bomLength);
  let start = doc.bomLength;
  let replacement = `#+title: ${title}${eol}`;
  if (drawerEnd !== null) {
    const newline = text.indexOf('\n', drawerEnd);
    if (newline === -1) {
      // The drawer ends the file without a line ending.
      start = text.length;
      replacement = eol + replacement;
    } else {
      start = newline + 1;
    }
  }
  const span = { start, end: start };
  return { changed: true, text: splice(text, span, replacement), span, replacement };
}

function splice(text: string, span: Span, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end);
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let length = 0;
  while (length < limit && a.charCodeAt(length) === b.charCodeAt(length)) length++;
  while (splitsPair(a, length) || splitsPair(b, length)) length--;
  return length;
}

/** Stops short of `prefix`, so the prefix and suffix never overlap. */
function commonSuffixLength(a: string, b: string, prefix: number): number {
  const limit = Math.min(a.length, b.length) - prefix;
  let length = 0;
  while (
    length < limit &&
    a.charCodeAt(a.length - 1 - length) === b.charCodeAt(b.length - 1 - length)
  ) {
    length++;
  }
  while (splitsPair(a, a.length - length) || splitsPair(b, b.length - length)) length--;
  return length;
}

/** Whether `index` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** Maps an offset in the normalized body to the original text. Never lands inside a CRLF. */
function originalOffset(text: string, bodyStart: number, normalized: number): number {
  let position = bodyStart;
  for (let i = 0; i < normalized; i++) {
    position += text[position] === '\r' && text[position + 1] === '\n' ? 2 : 1;
  }
  return position;
}

/**
 * The file's style at `offset`: the next line ending, else the previous one, else LF. In a file
 * with mixed line endings this follows the line being edited.
 */
function lineEndingNear(text: string, offset: number): string {
  let newline = text.indexOf('\n', offset);
  if (newline === -1 && offset > 0) newline = text.lastIndexOf('\n', offset - 1);
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}
