// Writes the test library for the device checks in tasks 1.8, 1.11, and 6.8 (A8 in design.md). The
// same seed and sizes always give the same bytes, so a copy can be regenerated for comparison. Run
// it with `npm run generate-library -- <directory>`. Node runs this file directly, so it can only
// use syntax that strips away, and it can't import other TypeScript from the repository.

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const MIB = 1024 * 1024;

export const DEFAULT_SEED = 1;
export const DEFAULT_NOTES = 5000;
export const DEFAULT_MIB = 50;
const MIN_NOTES = 20;

// Roughly what a section of a real note holds, which sets how many headings a note gets.
const BYTES_PER_SECTION = 2048;
const HEADING_NODE_CHANCE = 0.25;
const LINK_CHANCE = 0.2;
const UNICODE_SENTENCE_CHANCE = 0.08;
// In every this-many notes, for the search benchmark to find.
const RARE_WORD = 'quokka';
const RARE_WORD_EVERY = 50;
const LARGE_NOTE_EVERY = 1000;

const WORDS = [
  'meridian', 'lantern', 'harbor', 'copper', 'orchard', 'signal', 'granite', 'thicket', 'ember',
  'compass', 'willow', 'anchor', 'prairie', 'cobalt', 'juniper', 'atlas', 'ferry', 'marble',
  'quarry', 'saddle', 'tundra', 'violet', 'walnut', 'yarrow', 'zenith', 'almanac', 'basalt',
  'cedar', 'delta', 'estuary', 'fathom', 'glacier', 'hollow', 'inlet', 'jasper', 'kestrel',
  'lagoon', 'mesa', 'nectar', 'obsidian', 'pebble', 'quill', 'ridge', 'sparrow', 'timber',
  'umbra', 'valley', 'wicker', 'the', 'of', 'and', 'with', 'from', 'over', 'under', 'near',
  'review', 'draft', 'notes', 'idea', 'question', 'method', 'summary', 'pattern', 'source',
  'detail', 'outline', 'memory', 'practice', 'theory', 'example', 'change', 'system', 'project',
];

const UNICODE_SENTENCES = [
  '知识管理需要长期积累和不断整理。',
  '東京のカフェでメモを書きました。',
  '오늘 회의 내용을 정리했습니다.',
  'Le café est près de la rivière, déjà fermé à l’été.',
  'Die Größe der Übersicht überrascht uns.',
  'שלום עולם from the right-to-left corner.',
  'Reviewed the draft 👩‍💻 and it went well 🎉.',
];

// `slug` follows `org-roam-node-slug`, which strips diacritics and keeps other letters.
const UNICODE_TITLES = [
  { title: '知识管理', slug: '知识管理' },
  { title: '東京のカフェ', slug: '東京のカフェ' },
  { title: '회의 기록', slug: '회의_기록' },
  { title: 'Café culture', slug: 'cafe_culture' },
  { title: 'Über Notizen', slug: 'uber_notizen' },
  { title: 'Résumé drafts', slug: 'resume_drafts' },
];

const TAGS = ['idea', 'work', 'reading', 'draft', 'person', '日本語', 'café'];

// A share of the notes that aren't daily notes goes to each folder. '' is the library root.
const FOLDERS = ['', '', '', 'projects', 'people', 'reference/books', 'reference/papers', 'archive/2024'];
const DAILY_EVERY = 5;

export interface GenerateOptions {
  seed?: number;
  notes?: number;
  /** About how many bytes all the notes add up to. */
  totalBytes?: number;
}

export interface GeneratedFile {
  /** Relative to the library, `/`-separated. */
  path: string;
  text: string;
}

export interface LibrarySummary {
  notes: number;
  bytes: number;
  /** File-level nodes plus heading nodes. */
  nodes: number;
  headingNodes: number;
  links: number;
  filesWithoutIds: string[];
  /** SHA-256 over every path and its bytes. */
  hash: string;
}

