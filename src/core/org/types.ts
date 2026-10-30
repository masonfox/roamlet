// The scanner's output, and the only view of Org syntax the rest of the app gets (Decision 1).

/** Half-open range of UTF-16 code units in the original text, BOM and line endings included. */
export interface Span {
  start: number;
  end: number;
}

export type LineEnding = 'none' | 'lf' | 'crlf' | 'mixed';

interface ElementBase {
  /** The whole element. Excludes the line ending of its last line. */
  span: Span;
  /** Index into `OrgDocument.nodes` of the nearest enclosing node, or null if there is none. */
  owner: number | null;
}

export interface OrgProperty {
  /** As written. Compare case-insensitively. */
  key: string;
  value: string;
  valueSpan: Span;
}

export interface OrgHeading extends ElementBase {
  kind: 'heading';
  level: number;
  todo: string | null;
  priority: string | null;
  /** Excludes stars, TODO keyword, priority, COMMENT, and tags. Links show their description. */
  title: string;
  /** The title as written, which may hold link syntax. */
  titleSpan: Span;
  /** The heading's own tags, without inherited ones. */
  tags: string[];
  /** The heading's own property drawer. Empty when it has none. */
  properties: OrgProperty[];
  /** Index into `OrgDocument.nodes`, or null if this heading is not a node. */
  node: number | null;
}

export interface OrgPlanning extends ElementBase {
  kind: 'planning';
}

/**
 * A property drawer has parsed `properties`. Any other drawer's content is scanned as usual, so
 * its elements follow it in `OrgDocument.elements`, with spans inside its own.
 */
export interface OrgDrawer extends ElementBase {
  kind: 'drawer';
  /** As written, such as `PROPERTIES` or `LOGBOOK`. */
  name: string;
  isPropertyDrawer: boolean;
  properties: OrgProperty[];
  /** From the line after the opening line up to the start of the closing line. */
  contentSpan: Span;
}

export interface OrgKeyword extends ElementBase {
  kind: 'keyword';
  /** Uppercased. Use `keySpan` for the casing as written. */
  key: string;
  keySpan: Span;
  /** The value without surrounding blanks. */
  value: string;
  /** Exactly the characters of `value`. Empty, at the end of the line's text, if it has none. */
  valueSpan: Span;
}

/**
 * Verbatim blocks (src, example, comment, export) hold raw text. Any other block's content is
 * scanned as usual, so its elements follow it in `OrgDocument.elements`, with spans inside its own.
 */
export interface OrgBlock extends ElementBase {
  kind: 'block';
  /** Lowercased, such as `src` or `quote`. */
  name: string;
  /** Text after the name on the opening line, such as `python :results output`. */
  parameters: string;
  verbatim: boolean;
  /** From the line after the opening line up to the start of the closing line. */
  contentSpan: Span;
}

export interface OrgComment extends ElementBase {
  kind: 'comment';
}

export interface OrgFixedWidth extends ElementBase {
  kind: 'fixedWidth';
}

/** Anything unrecognized: consecutive lines of a paragraph, one list item, or one table row. */
export interface OrgText extends ElementBase {
  kind: 'text';
}

export type OrgElement =
  | OrgHeading
  | OrgPlanning
  | OrgDrawer
  | OrgKeyword
  | OrgBlock
  | OrgComment
  | OrgFixedWidth
  | OrgText;

/** A node as found in one file. Files and paths are the index's concern (Decision 2). */
export interface OrgNode {
  id: string;
  /** 0 for a file-level node, otherwise the heading's number of stars. */
  level: number;
  title: string;
  /** Own tags plus those inherited from `#+filetags` and ancestor headings. */
  tags: string[];
  /** 0 for a file-level node, otherwise the start of the heading line. */
  startOffset: number;
}

export type LinkForm = 'bracket' | 'angle' | 'plain';

/** An `id:` link in text that Org would parse as a link. */
export interface OrgLink {
  /** The ID, without the `id:` prefix. */
  target: string;
  /** Null when the link has none. Line endings inside it are normalized to LF. */
  description: string | null;
  form: LinkForm;
  span: Span;
  /** Index into `OrgDocument.nodes`. Null means the link is outside any node and has no source. */
  source: number | null;
}

export interface OrgDocument {
  /** Length of the original text. */
  length: number;
  /** 1 if the text starts with a byte order mark, otherwise 0. */
  bomLength: number;
  eol: LineEnding;
  /** Everything but blank lines, ordered by start offset. */
  elements: OrgElement[];
  /** The file-level node, if any, then heading nodes in document order. */
  nodes: OrgNode[];
  /** `id:` links in document order, including those with no source. */
  links: OrgLink[];
  /** The display title: from the first `#+title`, else the file name, else empty. */
  title: string;
  /** The first `#+title` keyword, whose `valueSpan` is what `spliceTitle` replaces. */
  titleKeyword: OrgKeyword | null;
  /** From all `#+filetags` keywords, without duplicates. */
  tags: string[];
  /** The file-level property drawer, whether or not it makes the file a node. */
  fileDrawer: OrgDrawer | null;
  /** Keywords that mark a heading's TODO state: `TODO`, `DONE`, and those the file declares. */
  todoKeywords: string[];
  /**
   * Where the editable body starts: after the leading run of blank lines, comments, the file
   * drawer, and keywords, including the last one's line ending.
   */
  headerEnd: number;
}

export interface ScanOptions {
  /** File name or path, used for the title when the file has no `#+title`. */
  fileName?: string;
}

export type EmphasisType = 'bold' | 'italic' | 'underline' | 'strike';

export type InlineToken =
  | { type: 'text'; span: Span }
  | { type: 'verbatim' | 'code'; span: Span; contentSpan: Span }
  | { type: EmphasisType; span: Span; contentSpan: Span; children: InlineToken[] }
  | {
      type: 'link';
      span: Span;
      form: LinkForm;
      /** `id`, `https`, `file`, and so on. `fuzzy` for a bracket link with no type. */
      linkType: string;
      /** The link without its type prefix, and with bracket escapes removed. */
      target: string;
      /** Null when the link has none. Line endings inside it are normalized to LF. */
      description: string | null;
      descriptionSpan: Span | null;
    };
