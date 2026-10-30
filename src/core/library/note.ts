// Save orchestration: opening a note, saving an edit, and creating new files (Decision 4). Nothing
// here holds the user's text, so a result that isn't a save hands the edit back for the editor to
// keep.

import { alternateFileName, editableTitle, scan, spliceBody, spliceTitle } from '../org';
import type { NewNote } from '../org';
import type { Clock, FileStore, FileStoreFailure } from '../ports';

import { baseName, foldName, isSameOrInside, joinPath, parentOf } from './paths';
import { describeFailure, nameTakenProblem, type LibraryAction, type LibraryProblem } from './problems';
import { decodeUtf8, encodeUtf8 } from './utf8';

/** Decision 7. Larger files stay readable. */
export const MAX_EDITABLE_BYTES = 512 * 1024;

const MAX_NAME_ATTEMPTS = 100;

export type NotEditableReason = 'invalid_utf8' | 'read_only_location' | 'too_large';

const NOT_EDITABLE_MESSAGE: Record<NotEditableReason, string> = {
  invalid_utf8: 'This file isn’t valid UTF-8, so Roamlet can’t edit it. It has been left unchanged.',
  read_only_location: 'This location can’t be written to, so editing is unavailable.',
  too_large: 'This file is too large to edit in Roamlet. You can still read it.',
};

interface NoteContent {
  path: string;
  /** The file as read. */
  bytes: Uint8Array;
  /** The digest `bytes` were read under. A save succeeds only if the file still has it. */
  hash: string;
}

export interface EditableNote extends NoteContent {
  editable: true;
  text: string;
}

export interface ReadOnlyNote extends NoteContent {
  editable: false;
  reason: NotEditableReason;
  message: string;
  /** Null for invalid UTF-8: such bytes are never decoded. */
  text: string | null;
}

export type Note = EditableNote | ReadOnlyNote;

export type OpenResult = { status: 'opened'; note: Note } | { status: 'failed'; problem: LibraryProblem };

export interface OpenOptions {
  /** False when the location refuses writes. Defaults to true. */
  writable?: boolean;
}

/** What the editor changed. An absent field is left as it is in the file. */
export interface NoteEdit {
  title?: string;
  /** The edited form of `editableBody`. */
  body?: string;
}

export type SaveResult =
  | { status: 'saved'; note: EditableNote }
  /** Nothing differed, so the file was not touched. */
  | { status: 'unchanged'; note: EditableNote }
  /** The file changed after editing began and was left alone. Reload it or save a conflict copy. */
  | { status: 'stale'; edit: NoteEdit; currentHash: string }
  | { status: 'failed'; edit: NoteEdit; problem: LibraryProblem }
  | { status: 'not_editable'; edit: NoteEdit; reason: NotEditableReason; message: string };

export type CreateFileResult =
  | { status: 'created'; path: string }
  | { status: 'failed'; problem: LibraryProblem };

/** Reads a note for the reader or the editor. Reloading after a stale edit is opening it again. */
export async function openNote(
  store: FileStore,
  path: string,
  options: OpenOptions = {},
): Promise<OpenResult> {
  // In this order, a change between the two calls makes the hash older than the bytes, and the save
  // reports a stale edit. The other order would pair old text with the new hash and overwrite.
  const digest = await store.digest(path);
  if (!digest.ok) return { status: 'failed', problem: describeFailure(digest.failure, 'open') };
  const read = await store.readBytes(path);
  if (!read.ok) return { status: 'failed', problem: describeFailure(read.failure, 'open') };

  const content = { path, bytes: read.bytes, hash: digest.hash };
  const text = decodeUtf8(read.bytes);
  if (text === null) return { status: 'opened', note: readOnly(content, 'invalid_utf8', null) };
  if (options.writable === false) {
    return { status: 'opened', note: readOnly(content, 'read_only_location', text) };
  }
  if (read.bytes.length > MAX_EDITABLE_BYTES) {
    return { status: 'opened', note: readOnly(content, 'too_large', text) };
  }
  return { status: 'opened', note: { ...content, editable: true, text } };
}

function readOnly(
  content: NoteContent,
  reason: NotEditableReason,
  text: string | null,
): ReadOnlyNote {
  return { ...content, editable: false, reason, message: NOT_EDITABLE_MESSAGE[reason], text };
}