export interface GeneratedLibrary {
  files: GeneratedFile[];
  summary: LibrarySummary;
}

interface PlannedSection {
  id: string | null;
  level: number;
  title: string;
  todo: boolean;
}

interface PlannedNote {
  index: number;
  path: string;
  id: string | null;
  title: string;
  tags: string[];
  weight: number;
  sections: PlannedSection[];
}

interface LinkTarget {
  id: string;
  title: string;
  note: number;
}

/** mulberry32. `Math.random` can't be seeded, and this is the same on every engine. */
function randomSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function hex32(value: number): string {
  return Math.floor(value * 4294967296)
    .toString(16)
    .padStart(8, '0');
}

/** A lowercase version 4 UUID, like the ones `org-id` makes. */
function newId(random: () => number): string {
  const digits = hex32(random()) + hex32(random()) + hex32(random()) + hex32(random());
  const variant = '89ab'[Math.floor(random() * 4)];
  return (
    `${digits.slice(0, 8)}-${digits.slice(8, 12)}-4${digits.slice(13, 16)}-` +
    `${variant}${digits.slice(17, 20)}-${digits.slice(20, 32)}`
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

function capitalized(word: string): string {
  return word[0].toUpperCase() + word.slice(1);
}

function phrase(random: () => number, length: number): string {
  const words: string[] = [];
  for (let count = 0; count < length; count += 1) words.push(pick(random, WORDS));
  return words.join(' ');
}

function sentence(random: () => number): string {
  return `${capitalized(phrase(random, 8 + Math.floor(random() * 9)))}.`;
}

function plainTitle(random: () => number): string {
  return capitalized(phrase(random, 2 + Math.floor(random() * 3)));
}

/** Most notes are small and a few are long. The odd very long one is about ten times the average. */
function noteWeight(random: () => number, index: number): number {
  if (index % LARGE_NOTE_EVERY === LARGE_NOTE_EVERY - 1) return 10;
  const skewed = random();
  return 0.25 + 3 * skewed * skewed * skewed;
}

function planPlace(
  random: () => number,
  index: number,
): { path: string; title: string; tags: string[] } {
  // UTC, so the names don't depend on where this runs.
  const start = Date.UTC(2020, 0, 1);
  if (index % DAILY_EVERY === 0) {
    const date = new Date(start + (index / DAILY_EVERY) * 86400000).toISOString().slice(0, 10);
    return { path: `daily/${date}.org`, title: date, tags: ['daily'] };
  }

  const unicode = index % 20 === 3 ? UNICODE_TITLES[((index - 3) / 20) % UNICODE_TITLES.length] : null;
  const title = unicode ? unicode.title : plainTitle(random);
  const slug = unicode ? unicode.slug : title.toLowerCase().replaceAll(' ', '_');
  const stamp = new Date(start + index * 3600000).toISOString();
  const prefix = stamp.slice(0, 19).replace(/[-:T]/g, '');
  const folder = FOLDERS[index % FOLDERS.length];
  const name = `${prefix}-${slug}.org`;
  const tags = random() < 0.6 ? [pick(random, TAGS)] : [];
  return { path: folder === '' ? name : `${folder}/${name}`, title, tags };
}

function planNotes(random: () => number, notes: number, totalBytes: number): PlannedNote[] {
  const noIdCount = Math.max(3, Math.round(notes / 500));
  const noIdEvery = Math.floor(notes / noIdCount);

  const weights: number[] = [];
  for (let index = 0; index < notes; index += 1) weights.push(noteWeight(random, index));
  const averageBytes = totalBytes / weights.reduce((sum, weight) => sum + weight, 0);

  return weights.map((weight, index) => {
    const hasId = index % noIdEvery !== noIdEvery - 1;
    const sections: PlannedSection[] = [];
    const count = Math.max(1, Math.round((weight * averageBytes) / BYTES_PER_SECTION));
    for (let section = 0; section < count; section += 1) {
      sections.push({
        id: hasId && random() < HEADING_NODE_CHANCE ? newId(random) : null,
        level: section > 0 && random() < 0.3 ? 2 : 1,
        title: plainTitle(random),
        todo: random() < 0.05,
      });
    }
    return {
      index,
      ...planPlace(random, index),
      id: hasId ? newId(random) : null,
      weight,
      sections,
    };
  });
}

function linkTargets(notes: PlannedNote[]): LinkTarget[] {
  const targets: LinkTarget[] = [];
  for (const note of notes) {
    if (note.id !== null) targets.push({ id: note.id, title: note.title, note: note.index });
    for (const section of note.sections) {
      if (section.id !== null) targets.push({ id: section.id, title: section.title, note: note.index });
    }
  }
  return targets;
}

function propertyDrawer(id: string): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n`;
}

/** Writes one note's text, stopping about when it reaches `budget` bytes. */
function renderNote(
  random: () => number,
  note: PlannedNote,
  targets: LinkTarget[],
  budget: number,
): { text: string; links: number } {
  const parts: string[] = [];
  let written = 0;
  let links = 0;
  const push = (part: string) => {
    parts.push(part);
    written += Buffer.byteLength(part);
  };

  const link = (): string => {
    // A file with no ID has no node for a link to belong to, so it gets none.
    if (note.id === null || random() >= LINK_CHANCE) return '';
    // The first few targets are hubs, which get many backlinks, as index notes do.
    const pool = random() < 0.2 ? targets.slice(0, 50) : targets;
    let target = pick(random, pool);
    while (target.note === note.index) target = pick(random, targets);
    links += 1;
    return random() < 0.1 ? ` See [[id:${target.id}]].` : ` See [[id:${target.id}][${target.title}]].`;
  };

  const paragraph = (): string => {
    const sentences: string[] = [];
    const count = 3 + Math.floor(random() * 5);
    for (let at = 0; at < count; at += 1) sentences.push(sentence(random));
    if (random() < UNICODE_SENTENCE_CHANCE) sentences.push(pick(random, UNICODE_SENTENCES));
    return `${sentences.join(' ')}${link()}\n\n`;
  };

  const block = (): string => {
    const kind = random();
    if (kind < 0.7) return paragraph();
    if (kind < 0.82) {
      const items: string[] = [];
      const count = 3 + Math.floor(random() * 4);
      for (let at = 0; at < count; at += 1) items.push(`- ${sentence(random)}\n`);
      return `${items.join('')}- ${phrase(random, 5)}.${link()}\n\n`;
    }
    if (kind < 0.88) {
      const rows = [`| ${phrase(random, 1)} | ${phrase(random, 1)} | count |\n`, '|---+---+---|\n'];
      for (let at = 0; at < 4; at += 1) {
        rows.push(`| ${phrase(random, 2)} | ${phrase(random, 2)} | ${Math.floor(random() * 1000)} |\n`);
      }
      return `${rows.join('')}\n`;
    }
    if (kind < 0.94) {
      return (
        `#+begin_src python\ndef ${pick(random, WORDS)}_total(items):\n` +
        `    return sum(item.${pick(random, WORDS)} for item in items)\n#+end_src\n\n`
      );
    }
    return `#+begin_quote\n${sentence(random)} ${sentence(random)}\n#+end_quote\n\n`;
  };

  if (note.id !== null) push(propertyDrawer(note.id));
  push(`#+title: ${note.title}\n`);
  if (note.tags.length > 0) push(`#+filetags: :${note.tags.join(':')}:\n`);
  push('\n');
  if (note.index % RARE_WORD_EVERY === 0) push(`Spotted a ${RARE_WORD} today.\n\n`);
  push(paragraph());

  note.sections.forEach((section, at) => {
    const keyword = section.todo ? 'TODO ' : '';
    push(`${'*'.repeat(section.level)} ${keyword}${section.title}\n`);
    if (section.id !== null) push(propertyDrawer(section.id));
    const sectionEnd = written + (budget - written) / (note.sections.length - at);
    do push(block());
    while (written < sectionEnd);
  });

  return { text: parts.join(''), links };
}

