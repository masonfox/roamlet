import type { Span } from './types';

/**
 * A description ends at the first `]]`, and has no escape syntax. A zero-width space keeps brackets
 * apart, which is also how Org itself writes such a description, so the title reads the same.
 */
const ZERO_WIDTH_SPACE = '​';

/** `[[id:UUID][Title]]`, well formed whatever the title holds. */
export function linkText(id: string, title: string): string {
  const description = title
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .replace(/\](?=\]|$)/g, `]${ZERO_WIDTH_SPACE}`);
  const target = `[id:${escapeTarget(id)}]`;
  return description === '' ? `[${target}]` : `[${target}[${description}]]`;
}

/** Inserts a link in the editor's text at the cursor, replacing any selected text. */
export function insertLink(
  buffer: string,
  selection: Span,
  id: string,
  title: string,
): { text: string; cursor: number } {
  const link = linkText(id, title);
  return {
    text: buffer.slice(0, selection.start) + link + buffer.slice(selection.end),
    cursor: selection.start + link.length,
  };
}

/** In a target, brackets are escaped with a backslash, as are backslashes before them or at the end. */
function escapeTarget(target: string): string {
  return target.replace(
    /(\\*)([[\]]|$)/g,
    (_, slashes: string, bracket: string) => slashes + slashes + (bracket && `\\${bracket}`),
  );
}
