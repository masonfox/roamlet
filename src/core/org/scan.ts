import { linkDisplayText, tokenizeInline } from './inline';
import type {
  InlineToken,
  LineEnding,
  OrgBlock,
  OrgDocument,
  OrgDrawer,
  OrgElement,
  OrgHeading,
  OrgKeyword,
  OrgLink,
  OrgNode,
  OrgProperty,
  ScanOptions,
  Span,
} from './types';

// Line patterns follow Org's documented syntax. All use explicit blanks rather than \s, so Unicode
// spaces stay text, and the s flag, so a U+2028 inside a line does not end a match.
const HEADING = /^(\*+)[ ]/;
const BLANK = /^[ \t]*$/;
const COMMENT = /^[ \t]*#(?: |$)/;
const FIXED_WIDTH = /^[ \t]*:(?: |$)/;
const PLANNING = /^[ \t]*(?:SCHEDULED|DEADLINE|CLOSED):/;
const PROPERTIES_OPEN = /^[ \t]*:PROPERTIES:[ \t]*$/i;
const DRAWER_OPEN = /^[ \t]*:([\p{L}\p{N}_-]+):[ \t]*$/u;
const DRAWER_END = /^[ \t]*:END:[ \t]*$/i;
const PROPERTY = /^[ \t]*:(\S+?):(?:[ \t]+(.*))?$/s;
const BLOCK_BEGIN = /^[ \t]*#\+begin_(\S+)(?:[ \t]+(.*))?$/is;
const BLOCK_END = /^[ \t]*#\+end_(\S+)[ \t]*$/i;
const KEYWORD = /^([ \t]*#\+)(\S+?)(:[ \t]*)(.*)$/s;
// Dynamic blocks are unsupported syntax, which must stay visible as text.
const DYNAMIC_BLOCK_KEYS = new Set(['BEGIN', 'END']);
const LIST_ITEM = /^[ \t]*(?:[-+]|\d+[.)]|[A-Za-z][.)])[ \t]|^[ \t]+\*[ \t]/;
const TABLE_ROW = /^[ \t]*\|/;
const PRIORITY = /^\[#([A-Z0-9]+)\][ \t]*/;
const TAG_TOKEN = /^:[\p{L}\p{N}_@#%:]+:$/u;
const COMMA_ESCAPE = /^([ \t]*),(,*(?:\*|#\+))/gm;

const VERBATIM_BLOCKS = new Set(['src', 'example', 'comment', 'export']);
const DEFAULT_TODO_KEYWORDS = ['TODO', 'DONE'];
const TODO_DECLARATIONS = new Set(['TODO', 'SEQ_TODO', 'TYP_TODO']);
// Org-roam's documented defaults for org-roam-db-extra-links-exclude-keys.
const LINK_FREE_PROPERTIES = new Set(['ROAM_REFS']);
const LINK_FREE_KEYWORDS = new Set(['TRANSCLUDE']);

interface Line {
  start: number;
  /** End of the line's text, before its line ending. */
  end: number;
  /** Start of the next line. */
  next: number;
}

interface ScannedLines {
  elements: OrgElement[];
  fileDrawer: OrgDrawer | null;
}

/** Scans Org text. A total function: anything unrecognized becomes text. */
export function scan(text: string, options: ScanOptions = {}): OrgDocument {
  const bomLength = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const lines = splitLines(text, bomLength);
  const { elements, fileDrawer } = scanLines(text, lines);

  const keywords = elements.filter((element): element is OrgKeyword => element.kind === 'keyword');
  const titleKeyword = keywords.find((keyword) => keyword.key === 'TITLE') ?? null;
  const todoKeywords = collectTodoKeywords(keywords);
  const tags = collectFileTags(keywords);
  const fallbackTitle = options.fileName === undefined ? '' : titleFromFileName(options.fileName);
  const title = (titleKeyword && linkDisplayText(titleKeyword.value)) || fallbackTitle;

  const nodes: OrgNode[] = [];
  const fileId = fileDrawer ? nodeIdOf(fileDrawer.properties) : null;
  if (fileId !== null) nodes.push({ id: fileId, level: 0, title, tags, startOffset: 0 });
  const fileOwner = nodes.length > 0 ? 0 : null;

  // Open headings, outermost first, with what their descendants inherit.
  const stack: { level: number; owner: number | null; tags: string[] }[] = [];
  const links: OrgLink[] = [];
  let owner = fileOwner;
  for (const element of elements) {
    if (element.kind === 'heading') {
      fillHeading(text, element, todoKeywords);
      while (stack.length > 0 && stack[stack.length - 1].level >= element.level) stack.pop();
      const parent = stack[stack.length - 1];
      const inherited = parent ? parent.tags : tags;
      const headingTags = unique([...inherited, ...element.tags]);
      const id = nodeIdOf(element.properties);
      owner = parent ? parent.owner : fileOwner;
      if (id !== null) {
        element.node = nodes.length;
        owner = nodes.length;
        nodes.push({
          id,
          level: element.level,
          title: element.title,
          tags: headingTags,
          startOffset: element.span.start,
        });
      }
      stack.push({ level: element.level, owner, tags: headingTags });
    }
    element.owner = owner;
    collectLinks(text, element, owner, links);
  }

  return {
    length: text.length,
    bomLength,
    eol: detectLineEnding(lines, text),
    elements,
    nodes,
    links,
    title,
    titleKeyword,
    tags,
    fileDrawer,
    todoKeywords,
    headerEnd: findHeaderEnd(elements, fileDrawer, lines, bomLength),
  };
}

/** Removes the comma that protects `*` and `#+` at the start of lines in block content. */
export function unescapeBlockContent(content: string): string {
  return content.replace(COMMA_ESCAPE, '$1$2');
}

/** The file name without directories or its extension. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function splitLines(text: string, start: number): Line[] {
  const lines: Line[] = [];
  let lineStart = start;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    if (newline === -1) {
      lines.push({ start: lineStart, end: text.length, next: text.length });
      break;
    }
    const end = newline > lineStart && text[newline - 1] === '\r' ? newline - 1 : newline;
    lines.push({ start: lineStart, end, next: newline + 1 });
    lineStart = newline + 1;
  }
  return lines;
}

function detectLineEnding(lines: Line[], text: string): LineEnding {
  let lf = false;
  let crlf = false;
  for (const line of lines) {
    if (line.next === line.end) continue;
    if (text[line.end] === '\r') crlf = true;
    else lf = true;
  }
  if (lf && crlf) return 'mixed';
  if (crlf) return 'crlf';
  return lf ? 'lf' : 'none';
}

/** Trims trailing blanks from `[start, end)`, returning the new end. Linear, unlike a regex. */
function trimBlanksEnd(text: string, start: number, end: number): number {
  let trimmed = end;
  while (trimmed > start && (text[trimmed - 1] === ' ' || text[trimmed - 1] === '\t')) trimmed--;
  return trimmed;
}

/** Answers "where does this construct close?" in constant amortized time, so scanning is linear. */
class Closings {
  private readonly blockEnds = new Map<string, { lines: number[]; cursor: number }>();
  private readonly drawerEnds: { lines: number[]; cursor: number } = { lines: [], cursor: 0 };
  /** For each line, the next line at or after it that is a heading. */
  private readonly nextHeading: Int32Array;

  constructor(text: string, lines: Line[]) {
    this.nextHeading = new Int32Array(lines.length + 1);
    this.nextHeading[lines.length] = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const content = text.slice(lines[i].start, lines[i].end);
      this.nextHeading[i] = HEADING.test(content) ? i : this.nextHeading[i + 1];
    }
    lines.forEach((line, i) => {
      const content = text.slice(line.start, line.end);
      if (DRAWER_END.test(content)) this.drawerEnds.lines.push(i);
      const blockEnd = BLOCK_END.exec(content);
      if (blockEnd) {
        const name = blockEnd[1].toLowerCase();
        const ends = this.blockEnds.get(name);
        if (ends) ends.lines.push(i);
        else this.blockEnds.set(name, { lines: [i], cursor: 0 });
      }
    });
  }

  /** The closing line after `line` and before the next heading, or -1. Calls must not go backward. */
  block(name: string, line: number): number {
    const ends = this.blockEnds.get(name);
    return ends ? this.advance(ends, line) : -1;
  }

  drawer(line: number): number {
    return this.advance(this.drawerEnds, line);
  }

  private advance(ends: { lines: number[]; cursor: number }, line: number): number {
    while (ends.cursor < ends.lines.length && ends.lines[ends.cursor] <= line) ends.cursor++;
    if (ends.cursor === ends.lines.length) return -1;
    const end = ends.lines[ends.cursor];
    return end < this.nextHeading[line + 1] ? end : -1;
  }
}

function scanLines(text: string, lines: Line[]): ScannedLines {
  const closings = new Closings(text, lines);
  const elements: OrgElement[] = [];
  // Closing lines of drawers and blocks whose content is scanned as usual.
  const closingLines = new Set<number>();
  let fileDrawer: OrgDrawer | null = null;
  let beforeFileContent = true;
  let openDrawerEnd = -1;
  let run: Span | null = null;

  const flushRun = () => {
    if (run) elements.push({ kind: 'text', span: run, owner: null });
    run = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const content = text.slice(line.start, line.end);
    const span = { start: line.start, end: line.end };

    if (closingLines.has(i)) {
      flushRun();
      continue;
    }

    const heading = HEADING.exec(content);
    if (heading) {
      flushRun();
      beforeFileContent = false;
      const element = newHeading(span, heading[1].length);
      elements.push(element);
      let next = i + 1;
      if (next < lines.length && PLANNING.test(lineText(text, lines[next]))) {
        elements.push({ kind: 'planning', span: lineSpan(lines[next]), owner: null });
        next++;
      }
      const drawer = parsePropertyDrawer(text, lines, next);
      if (drawer) {
        element.properties = drawer.element.properties;
        elements.push(drawer.element);
        next = drawer.endLine + 1;
      }
      i = next - 1;
      continue;
    }

    if (BLANK.test(content)) {
      flushRun();
      continue;
    }

    if (COMMENT.test(content)) {
      flushRun();
      elements.push({ kind: 'comment', span, owner: null });
      continue;
    }

    if (beforeFileContent) {
      beforeFileContent = false;
      const drawer = parsePropertyDrawer(text, lines, i);
      if (drawer) {
        fileDrawer = drawer.element;
        elements.push(drawer.element);
        i = drawer.endLine;
        continue;
      }
    }

    if (FIXED_WIDTH.test(content)) {
      flushRun();
      elements.push({ kind: 'fixedWidth', span, owner: null });
      continue;
    }

    const blockBegin = BLOCK_BEGIN.exec(content);
    if (blockBegin) {
      const name = blockBegin[1].toLowerCase();
      const endLine = closings.block(name, i);
      if (endLine !== -1) {
        flushRun();
        const verbatim = VERBATIM_BLOCKS.has(name);
        const parameters = blockBegin[2] ?? '';
        const block: OrgBlock = {
          kind: 'block',
          span: { start: line.start, end: lines[endLine].end },
          owner: null,
          name,
          parameters: parameters.slice(0, trimBlanksEnd(parameters, 0, parameters.length)),
          verbatim,
          contentSpan: { start: line.next, end: lines[endLine].start },
        };
        elements.push(block);
        if (verbatim) i = endLine;
        else closingLines.add(endLine);
        continue;
      }
    }

    const drawerOpen = i > openDrawerEnd ? DRAWER_OPEN.exec(content) : null;
    if (drawerOpen && !DRAWER_END.test(content)) {
      const endLine = closings.drawer(i);
      if (endLine !== -1) {
        flushRun();
        elements.push({
          kind: 'drawer',
          span: { start: line.start, end: lines[endLine].end },
          owner: null,
          name: drawerOpen[1],
          isPropertyDrawer: false,
          properties: [],
          contentSpan: { start: line.next, end: lines[endLine].start },
        });
        closingLines.add(endLine);
        openDrawerEnd = endLine;
        continue;
      }
    }

    const keyword = parseKeyword(text, line, content);
    if (keyword) {
      flushRun();
      elements.push(keyword);
      continue;
    }

    // Each list item and table row is its own run, so emphasis cannot span them.
    if (LIST_ITEM.test(content) || TABLE_ROW.test(content)) flushRun();
    if (run) run.end = line.end;
    else run = span;
  }
  flushRun();
  return { elements, fileDrawer };
}

function lineText(text: string, line: Line): string {
  return text.slice(line.start, line.end);
}

function lineSpan(line: Line): Span {
  return { start: line.start, end: line.end };
}

function newHeading(span: Span, level: number): OrgHeading {
  return {
    kind: 'heading',
    span,
    owner: null,
    level,
    todo: null,
    priority: null,
    title: '',
    titleSpan: { start: span.end, end: span.end },
    tags: [],
    properties: [],
    node: null,
  };
}

/** Org accepts a property drawer only if every line up to `:END:` is a property. */
function parsePropertyDrawer(
  text: string,
  lines: Line[],
  index: number,
): { element: OrgDrawer; endLine: number } | null {
  if (index >= lines.length) return null;
  const open = lines[index];
  const openText = lineText(text, open);
  if (!PROPERTIES_OPEN.test(openText)) return null;
  const properties: OrgProperty[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i];
    const content = lineText(text, line);
    if (DRAWER_END.test(content)) {
      return {
        element: {
          kind: 'drawer',
          span: { start: open.start, end: line.end },
          owner: null,
          name: openText.trim().slice(1, -1),
          isPropertyDrawer: true,
          properties,
          contentSpan: { start: open.next, end: line.start },
        },
        endLine: i,
      };
    }
    const property = PROPERTY.exec(content);
    if (!property) return null;
    properties.push(toProperty(text, line, property));
  }
  return null;
}

function toProperty(text: string, line: Line, match: RegExpExecArray): OrgProperty {
  const raw = match[2] ?? '';
  const valueStart = line.end - raw.length;
  const valueEnd = trimBlanksEnd(text, valueStart, line.end);
  return {
    key: match[1],
    value: text.slice(valueStart, valueEnd),
    valueSpan: { start: valueStart, end: valueEnd },
  };
}

function parseKeyword(text: string, line: Line, content: string): OrgKeyword | null {
  const match = KEYWORD.exec(content);
  if (!match) return null;
  const key = match[2].toUpperCase();
  if (DYNAMIC_BLOCK_KEYS.has(key)) return null;
  const keyStart = line.start + match[1].length;
  const valueStart = keyStart + match[2].length + match[3].length;
  const valueEnd = trimBlanksEnd(text, valueStart, line.end);
  return {
    kind: 'keyword',
    span: lineSpan(line),
    owner: null,
    key,
    keySpan: { start: keyStart, end: keyStart + match[2].length },
    value: text.slice(valueStart, valueEnd),
    valueSpan: { start: valueStart, end: valueEnd },
  };
}

/** Parses the heading line's parts. Runs once keywords are known, since a file can declare them. */
function fillHeading(text: string, heading: OrgHeading, todoKeywords: string[]): void {
  const lineEnd = heading.span.end;
  let pos = skipBlanks(text, heading.span.start + heading.level, lineEnd);

  const firstWord = wordAt(text, pos, lineEnd);
  if (todoKeywords.includes(firstWord)) {
    heading.todo = firstWord;
    pos = skipBlanks(text, pos + firstWord.length, lineEnd);
  }

  const priority = PRIORITY.exec(text.slice(pos, lineEnd));
  if (priority) {
    heading.priority = priority[1];
    pos += priority[0].length;
  }

  let titleEnd = trimBlanksEnd(text, pos, lineEnd);
  let tokenStart = titleEnd;
  while (tokenStart > pos && text[tokenStart - 1] !== ' ' && text[tokenStart - 1] !== '\t') {
    tokenStart--;
  }
  const lastToken = text.slice(tokenStart, titleEnd);
  if (TAG_TOKEN.test(lastToken)) {
    heading.tags = lastToken.split(':').filter((tag) => tag !== '');
    titleEnd = trimBlanksEnd(text, pos, tokenStart);
  }

  heading.titleSpan = { start: pos, end: titleEnd };
  heading.title = linkDisplayText(text.slice(pos, titleEnd));
}

function skipBlanks(text: string, start: number, end: number): number {
  let pos = start;
  while (pos < end && (text[pos] === ' ' || text[pos] === '\t')) pos++;
  return pos;
}

function wordAt(text: string, start: number, end: number): string {
  let pos = start;
  while (pos < end && text[pos] !== ' ' && text[pos] !== '\t') pos++;
  return text.slice(start, pos);
}

function nodeIdOf(properties: OrgProperty[]): string | null {
  const id = properties.find((property) => property.key.toUpperCase() === 'ID');
  if (!id || id.value === '') return null;
  const exclude = properties.find((property) => property.key.toUpperCase() === 'ROAM_EXCLUDE');
  // Org reads only the literal `nil` as unset, so an empty value still excludes.
  return id.value;
}

/**
 * `#+TODO: NEXT(n) WAITING(w@/!) | CANCELLED(c)` and its SEQ_ and TYP_ variants. Declaring any
 * replaces the defaults rather than adding to them.
 */
function collectTodoKeywords(keywords: OrgKeyword[]): string[] {
  const declared: string[] = [];
  for (const keyword of keywords) {
    if (!TODO_DECLARATIONS.has(keyword.key)) continue;
    for (const word of keyword.value.split(/[ \t]+/)) {
      const name = word.replace(/\(.*\)$/s, '');
      if (name !== '' && name !== '|') declared.push(name);
    }
  }
  return declared.length > 0 ? unique(declared) : [...DEFAULT_TODO_KEYWORDS];
}

function collectFileTags(keywords: OrgKeyword[]): string[] {
  const tags: string[] = [];
  for (const keyword of keywords) {
    if (keyword.key !== 'FILETAGS') continue;
    for (const tag of keyword.value.split(':')) {
      const trimmed = tag.trim();
      if (trimmed !== '') tags.push(trimmed);
    }
  }
  return unique(tags);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function collectLinks(
  text: string,
  element: OrgElement,
  owner: number | null,
  links: OrgLink[],
): void {
  switch (element.kind) {
    case 'text':
      addLinks(text, element.span, owner, links);
      break;
    case 'heading':
      addLinks(text, element.titleSpan, owner, links);
      break;
    case 'keyword':
      if (!LINK_FREE_KEYWORDS.has(element.key)) addLinks(text, element.valueSpan, owner, links);
      break;
    case 'drawer':
      for (const property of element.properties) {
        if (!LINK_FREE_PROPERTIES.has(property.key.toUpperCase())) {
          addLinks(text, property.valueSpan, owner, links);
        }
      }
      break;
    default:
      break;
  }
}

function addLinks(text: string, span: Span, source: number | null, links: OrgLink[]): void {
  if (span.start === span.end) return;
  addTokenLinks(tokenizeInline(text, span.start, span.end), source, links);
}

function addTokenLinks(tokens: InlineToken[], source: number | null, links: OrgLink[]): void {
  for (const token of tokens) {
    if (token.type === 'link') {
      if (token.linkType === 'id' && token.target !== '') {
        links.push({
          target: token.target,
          description: token.description,
          form: token.form,
          span: token.span,
          source,
        });
      }
    } else if ('children' in token) {
      addTokenLinks(token.children, source, links);
    }
  }
}

function findHeaderEnd(
  elements: OrgElement[],
  fileDrawer: OrgDrawer | null,
  lines: Line[],
  bomLength: number,
): number {
  let lastEnd = -1;
  for (const element of elements) {
    if (element.kind !== 'comment' && element.kind !== 'keyword' && element !== fileDrawer) break;
    lastEnd = element.span.end;
  }
  if (lastEnd === -1) return bomLength;
  const lastLine = lines.find((line) => line.end === lastEnd);
  return lastLine ? lastLine.next : lastEnd;
}
