import { unescapeBlockContent, type OrgDocument, type OrgElement, type Span } from '../../core/org';

// What the reader shows, derived from the scanner's elements (Decision 7). Anything without a
// rendering of its own becomes a `literal` block, so unsupported syntax stays visible.

interface BlockBase {
  /** The source this block shows, and its list key. */
  span: Span;
  /** Inside a quote or center block. */
  quoted: boolean;
}

export interface HeadingBlock extends BlockBase {
  kind: 'heading';
  level: number;
  todo: string | null;
  priority: string | null;
  tags: string[];
  titleSpan: Span;
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph';
}

export interface ListItemBlock extends BlockBase {
  kind: 'listItem';
  /** As written, such as `-` or `1.`. */
  marker: string;
  /** Leading blanks on the item's first line. */
  indent: number;
  contentSpan: Span;
}

/** Rows or lines kept exactly as written, which scroll sideways rather than wrap. */
export interface PreformattedBlock extends BlockBase {
  kind: 'table' | 'source' | 'example';
  /** What the block shows, without its opening and closing lines. */
  content: string;
  /** The language of a source block, if it names one. */
  language: string | null;
}

export interface LiteralBlock extends BlockBase {
  kind: 'literal';
  /** `verse` text wraps like reading text, and everything else is shown as source. */
  style: 'source' | 'verse';
  content: string;
}

export type ReaderBlock =
  | HeadingBlock
  | ParagraphBlock
  | ListItemBlock
  | PreformattedBlock
  | LiteralBlock;

const LIST_ITEM = /^([ \t]*)([-+*]|\d+[.)]|[A-Za-z][.)])[ \t]+/;
const TABLE_ROW = /^[ \t]*\|/;
// Dynamic blocks, stray block lines, and LaTeX environments read wrongly as prose or emphasis.
const LITERAL_RUN = /^[ \t]*(?:#\+|\\begin\{)/;
const CONTAINER_BLOCKS = new Set(['quote', 'center']);

function slice(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}

/** Lines one after the other, with no blank line or other element between them. */
function adjacent(text: string, before: Span, after: Span): boolean {
  return /^\r?\n$/.test(text.slice(before.end, after.start));
}

/** Source as shown on screen, where a carriage return has no meaning. */
function shown(source: string): string {
  return source.replace(/\r\n/g, '\n');
}

/** Block content without the line ending before its closing line. */
function blockContent(text: string, span: Span): string {
  return shown(unescapeBlockContent(slice(text, span))).replace(/\n$/, '');
}

function textBlock(text: string, span: Span, quoted: boolean): ReaderBlock {
  const source = slice(text, span);
  if (TABLE_ROW.test(source)) {
    return { kind: 'table', span, quoted, content: shown(source), language: null };
  }
  if (LITERAL_RUN.test(source)) {
    return { kind: 'literal', span, quoted, style: 'source', content: shown(source) };
  }
  const item = LIST_ITEM.exec(source);
  if (item) {
    return {
      kind: 'listItem',
      span,
      quoted,
      marker: item[2],
      indent: item[1].length,
      contentSpan: { start: span.start + item[0].length, end: span.end },
    };
  }
  return { kind: 'paragraph', span, quoted };
}

/** Metadata the reader hides. Everything else in the document gets a block. */
function isHidden(element: OrgElement, doc: OrgDocument): boolean {
  if (element.kind === 'drawer' && element.isPropertyDrawer) return true;
  return (element.kind === 'keyword' || element.kind === 'comment') && element.span.end <= doc.headerEnd;
}

/** Turns a scanned document into the reader's blocks, in document order. */
export function buildBlocks(text: string, doc: OrgDocument): ReaderBlock[] {
  const blocks: ReaderBlock[] = [];
  // Elements inside a literal block are already shown by it.
  let literalEnd = -1;
  let quoteEnd = -1;

  const addLines = (kind: 'table' | 'example', span: Span, quoted: boolean, content: string) => {
    const previous = blocks.at(-1);
    if (previous?.kind === kind && previous.quoted === quoted && adjacent(text, previous.span, span)) {
      previous.span = { start: previous.span.start, end: span.end };
      previous.content += `\n${content}`;
    } else {
      blocks.push({ kind, span, quoted, content, language: null });
    }
  };

  for (const element of doc.elements) {
    const { span } = element;
    if (span.start < literalEnd || isHidden(element, doc)) continue;
    const quoted = span.start < quoteEnd;
    const literal = (content = shown(slice(text, span)), style: LiteralBlock['style'] = 'source') => {
      blocks.push({ kind: 'literal', span, quoted, style, content });
      literalEnd = span.end;
    };

    switch (element.kind) {
      case 'heading':
        blocks.push({
          kind: 'heading',
          span,
          quoted,
          level: element.level,
          todo: element.todo,
          priority: element.priority,
          tags: element.tags,
          titleSpan: element.titleSpan,
        });
        break;
      case 'text': {
        const block = textBlock(text, span, quoted);
        if (block.kind === 'table') addLines('table', span, quoted, block.content);
        else blocks.push(block);
        break;
      }
      case 'fixedWidth':
        addLines('example', span, quoted, slice(text, span).replace(/^[ \t]*:(?: |$)/, ''));
        break;
      case 'block':
        if (element.name === 'src') {
          blocks.push({
            kind: 'source',
            span,
            quoted,
            content: blockContent(text, element.contentSpan),
            language: element.parameters.split(/[ \t]+/)[0] || null,
          });
        } else if (element.name === 'example') {
          blocks.push({
            kind: 'example',
            span,
            quoted,
            content: blockContent(text, element.contentSpan),
            language: null,
          });
        } else if (element.name === 'verse') {
          literal(blockContent(text, element.contentSpan), 'verse');
        } else if (CONTAINER_BLOCKS.has(element.name)) {
          quoteEnd = Math.max(quoteEnd, span.end);
        } else {
          literal();
        }
        break;
      default:
        // Planning lines, other drawers, keywords and comments in the body, and anything added to
        // the scanner later.
        literal();
    }
  }
  return blocks;
}

/**
 * The block to scroll to for a source offset: the one containing it, or else the next one. Null
 * when the offset is past every block.
 */
export function blockIndexAt(blocks: ReaderBlock[], offset: number): number | null {
  const index = blocks.findIndex((block) => block.span.end > offset);
  return index === -1 ? null : index;
}
