import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeUtf8, encodeUtf8 } from '../../src/core/library/utf8';
import {
  editableBody,
  insertLink,
  normalizeLineEndings,
  renderNewNote,
  scan,
  spliceBody,
  spliceTitle,
} from '../../src/core/org';
import type { SpliceResult } from '../../src/core/org';
import type { Results } from './compare';

// Scripted edits for the round trip (design.md, Decision 8). Each scenario edits a copy of the corpus
// through the core's operations. It also works out each file's bytes from the original bytes alone,
// without those operations, so that a wrong or overly wide splice shows up as a byte difference.

export const SCENARIOS = [
  'body-start',
  'body-end',
  'body-replace',
  'title',
  'body-and-title',
  'notes-and-links',
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export interface Effect {
  /** Title changes by file, for its file-level node. `from` is empty if the file had no title. */
  titles: Record<string, { from: string; to: string }>;
  newNodes: { id: string; file: string; title: string }[];
  newLinks: { source: string; dest: string }[];
}

/** A note that the scenario created. */
export interface CreatedNote {
  id: string;
  title: string;
  fileName: string;
}

/** A link that the scenario inserted, and the description it should have in the file. */
export interface InsertedLink {
  file: string;
  source: string;
  dest: string;
  title: string;
  description: string;
}

export interface Scenario {
  /** Files as the core's operations left them. This is what Org-roam syncs. */
  files: Record<string, Uint8Array>;
  /** Files as worked out from the original bytes. */
  expected: Record<string, Uint8Array>;
  /** What Org-roam should report differently from the unedited corpus. */
  effect: Effect;
  created: CreatedNote[];
  inserted: InsertedLink[];
  /** Entries of the base allowlist that the edits rightly make stale. */
  resolved: string[];
}

const ZERO_WIDTH_SPACE = '​';
const INSERTED_TEXT = 'Edited by Roamlet.\n';
const ADDED_TITLE = 'Added title';
const TITLE_SUFFIX = ' edited';

/** Files with no title keyword: the text that a new `#+title` line goes after. */
const TITLE_ANCHORS: Record<string, string> = {
  '20260101120000-foo.org': ':END:\n',
  'malformed-drawers.org': '',
};

/** The title of `20260101120000-foo.org` was the allowlisted difference, and now both tools agree. */
const RESOLVED_BY_TITLE = [
  'node-title 20260101120000-foo.org 00000000-0000-4000-8000-000000000024 oracle="" scanner="20260101120000-foo"',
];

const REPLACEMENTS: { file: string; find: string; replacement: string }[] = [
  { file: 'headings.org', find: 'Intro text.', replacement: 'Edited intro\nacross two lines.' },
  { file: 'line-endings-crlf.org', find: 'Link:', replacement: 'First line\nSecond line:' },
  { file: 'line-endings-mixed.org', find: 'description', replacement: 'edited\ndescription' },
  { file: 'bom.org', find: 'Text with a', replacement: 'Text\nwith a' },
  { file: 'bom-crlf.org', find: 'Text with a', replacement: 'Text\nwith a' },
  // These two emoji share a high surrogate, which the splice must not cut through.
  { file: 'unicode.org', find: '\u{1f4bb}', replacement: '\u{1f680}' },
  {
    file: 'links-no-file-node.org',
    find: 'Still outside any node: [[id:00000000-0000-4000-8000-000000000002]].\n',
    replacement: '',
  },
];

const noteId = (index: number) => `00000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`;
const fixtureId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

const CAPTURES = [
  'Plain target',
  `Capture with a body\n\nIt links to [[id:${fixtureId('01')}][Headings]].\n\n* Heading in the body\nWith text.`,
  'Café déjà vu',
  '日本語のノート',
  'Review [draft] notes',
  'Ends with bracket]',
  '[Starts] with a bracket',
  'Holds ]] in the middle',
  '[[Wrapped]]',
];

const FAKE_LINK = `[[id:${fixtureId('02')}][Fake]]`;

/** With no `anchor`, the link goes in a new line at the end of the file. */
const LINKS: {
  file: string;
  source: string;
  dest: string;
  title: string;
  description: string;
  anchor?: string;
}[] = [
  {
    file: 'bom.org',
    source: fixtureId('42'),
    dest: noteId(4),
    title: 'Review [draft] notes',
    description: 'Review [draft] notes',
  },
  {
    file: 'bom-crlf.org',
    source: fixtureId('43'),
    dest: noteId(5),
    title: 'Ends with bracket]',
    description: `Ends with bracket]${ZERO_WIDTH_SPACE}`,
  },
  {
    file: 'line-endings-crlf.org',
    source: fixtureId('39'),
    dest: noteId(7),
    title: 'Holds ]] in the middle',
    description: `Holds ]${ZERO_WIDTH_SPACE}] in the middle`,
  },
  {
    file: 'line-endings-lf.org',
    source: fixtureId('37'),
    dest: noteId(6),
    title: '[Starts] with a bracket',
    description: '[Starts] with a bracket',
  },
  {
    file: 'bom-heading.org',
    source: fixtureId('95'),
    dest: noteId(8),
    title: '[[Wrapped]]',
    description: `[[Wrapped]${ZERO_WIDTH_SPACE}]${ZERO_WIDTH_SPACE}`,
  },
  {
    // A description that looks like a link to something else must not count as one.
    file: 'unicode.org',
    source: fixtureId('45'),
    dest: noteId(0),
    title: FAKE_LINK,
    description: `[[id:${fixtureId('02')}][Fake]${ZERO_WIDTH_SPACE}]${ZERO_WIDTH_SPACE}`,
  },
  {
    file: 'links-no-file-node.org',
    source: fixtureId('23'),
    dest: noteId(5),
    title: 'Ends with bracket]',
    description: `Ends with bracket]${ZERO_WIDTH_SPACE}`,
  },
  {
    // Replaces a selection, and links to a heading node of the corpus.
    file: 'headings.org',
    source: fixtureId('01'),
    dest: fixtureId('02'),
    title: 'Heading node',
    description: 'Heading node',
    anchor: 'Intro',
  },
];

/** The `.org` files of a directory, as bytes. */
export function readOrgFiles(directory: string): Record<string, Buffer> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith('.org'))
      .map((name) => [name, readFileSync(join(directory, name))]),
  );
}

