import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyEdit,
  openNote,
  saveConflictCopy,
  saveNote,
  whyNotWritable,
  type EditableNote,
  type NoteEdit,
  type SaveResult,
} from '../../core/library';
import {
  checkIdChanges,
  editableBody,
  editableTitle,
  normalizeLineEndings,
  scan,
  type IdWarning,
} from '../../core/org';
import { useDraftFailed, useDraftStore, type DraftKey } from '../drafts';
import { useLibrary } from '../library-context';

const DRAFT_VERSION = 1;
const DRAFT_UNREADABLE_MESSAGE = 'Roamlet couldn’t read your saved draft, and it hasn’t been changed.';
const DRAFT_NOT_KEPT_MESSAGE =
  'This text couldn’t be kept as a draft, so it could be lost if the app closes. Saving it still works.';
const SAVE_BROKE_MESSAGE = 'Your changes weren’t saved, and your text is still here. Try again.';
const OTHER_LIBRARY_MESSAGE =
  'This note is in a library that’s no longer active. Switch back to it in Settings to save.';

/** The title and body as they stand in the file, which the editor's text is compared against. */
interface Session {
  libraryId: string;
  note: EditableNote;
  title: string;
  body: string;
  /** The file version the text was edited from, kept in the draft. See `EditDraft.baseHash`. */
  baseHash: string;
}

/**
 * Saved under the note's draft key. `baseHash` is the file version the text was edited from. It stays
 * that version through further typing, or a stale draft would pass as current after the next restart.
 */
interface EditDraft {
  version: number;
  title: string;
  body: string;
  baseHash: string;
}

export type EditorLoad =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'read_only'; message: string }
  | { status: 'draft_unreadable'; message: string };

export interface NoteEditor {
  /** Whether the note is open for editing. If not, `load` says why. */
  editing: boolean;
  load: EditorLoad;
  /** Why the note can't even be read now, such as lost folder access. */
  unavailableMessage: string | null;
  retry: () => void;
  title: string;
  body: string;
  setTitle: (title: string) => void;
  setBody: (body: string) => void;
  /** The text differs from the file. */
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  /** Checks IDs, then saves. With warnings to confirm, `idWarnings` is set instead. */
  save: () => Promise<void>;
  /** What the pending save would do to IDs, or null when none is waiting for confirmation. */
  idWarnings: IdWarning[] | null;
  confirmSave: () => Promise<void>;
  cancelSave: () => void;
  /** The file changed since editing began: reload it or save a conflict copy. Saving is blocked. */
  stale: boolean;
  /** Replaces the text with the current file. Confirm with the user first. */
  reload: () => Promise<void>;
  saveCopy: () => Promise<void>;
  /** Puts the text back to the file's and removes the draft. Confirm with the user first. */
  discard: () => Promise<void>;
  /** Why saving isn't possible right now. The text stays a draft meanwhile. */
  notWritableReason: string | null;
  /** Why the last action failed, or why the draft can't be relied on. */
  problem: string | null;
  /** The outcome of the last action. */
  status: string | null;
}

function encodeDraft(title: string, body: string, baseHash: string): string {
  const draft: EditDraft = { version: DRAFT_VERSION, title, body, baseHash };
  return JSON.stringify(draft);
}

/** Null when there is no draft this version can use. */
function decodeDraft(text: string | null): EditDraft | null {
  if (text === null) return null;
  try {
    const draft = JSON.parse(text);
    const usable =
      draft?.version === DRAFT_VERSION &&
      typeof draft.title === 'string' &&
      typeof draft.body === 'string' &&
      typeof draft.baseHash === 'string';
    return usable ? draft : null;
  } catch {
    return null;
  }
}

function sessionOf(libraryId: string, note: EditableNote): Session {
  const doc = scan(note.text);
  return {
    libraryId,
    note,
    title: editableTitle(doc),
    body: editableBody(note.text, doc),
    baseHash: note.hash,
  };
}

/**
 * One note's edit: plain text over a file, saved only when asked (Decision 7). It stays open through
 * losing access or switching library, with the text kept, because nothing here can write without
 * the store for the library it was opened from.
 */
