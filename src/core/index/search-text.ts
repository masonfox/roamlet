import { tokenizeInline, unescapeBlockContent } from '../org';
import type { InlineToken, OrgDocument, Span } from '../org';

/** One row of the search table: a node's own text, or the text outside any node. */
export interface SearchUnit {
  /** Index into `OrgDocument.nodes`, or null for the file-level unit of a file with no such node. */
  node: number | null;
  title: string;
  body: string;
}

function slice(text: string, span: Span): string {
  return text.slice(span.start, span.end);
}

/** What a reader sees of inline syntax. Link targets stay out, so raw IDs can't match. */
function inlineText(text: string, tokens: InlineToken[]): string {
  let result = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        result += slice(text, token.span);
        break;
      case 'verbatim':
      case 'code':
        result += slice(text, token.contentSpan);
        break;
      case 'link':
        result += token.description ?? (token.linkType === 'id' ? '' : token.target);
        break;
      default:
        result += inlineText(text, token.children);
    }
  }
  return result;
}

/** NFC, so text and queries spelled with combining marks compare equal in `LIKE`. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFC');
}

/**
 * Splits a file's text into search units (Decision 5). Keywords, property drawers, planning lines,
 * and comments are metadata and stay out. A file with no file-level node always gets a unit, so its
 * title can be found even when all of its text belongs to heading nodes.
 */
export function searchUnits(text: string, doc: OrgDocument): SearchUnit[] {
  const bodies = new Map<number | null, string[]>();
  const add = (owner: number | null, part: string) => {
    const parts = bodies.get(owner);
    if (parts) parts.push(part);
    else bodies.set(owner, [part]);
  };

  for (const element of doc.elements) {
    switch (element.kind) {
      case 'heading':
        // A node's heading is its title. Any other heading is text of the node around it.
        if (element.node === null) add(element.owner, element.title);
        break;
      case 'text':
        add(element.owner, inlineText(text, tokenizeInline(text, element.span.start, element.span.end)));
        break;
      case 'fixedWidth':
        add(element.owner, slice(text, element.span));
        break;
      case 'block':
        if (element.verbatim && element.name !== 'comment') {
          add(element.owner, unescapeBlockContent(slice(text, element.contentSpan)));
        }
        break;
      default:
    }
  }

  const bodyOf = (owner: number | null) => normalizeSearchText((bodies.get(owner) ?? []).join('\n'));
  const units: SearchUnit[] = doc.nodes.map((node, index) => ({
    node: index,
    title: normalizeSearchText(node.title),
    body: bodyOf(index),
  }));
  if (doc.nodes[0]?.level !== 0) {
    units.unshift({ node: null, title: normalizeSearchText(doc.title), body: bodyOf(null) });
  }
  return units;
}