/** The offset of the first byte that differs, or null if the two are identical. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number | null {
  const shared = Math.min(a.length, b.length);
  for (let offset = 0; offset < shared; offset++) {
    if (a[offset] !== b[offset]) return offset;
  }
  return a.length === b.length ? null : shared;
}

/** What Org-roam should report after the edits, from what it reported before them. */
export function expectedResults(before: Results, effect: Effect): Results {
  return {
    files: [
      ...before.files,
      ...effect.newNodes.map((node) => node.file),
    ].sort(),
    nodes: [
      ...before.nodes.map((node) => {
        const change = node.level === 0 ? effect.titles[node.file] : undefined;
        if (!change) return node;
        const title = change.from === '' ? change.to : node.title.replace(change.from, change.to);
        return { ...node, title };
      }),
      ...effect.newNodes.map((node) => ({ ...node, level: 0, pos: 1, tags: [] })),
    ],
    links: [...before.links, ...effect.newLinks],
  };
}

/** Puts a title-edited difference back in the form the base allowlist lists it. */
export function undoTitleEdit(difference: string): string {
  return difference.replaceAll(TITLE_SUFFIX, '');
}

/** Builds a scenario over the corpus. It writes nothing. */
export function buildScenario(name: ScenarioName, fixtures: Record<string, Buffer>): Scenario {
  const drafts = new Map(
    Object.entries(fixtures).map(([file, bytes]) => [file, startDraft(file, bytes)]),
  );
  const result: Omit<Scenario, 'files' | 'expected'> = {
    effect: { titles: {}, newNodes: [], newLinks: [] },
    created: [],
    inserted: [],
    resolved: [],
  };
  const expected: Record<string, Uint8Array> = {};
  const files: Record<string, Uint8Array> = {};

  const update = (file: string, edit: (draft: Draft) => Draft) => {
    drafts.set(file, edit(drafts.get(file)!));
  };
  const editTitles = () => {
    for (const file of drafts.keys()) {
      update(file, (draft) => {
        const { draft: next, from, to } = editTitle(draft);
        result.effect.titles[file] = { from, to };
        return next;
      });
    }
    result.resolved = RESOLVED_BY_TITLE;
  };

  switch (name) {
    case 'body-start':
      for (const file of drafts.keys()) update(file, insertAtBodyStart);
      break;
    case 'body-end':
      for (const file of drafts.keys()) update(file, insertAtEnd);
      break;
    case 'body-replace':
      for (const { file, find, replacement } of REPLACEMENTS) {
        update(file, (draft) => {
          const start = draft.text.indexOf(find);
          if (start === -1) throw new Error(`${file} does not hold ${JSON.stringify(find)}`);
          return editBody(draft, start, start + find.length, replacement);
        });
      }
      break;
    case 'title':
      editTitles();
      break;
    case 'body-and-title':
      for (const file of drafts.keys()) update(file, insertAtBodyStart);
      editTitles();
      break;
    case 'notes-and-links': {
      CAPTURES.forEach((capture, index) => {
        const note = renderNewNote(
          capture,
          { newId: () => noteId(index) },
          { now: () => new Date(2026, 5, 15, 10, 30, 0) },
        )!;
        const { id, title, fileName } = note;
        files[fileName] = encodeUtf8(note.content);
        expected[fileName] = Buffer.from(newNoteContent(id, title, capture));
        result.created.push({ id, title, fileName });
        result.effect.newNodes.push({ id, file: fileName, title });
      });
      result.effect.newLinks.push({ source: noteId(1), dest: fixtureId('01') });
      for (const link of LINKS) {
        update(link.file, (draft) => insertLinkInto(draft, link));
        const { file, source, dest, title, description } = link;
        result.inserted.push({ file, source, dest, title, description });
        result.effect.newLinks.push({ source, dest });
      }
      break;
    }
  }

  for (const [file, draft] of drafts) {
    files[file] = encodeUtf8(draft.text);
    expected[file] = draft.expected;
  }
  return { ...result, files, expected };
}