export function useNoteEditor(path: string): NoteEditor {
  const { state, store, index, clock, refresh, recheckAccess, failure } = useLibrary();
  const drafts = useDraftStore();
  const libraryId = state.status === 'starting' ? null : state.libraryId;
  const writable = state.status === 'available' ? state.writable : true;

  const [session, setSession] = useState<Session | null>(null);
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [title, setTitleState] = useState('');
  const [body, setBodyState] = useState('');
  const [saving, setSaving] = useState(false);
  const [idWarnings, setIdWarnings] = useState<IdWarning[] | null>(null);
  const [stale, setStale] = useState(false);
  const [actionProblem, setActionProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const busy = useRef(false);

  const key: DraftKey | null = session ? { libraryId: session.libraryId, path } : null;
  const draftFailed = useDraftFailed(key);
  const open = session !== null;

  useEffect(() => {
    if (open || !store || libraryId === null) return;
    let current = true;
    void (async () => {
      const opened = await openNote(store, path, { writable });
      if (!current) return;
      if (opened.status === 'failed') {
        setLoad({ status: 'failed', message: opened.problem.message });
        if (opened.problem.kind === 'not_downloaded') void store.requestDownload([path]);
        if (opened.problem.accessMayBeLost) void recheckAccess();
        return;
      }
      if (!opened.note.editable) {
        setLoad({ status: 'read_only', message: opened.note.message });
        return;
      }
      const saved = await drafts.read({ libraryId, path });
      if (!current) return;
      if (!saved.ok) {
        // Opening clean would let the next keystroke overwrite the draft that couldn't be read.
        setLoad({ status: 'draft_unreadable', message: DRAFT_UNREADABLE_MESSAGE });
        return;
      }
      const next = sessionOf(libraryId, opened.note);
      const draft = decodeDraft(saved.text);
      const differs =
        draft !== null &&
        (draft.title !== next.title || normalizeLineEndings(draft.body) !== next.body);
      setSession(differs ? { ...next, baseHash: draft.baseHash } : next);
      setTitleState(differs ? draft.title : next.title);
      setBodyState(differs ? draft.body : next.body);
      // The draft was edited from another version of the file. Saving it would undo that change.
      setStale(differs && draft.baseHash !== opened.note.hash);
      if (draft !== null && !differs) void drafts.discard({ libraryId, path });
    })();
    return () => {
      current = false;
    };
  }, [open, store, libraryId, writable, path, attempt, drafts, recheckAccess]);

  const dirty =
    session !== null && (title !== session.title || normalizeLineEndings(body) !== session.body);

  const edited = (nextTitle: string, nextBody: string) => {
    if (!session || !key) return;
    setIdWarnings(null);
    setActionProblem(null);
    setStatus(null);
    const unchanged =
      nextTitle === session.title && normalizeLineEndings(nextBody) === session.body;
    if (unchanged) void drafts.discard(key);
    else drafts.update(key, encodeDraft(nextTitle, nextBody, session.baseHash));
  };

  const setTitle = (next: string) => {
    setTitleState(next);
    edited(next, body);
  };

  const setBody = (next: string) => {
    setBodyState(next);
    edited(title, next);
  };

  const inThisLibrary = session !== null && session.libraryId === libraryId;
  // Against the library the note came from, which `store` only is while `inThisLibrary`.
  const writeStore = inThisLibrary ? store : null;

  let notWritableReason: string | null = null;
  if (session && !inThisLibrary) notWritableReason = OTHER_LIBRARY_MESSAGE;
  else if (failure?.stage === 'startup') notWritableReason = failure.message;
  else if (state.status !== 'starting') notWritableReason = whyNotWritable(state);

  const canSave = session !== null && writeStore !== null && notWritableReason === null && !saving && !stale;

  const showSession = (next: Session) => {
    setSession(next);
    setTitleState(next.title);
    setBodyState(next.body);
    setStale(false);
    setIdWarnings(null);
  };

  /** Runs one action at a time, so a double tap can't save twice. */
  const exclusively = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setActionProblem(null);
    setStatus(null);
    try {
      await work();
    } catch {
      setActionProblem(SAVE_BROKE_MESSAGE);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const finishSave = async (result: SaveResult, current: Session) => {
    switch (result.status) {
      case 'saved':
        showSession(sessionOf(current.libraryId, result.note));
        setStatus('Saved.');
        await drafts.discard({ libraryId: current.libraryId, path });
        // Runs behind the screen. If the app dies first, the next reconcile repairs the index.
        void refresh();
        return;
      case 'unchanged':
        // A title differing only in surrounding space is no change, so it goes back as well.
        showSession(current);
        setStatus('No changes to save.');
        await drafts.discard({ libraryId: current.libraryId, path });
        return;
      case 'stale':
        setStale(true);
        return;
      case 'failed':
        setActionProblem(result.problem.message);
        if (result.problem.accessMayBeLost) void recheckAccess();
        return;
      case 'not_editable':
        setActionProblem(result.message);
    }
  };

  const write = async (current: Session, edit: NoteEdit) => {
    if (!writeStore) return;
    await finishSave(await saveNote(writeStore, current.note, edit), current);
  };

  /** IDs the rest of the library uses, of those this edit brought in. */
  const idsElsewhere = async (ids: string[]): Promise<Set<string>> => {
    const elsewhere = new Set<string>();
    if (!index) return elsewhere;
    for (const id of ids) {
      const found = await index.resolveLink(id).catch(() => null);
      if (found && found.filePath !== path) elsewhere.add(id);
    }
    return elsewhere;
  };

  const save = () =>
    exclusively(async () => {
      if (!session || !canSave) return;
      const edit: NoteEdit = { title, body };
      const before = scan(session.note.text);
      const after = scan(applyEdit(session.note.text, edit));
      const known = new Set(before.nodes.map((node) => node.id));
      const added = after.nodes.map((node) => node.id).filter((id) => !known.has(id));
      const warnings = checkIdChanges(before, after, await idsElsewhere(added));
      if (warnings.length > 0) {
        setIdWarnings(warnings);
        return;
      }
      await write(session, edit);
    });

  const confirmSave = () =>
    exclusively(async () => {
      if (!session || !canSave) return;
      setIdWarnings(null);
      await write(session, { title, body });
    });

  const cancelSave = () => setIdWarnings(null);

  /** The file as it is now, in place of the text, which the caller has dealt with. */
  const reopen = async (current: Session): Promise<boolean> => {
    if (!writeStore) return false;
    const opened = await openNote(writeStore, path, { writable });
    if (opened.status === 'failed') {
      setActionProblem(opened.problem.message);
      return false;
    }
    if (!opened.note.editable) {
      setActionProblem(opened.note.message);
      return false;
    }
    showSession(sessionOf(current.libraryId, opened.note));
    await drafts.discard({ libraryId: current.libraryId, path });
    return true;
  };

  const reload = () =>
    exclusively(async () => {
      if (!session) return;
      if (await reopen(session)) setStatus('Reloaded from the file.');
    });

  const saveCopy = () =>
    exclusively(async () => {
      if (!session || !writeStore) return;
      const made = await saveConflictCopy(writeStore, clock, session.note, { title, body });
      if (made.status === 'failed') {
        setActionProblem(made.problem.message);
        if (made.problem.accessMayBeLost) void recheckAccess();
        return;
      }
      void refresh();
      // Keeps the text on screen if the file can't be read now. The copy already holds it.
      const reopened = await reopen(session);
      setStatus(
        reopened
          ? `Your text was saved as ${made.path}, and the note was left unchanged. This is the current file.`
          : `Your text was saved as ${made.path}, and the note was left unchanged.`,
      );
    });

  const discard = async () => {
    if (!session) return;
    setTitleState(session.title);
    setBodyState(session.body);
    setStale(false);
    setIdWarnings(null);
    await drafts.discard({ libraryId: session.libraryId, path });
  };

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  let unavailableMessage: string | null = null;
  if (!session && !store) {
    if (failure?.stage === 'startup') unavailableMessage = failure.message;
    // Still opening is not worth a message, and is over in a moment.
    else if (state.status === 'unavailable') unavailableMessage = state.message;
  }

  return {
    editing: session !== null,
    load,
    unavailableMessage,
    retry,
    title,
    body,
    setTitle,
    setBody,
    dirty,
    canSave,
    saving,
    save,
    idWarnings,
    confirmSave,
    cancelSave,
    stale,
    reload,
    saveCopy,
    discard,
    notWritableReason,
    problem: actionProblem ?? (draftFailed ? DRAFT_NOT_KEPT_MESSAGE : null),
    status,
  };
}
