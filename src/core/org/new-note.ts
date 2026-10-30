import type { Clock, IdGenerator } from '../ports';

import { slugify } from './slug';
import { normalizeLineEndings } from './splice';

const MAX_TITLE_LENGTH = 80;

export interface CapturedNote {
  title: string;
  /** Empty when the capture was one short line. */
  body: string;
}

export interface NewNote {
  id: string;
  title: string;
  /** A file name for the library root. See `alternateFileName` if it is taken. */
  fileName: string;
  /** The whole file: LF line endings and a trailing newline. */
  content: string;
}

/** Splits captured text into title and body. Null means there is nothing to save. */
export function parseCapture(text: string): CapturedNote | null {
  const normalized = normalizeLineEndings(text);
  if (normalized.trim() === '') return null;
  // Blank lines before the first line of text, including those with only whitespace.
  const firstLine = normalized.replace(/^(?:\s*\n)+/, '');
  const newline = firstLine.indexOf('\n');
  const line = (newline === -1 ? firstLine : firstLine.slice(0, newline)).trim();
  const title = shortenTitle(line);
  if (title !== line) return { title, body: firstLine.trimEnd() };
  const rest = newline === -1 ? '' : firstLine.slice(newline + 1);
  return { title, body: rest.replace(/^(?:\s*\n)+/, '').trimEnd() };
}

/** Renders a new file in Org-roam's default form (Decision 7). Null for an empty capture. */
export function renderNewNote(text: string, ids: IdGenerator, clock: Clock): NewNote | null {
  const capture = parseCapture(text);
  if (!capture) return null;
  const { title, body } = capture;
  const id = ids.newId();
  const header = `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n`;
  return {
    id,
    title,
    fileName: `${timestamp(clock.now())}-${slugify(title)}.org`,
    content: body === '' ? header : `${header}\n${body}\n`,
  };
}

/** The file name to try after `fileName` was taken. `attempt` counts from 1. */
export function alternateFileName(fileName: string, attempt: number): string {
  return `${fileName.slice(0, -'.org'.length)}_${attempt + 1}.org`;
}

/** Cuts at the last word boundary within the limit, or at the limit if a word is longer. */
function shortenTitle(line: string): string {
  const points = Array.from(line);
  if (points.length <= MAX_TITLE_LENGTH) return line;
  let cut = MAX_TITLE_LENGTH;
  while (cut > 0 && !/\s/.test(points[cut])) cut--;
  return points
    .slice(0, cut > 0 ? cut : MAX_TITLE_LENGTH)
    .join('')
    .trimEnd();
}

/** `%Y%m%d%H%M%S` in local time, as Org-roam writes it. */
function timestamp(date: Date): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  return (
    pad(date.getFullYear(), 4) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}