/** A file part way through its edits. */
interface Draft {
  file: string;
  text: string;
  expected: Buffer;
}

function startDraft(file: string, bytes: Buffer): Draft {
  const text = decodeUtf8(bytes);
  if (text === null) throw new Error(`${file} is not valid UTF-8`);
  return { file, text, expected: bytes };
}

/** The next draft: the text from the core's operation, the bytes from `start`, `end`, and `replacement`. */
function advance(
  draft: Draft,
  operation: SpliceResult,
  start: number,
  end: number,
  replacement: string,
): Draft {
  if (!operation.changed) throw new Error(`${draft.file}: the edit changed nothing`);
  const startByte = Buffer.byteLength(draft.text.slice(0, start));
  const endByte = Buffer.byteLength(draft.text.slice(0, end));
  return {
    ...draft,
    text: operation.text,
    expected: Buffer.concat([
      draft.expected.subarray(0, startByte),
      Buffer.from(replacement),
      draft.expected.subarray(endByte),
    ]),
  };
}

/** The line ending new text should use at `offset`: the next one in the file, else the last one. */
function lineEndingAt(text: string, offset: number): string {
  let newline = text.indexOf('\n', offset);
  if (newline === -1) newline = text.lastIndexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
}

/** Replaces `start` to `end` of the file, the way the editor would, with text in LF form. */
function editBody(draft: Draft, start: number, end: number, replacement: string): Draft {
  const { text, file } = draft;
  const doc = scan(text, { fileName: file });
  const newBody =
    normalizeLineEndings(text.slice(doc.headerEnd, start)) +
    replacement +
    normalizeLineEndings(text.slice(end));
  const inFile = replacement.replace(/\n/g, lineEndingAt(text, start));
  return advance(draft, spliceBody(text, doc, newBody), start, end, inFile);
}

function insertAtBodyStart(draft: Draft): Draft {
  const { headerEnd } = scan(draft.text, { fileName: draft.file });
  return editBody(draft, headerEnd, headerEnd, INSERTED_TEXT);
}

function insertAtEnd(draft: Draft): Draft {
  const { length } = draft.text;
  return editBody(draft, length, length, INSERTED_TEXT);
}

function editTitle(draft: Draft): { draft: Draft; from: string; to: string } {
  const { file, text } = draft;
  const doc = scan(text, { fileName: file });
  const keyword = /^(#\+title:[ \t]*)(.*?)[ \t]*$/im.exec(text);
  if (keyword) {
    const from = keyword[2];
    const to = from + TITLE_SUFFIX;
    const start = keyword.index + keyword[1].length;
    const next = advance(draft, spliceTitle(text, doc, to), start, start + from.length, to);
    return { draft: next, from, to };
  }
  const anchor = TITLE_ANCHORS[file];
  if (anchor === undefined) throw new Error(`${file} has no title and no entry in TITLE_ANCHORS`);
  const start = text.indexOf(anchor) + anchor.length;
  const line = `#+title: ${ADDED_TITLE}${lineEndingAt(text, start)}`;
  const next = advance(draft, spliceTitle(text, doc, ADDED_TITLE), start, start, line);
  return { draft: next, from: '', to: ADDED_TITLE };
}

function insertLinkInto(draft: Draft, link: (typeof LINKS)[number]): Draft {
  const { text, file } = draft;
  const doc = scan(text, { fileName: file });
  const body = editableBody(text, doc);
  const written = `[[id:${link.dest}][${link.description}]]`;
  if (link.anchor !== undefined) {
    const start = text.indexOf(link.anchor);
    const cursor = normalizeLineEndings(text.slice(doc.headerEnd, start)).length;
    const selection = { start: cursor, end: cursor + link.anchor.length };
    const edited = insertLink(body, selection, link.dest, link.title).text;
    const end = start + link.anchor.length;
    return advance(draft, spliceBody(text, doc, edited), start, end, written);
  }
  const cursor = body.length + 'See '.length;
  const selection = { start: cursor, end: cursor };
  const edited = insertLink(`${body}See .\n`, selection, link.dest, link.title).text;
  const line = `See ${written}.${lineEndingAt(text, text.length)}`;
  return advance(draft, spliceBody(text, doc, edited), text.length, text.length, line);
}

/** Org-roam's default form, written out here so that it doesn't rely on `renderNewNote`. */
function newNoteContent(id: string, title: string, capture: string): string {
  const body = capture.split('\n').slice(2).join('\n');
  const header = `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n`;
  return body === '' ? header : `${header}\n${body}\n`;
}