/** Applies an edit to the file's text. Every byte outside the edited ranges is kept (Decision 1). */
export function applyEdit(text: string, edit: NoteEdit): string {
  const doc = scan(text);
  // The body goes first, since the editor's body came from this exact scan.
  let next = edit.body === undefined ? text : spliceBody(text, doc, edit.body).text;
  if (edit.title !== undefined && edit.title !== editableTitle(doc)) {
    next = spliceTitle(next, scan(next), edit.title).text;
  }
  return next;
}

export async function saveNote(store: FileStore, note: Note, edit: NoteEdit): Promise<SaveResult> {
  if (!note.editable) {
    return { status: 'not_editable', edit, reason: note.reason, message: note.message };
  }
  const text = applyEdit(note.text, edit);
  if (text === note.text) return { status: 'unchanged', note };

  const bytes = encodeUtf8(text);
  const result = await store.replaceFile(note.path, bytes, note.hash);
  if (result.status === 'replaced') {
    return { status: 'saved', note: { ...note, bytes, hash: result.hash, text } };
  }
  if (result.status === 'failed') {
    return { status: 'failed', edit, problem: describeFailure(result.failure, 'save') };
  }
  // A save reported as failed may have landed anyway (Decision 4), and retrying it finds the file
  // already holding these bytes. That is a save, not somebody else's change.
  const current = await store.readBytes(note.path);
  if (current.ok && sameBytes(current.bytes, bytes)) {
    return { status: 'saved', note: { ...note, bytes, hash: result.currentHash, text } };
  }
  return { status: 'stale', edit, currentHash: result.currentHash };
}

/**
 * Saves the user's text beside the note under a name that doesn't end in `.org`, such as
 * `note.org.conflict-20260115093000`. The note itself is not touched.
 */
export async function saveConflictCopy(
  store: FileStore,
  clock: Clock,
  note: EditableNote,
  edit: NoteEdit,
): Promise<CreateFileResult> {
  const name = `${baseName(note.path)}.conflict-${timestamp(clock.now())}`;
  return createWithFreeName(
    store,
    parentOf(note.path),
    (attempt) => (attempt === 0 ? name : `${name}-${attempt + 1}`),
    encodeUtf8(applyEdit(note.text, edit)),
    'conflict_copy',
  );
}

/** Creates a captured note in the library root, never over an existing file. */
export async function createNote(store: FileStore, note: NewNote): Promise<CreateFileResult> {
  return createWithFreeName(
    store,
    '',
    (attempt) => (attempt === 0 ? note.fileName : alternateFileName(note.fileName, attempt)),
    encodeUtf8(note.content),
    'create',
  );
}

/**
 * The store only guarantees that an exact name is free. Names are also compared normalized and
 * case-folded here, so a new file can't clash once synced to a filesystem that ignores those
 * differences. If the folder can't be listed, that can't be checked and nothing is written.
 */
async function createWithFreeName(
  store: FileStore,
  directory: string,
  candidate: (attempt: number) => string,
  bytes: Uint8Array,
  action: LibraryAction,
): Promise<CreateFileResult> {
  const fail = (failure: FileStoreFailure): CreateFileResult => ({
    status: 'failed',
    problem: describeFailure(failure, action),
  });

  const listing = await store.list();
  const unlisted = listing.failures.find((failed) => isSameOrInside(directory, failed.path));
  if (unlisted) return fail(unlisted.failure);
  const taken = new Set(
    listing.entries
      .filter((entry) => parentOf(entry.path) === directory)
      .map((entry) => foldName(entry.name)),
  );

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const name = candidate(attempt);
    if (taken.has(foldName(name))) continue;
    const path = joinPath(directory, name);
    const result = await store.createExclusive(path, bytes);
    if (result.status === 'failed') return fail(result.failure);
    if (result.status === 'created') {
      if (result.path === path) return { status: 'created', path };
      return fail({ kind: 'name_changed', message: `Provider stored ${path} as ${result.path}` });
    }
    // Hidden from the listing, or created since it ran.
    taken.add(foldName(name));
  }
  return { status: 'failed', problem: nameTakenProblem(action, MAX_NAME_ATTEMPTS) };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `%Y%m%d%H%M%S` in local time, matching new note file names. */
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