function hashOf(files: GeneratedFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.text);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Builds a library in memory. A library this size fits there, and nothing here touches a disk. */
export function generateLibrary(options: GenerateOptions = {}): GeneratedLibrary {
  const seed = options.seed ?? DEFAULT_SEED;
  const notes = options.notes ?? DEFAULT_NOTES;
  const totalBytes = options.totalBytes ?? DEFAULT_MIB * MIB;
  if (!Number.isSafeInteger(seed)) throw new Error('the seed must be a whole number');
  if (!Number.isSafeInteger(notes) || notes < MIN_NOTES) {
    throw new Error(`a library needs at least ${MIN_NOTES} notes`);
  }
  if (!(totalBytes > 0)) throw new Error('the size must be more than zero');

  const random = randomSource(seed);
  const planned = planNotes(random, notes, totalBytes);
  const targets = linkTargets(planned);

  // Each note's budget comes from what's left, so a note that overshoots is made up for later.
  let bytesLeft = totalBytes;
  let weightLeft = planned.reduce((sum, note) => sum + note.weight, 0);
  let bytes = 0;
  let links = 0;
  const files: GeneratedFile[] = [];
  for (const note of planned) {
    const rendered = renderNote(random, note, targets, (note.weight * bytesLeft) / weightLeft);
    const size = Buffer.byteLength(rendered.text);
    bytesLeft -= size;
    weightLeft -= note.weight;
    bytes += size;
    links += rendered.links;
    files.push({ path: note.path, text: rendered.text });
  }

  const fileNodes = planned.filter((note) => note.id !== null).length;
  return {
    files,
    summary: {
      notes,
      bytes,
      nodes: targets.length,
      headingNodes: targets.length - fileNodes,
      links,
      filesWithoutIds: planned.filter((note) => note.id === null).map((note) => note.path),
      hash: hashOf(files),
    },
  };
}

