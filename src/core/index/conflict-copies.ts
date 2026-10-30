// Conflict copies are named `<note>.org.conflict-<suffix>` (note-capture-editing spec, Decision 4).
// They are not notes, so they have no rows in `files`, but diagnostics must still list them.
const CONFLICT_COPY = /^(.+\.org)\.conflict-[^/]+$/;

/** The path of the note a conflict copy was saved from, or null if `path` is not a conflict copy. */
export function conflictCopyNotePath(path: string): string | null {
  // Dot-prefixed names are hidden, and a name ending in `.org` is always a note.
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name.startsWith('.') || path.endsWith('.org')) return null;
  return CONFLICT_COPY.exec(path)?.[1] ?? null;
}
