import type { EmphasisType, InlineToken, Span } from './types';

type LinkToken = Extract<InlineToken, { type: 'link' }>;

const EMPHASIS_TYPES: Record<string, EmphasisType | 'verbatim' | 'code'> = {
  '*': 'bold',
  '/': 'italic',
  _: 'underline',
  '+': 'strike',
  '=': 'verbatim',
  '~': 'code',
};
// Org's documented default emphasis context: at most one line break, and these neighbours.
const PRE_EMPHASIS = /[\s\-('"{]/;
const POST_EMPHASIS = /[\s\-.,:!?;'")}[]/;
const MAX_NEWLINES = 1;
// Pathological nesting ends as text rather than exhausting the stack.
const MAX_DEPTH = 8;

const LINK_TYPE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const ANGLE_LINK = /<(id|https?|mailto|file):([^\s<>]+)>/y;
const PLAIN_LINK = /(id|https?|mailto|file):([^\s()<>[\]]+)/y;
const PLAIN_LINK_STARTS = 'ihmf';
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

interface Context {
  text: string;
  /** Sorted valid closing positions per marker, computed once for the outermost range. */
  closers: Map<string, number[]>;
  /** Result of the last `]]` search, so repeated failures stay linear. */
  closeSearch: { from: number; pos: number };
}

/** Tokenizes `text[start, end)` into links, emphasis, and plain text. Never throws. */
export function tokenizeInline(text: string, start = 0, end = text.length): InlineToken[] {
  const context: Context = {
    text,
    closers: findClosers(text, start, end),
    closeSearch: { from: -1, pos: -1 },
  };
  return tokenizeRange(context, start, end, 0);
}

/** Replaces bracket links with their description, or their target when they have none. */
export function linkDisplayText(raw: string): string {
  const context: Context = { text: raw, closers: new Map(), closeSearch: { from: -1, pos: -1 } };
  let result = '';
  let copied = 0;
  let open = raw.indexOf('[[');
  while (open !== -1) {
    const link = parseBracketLink(context, open, raw.length);
    if (link) {
      const shown = link.description ?? raw.slice(open + 2, link.span.end - 2);
      result += raw.slice(copied, open) + shown;
      copied = link.span.end;
    }
    open = raw.indexOf('[[', link ? link.span.end : open + 1);
  }
  return result + raw.slice(copied);
}

function tokenizeRange(context: Context, start: number, end: number, depth: number): InlineToken[] {
  const tokens: InlineToken[] = [];
  let textStart = start;
  let i = start;
  while (i < end) {
    const token =
      parseBracketLink(context, i, end) ??
      parseAngleLink(context, i, end) ??
      parseEmphasis(context, i, start, end, depth) ??
      parsePlainLink(context, i, start, end);
    if (!token) {
      i++;
      continue;
    }
    if (textStart < i) tokens.push({ type: 'text', span: { start: textStart, end: i } });
    tokens.push(token);
    i = token.span.end;
    textStart = i;
  }
  if (textStart < end) tokens.push({ type: 'text', span: { start: textStart, end } });
  return tokens;
}

function parseBracketLink(context: Context, i: number, end: number): LinkToken | null {
  const { text } = context;
  if (text[i] !== '[' || text[i + 1] !== '[') return null;
  const targetStart = i + 2;
  let j = targetStart;
  for (; j < end; j++) {
    const ch = text[j];
    if (ch === '\\' && (text[j + 1] === '[' || text[j + 1] === ']' || text[j + 1] === '\\')) {
      j++;
    } else if (ch === '[' || ch === '\n' || ch === '\r') {
      return null;
    } else if (ch === ']') {
      break;
    }
  }
  if (j >= end || j === targetStart) return null;
  const raw = text.slice(targetStart, j);
  const after = j + 1;
  if (after < end && text[after] === ']') {
    return linkToken({ start: i, end: after + 1 }, 'bracket', raw, null);
  }
  if (after >= end || text[after] !== '[') return null;
  const close = findDoubleClose(context, after + 1, end);
  if (close === -1 || close === after + 1) return null;
  return linkToken({ start: i, end: close + 2 }, 'bracket', raw, {
    start: after + 1,
    end: close,
  }, text);
}

function linkToken(
  span: Span,
  form: LinkToken['form'],
  raw: string,
  descriptionSpan: Span | null,
  text = '',
): LinkToken {
  const typed = LINK_TYPE.exec(raw);
  const unescaped = (typed ? raw.slice(typed[0].length) : raw).replace(/\\([[\]\\])/g, '$1');
  return {
    type: 'link',
    span,
    form,
    linkType: typed ? typed[1] : 'fuzzy',
    target: unescaped,
    description: descriptionSpan
      ? text.slice(descriptionSpan.start, descriptionSpan.end).replace(/\r\n/g, '\n')
      : null,
    descriptionSpan,
  };
}

function findDoubleClose(context: Context, from: number, end: number): number {
  const memo = context.closeSearch;
  if (memo.from !== -1 && from >= memo.from && (memo.pos === -1 || from <= memo.pos)) {
    return memo.pos !== -1 && memo.pos + 2 <= end ? memo.pos : -1;
  }
  const { text } = context;
  let pos = -1;
  for (let k = from; k + 1 < end; k++) {
    if (text[k] === ']' && text[k + 1] === ']') {
      pos = k;
      break;
    }
  }
  context.closeSearch = { from, pos };
  return pos;
}

function parseAngleLink(context: Context, i: number, end: number): LinkToken | null {
  if (context.text[i] !== '<') return null;
  ANGLE_LINK.lastIndex = i;
  const match = ANGLE_LINK.exec(context.text);
  if (!match || i + match[0].length > end) return null;
  return linkToken({ start: i, end: i + match[0].length }, 'angle', `${match[1]}:${match[2]}`, null);
}

function parsePlainLink(context: Context, i: number, start: number, end: number): LinkToken | null {
  const { text } = context;
  if (!PLAIN_LINK_STARTS.includes(text[i])) return null;
  if (i > start && WORD_CHAR.test(text[i - 1])) return null;
  PLAIN_LINK.lastIndex = i;
  const match = PLAIN_LINK.exec(text);
  if (!match) return null;
  const prefixLength = match[1].length + 1;
  const available = Math.min(match[0].length, end - i);
  const target = match[0].slice(prefixLength, available).replace(TRAILING_PUNCTUATION, '');
  if (target === '') return null;
  const length = prefixLength + target.length;
  return linkToken({ start: i, end: i + length }, 'plain', text.slice(i, i + length), null);
}

function parseEmphasis(
  context: Context,
  i: number,
  start: number,
  end: number,
  depth: number,
): InlineToken | null {
  const { text } = context;
  const marker = text[i];
  const type = EMPHASIS_TYPES[marker];
  if (type === undefined || depth >= MAX_DEPTH) return null;
  if (i > start && !PRE_EMPHASIS.test(text[i - 1])) return null;
  if (i + 1 >= end || /\s/.test(text[i + 1])) return null;
  const closer = findCloser(context, marker, i + 2, end);
  if (closer === -1 || !withinNewlineLimit(text, i, closer)) return null;
  const span = { start: i, end: closer + 1 };
  const contentSpan = { start: i + 1, end: closer };
  if (type === 'verbatim' || type === 'code') return { type, span, contentSpan };
  return {
    type,
    span,
    contentSpan,
    children: tokenizeRange(context, i + 1, closer, depth + 1),
  };
}

function findClosers(text: string, start: number, end: number): Map<string, number[]> {
  const closers = new Map<string, number[]>();
  for (let i = start + 1; i < end; i++) {
    const ch = text[i];
    if (EMPHASIS_TYPES[ch] === undefined) continue;
    if (/\s/.test(text[i - 1])) continue;
    if (i + 1 < end && !POST_EMPHASIS.test(text[i + 1])) continue;
    const positions = closers.get(ch);
    if (positions) positions.push(i);
    else closers.set(ch, [i]);
  }
  return closers;
}

function findCloser(context: Context, marker: string, from: number, end: number): number {
  const { text } = context;
  const positions = context.closers.get(marker);
  let low = 0;
  let high = positions ? positions.length : 0;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions![middle] < from) low = middle + 1;
    else high = middle;
  }
  if (positions && low < positions.length && positions[low] < end) return positions[low];
  // A closer can sit at the end of a nested range, where the outer marker is its right neighbour.
  const last = end - 1;
  if (last >= from && text[last] === marker && !/\s/.test(text[last - 1])) return last;
  return -1;
}

function withinNewlineLimit(text: string, start: number, end: number): boolean {
  let newlines = 0;
  let next = text.indexOf('\n', start);
  while (next !== -1 && next < end) {
    newlines++;
    if (newlines > MAX_NEWLINES) return false;
    next = text.indexOf('\n', next + 1);
  }
  return true;
}