/** Writes a library into `directory`, creating it if needed. It must be empty, so nothing is lost. */
export function writeLibrary(library: GeneratedLibrary, directory: string): void {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length > 0) {
    throw new Error(`${directory} isn't empty, so nothing was written`);
  }
  for (const file of library.files) {
    const target = join(directory, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.text, 'utf8');
  }
}

const USAGE =
  'usage: npm run generate-library -- <empty directory> [--seed <n>] [--notes <n>] [--mib <n>]\n' +
  `defaults: --seed ${DEFAULT_SEED} --notes ${DEFAULT_NOTES} --mib ${DEFAULT_MIB}`;

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: 'string', default: String(DEFAULT_SEED) },
      notes: { type: 'string', default: String(DEFAULT_NOTES) },
      mib: { type: 'string', default: String(DEFAULT_MIB) },
    },
  });
  if (positionals.length !== 1) throw new Error('give exactly one directory');

  const library = generateLibrary({
    seed: Number(values.seed),
    notes: Number(values.notes),
    totalBytes: Number(values.mib) * MIB,
  });
  writeLibrary(library, positionals[0]);

  const { summary } = library;
  console.log(`Wrote ${summary.notes} notes to ${positionals[0]}`);
  console.log(`Size: ${summary.bytes} bytes (${(summary.bytes / MIB).toFixed(2)} MiB)`);
  console.log(`Nodes: ${summary.nodes}, of which ${summary.headingNodes} are headings`);
  console.log(`Links: ${summary.links}`);
  console.log(`Files with no ID: ${summary.filesWithoutIds.length}`);
  console.log(`Seed: ${values.seed}`);
  console.log(`Library hash: ${summary.hash}`);
}

if (basename(process.argv[1] ?? '') === 'generate-library.ts') {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}
