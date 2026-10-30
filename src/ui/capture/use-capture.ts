import { useEffect, useRef, useState } from 'react';

import { createNote, whyNotWritable, type CreateFileResult } from '../../core/library';
import { parseCapture, renderNewNote } from '../../core/org';
import { CAPTURE_DRAFT_PATH, useDraftFailed, useDraftStore, type DraftKey } from '../drafts';
import { useLibrary } from '../library-context';

export const DRAFT_UNREADABLE_MESSAGE =
  'Roamlet couldn’t read your saved draft, and it hasn’t been changed.';
const DRAFT_NOT_KEPT_MESSAGE =
  'This text couldn’t be kept as a draft, so it could be lost if the app closes. Saving it as a note still works.';
const SAVE_BROKE_MESSAGE = 'This note wasn’t saved, and your text is still here. Try again.';

/** The Capture screen's state: one draft per library, kept across kills until it becomes a note. */
export interface Capture {
  /** False until the active library's draft is restored. The text can't be edited until then. */
  ready: boolean;
  text: string;
  /** Records the text as a draft. */
  setText: (text: string) => void;
  /** Whether Save would do anything now. */
  canSave: boolean;
  saving: boolean;
  /** Creates the note and clears the text. If that fails, the text stays and `problem` explains. */
  save: () => Promise<void>;
  /** Clears the text and its draft. Confirm with the user first. */
  discard: () => Promise<void>;
  /** Why saving isn't possible now, such as a read-only folder. The text stays a draft meanwhile. */
  notWritableReason: string | null;
  /** Why the last save failed, or why the draft can't be relied on. */
  problem: string | null;
  /** The saved draft couldn't be read, and `retryRestore` can try again. */
  restoreFailed: boolean;
  retryRestore: () => void;
  /** The title of the note just saved, until the text changes. */
  savedTitle: string | null;
}

export function useCapture(): Capture {
  const { state, store, ids, clock, refresh, recheckAccess, failure } = useLibrary();
  const drafts = useDraftStore();
  const libraryId = state.status === 'starting' ? null : state.libraryId;
  const key: DraftKey | null = libraryId === null ? null : { libraryId, path: CAPTURE_DRAFT_PATH };

  // Tagged with their library, so a switch can't show or save one library's text in another.
  const [draft, setDraft] = useState<{ libraryId: string; text: string } | null>(null);
  const [restoreFailedFor, setRestoreFailedFor] = useState<string | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);
  const savingNow = useRef(false);

  useEffect(() => {
    if (libraryId === null) return;
    let current = true;
    void drafts.read({ libraryId, path: CAPTURE_DRAFT_PATH }).then((result) => {
      if (!current) return;
      if (result.ok) {
        setDraft({ libraryId, text: result.text ?? '' });
        setRestoreFailedFor(null);
      } else {
        // Starting empty would let the next keystroke overwrite the draft that couldn't be read.
        setRestoreFailedFor(libraryId);
      }
    });
    return () => {
      current = false;
    };
  }, [drafts, libraryId, restoreAttempt]);

  const ready = libraryId !== null && draft?.libraryId === libraryId;
  const text = ready ? draft.text : '';
  const draftFailed = useDraftFailed(key);

  const setText = (next: string) => {
    if (!ready) return;
    setDraft({ libraryId, text: next });
    setSaveProblem(null);
    setSavedTitle(null);
    if (next === '') void drafts.discard({ libraryId, path: CAPTURE_DRAFT_PATH });
    else drafts.update({ libraryId, path: CAPTURE_DRAFT_PATH }, next);
  };

  const notWritableReason =
    failure?.stage === 'startup'
      ? failure.message
      : state.status === 'starting'
        ? null
        : whyNotWritable(state);

  const canSave =
    ready && !saving && store !== null && notWritableReason === null && parseCapture(text) !== null;

  const save = async () => {
    if (!canSave || savingNow.current) return;
    const note = renderNewNote(text, ids, clock);
    if (!note) return;

    savingNow.current = true;
    setSaving(true);
    setSaveProblem(null);
    let result: CreateFileResult | null;
    try {
      result = await createNote(store, note);
    } catch {
      result = null;
    }

    if (result?.status === 'created') {
      const saved = libraryId;
      setDraft((previous) =>
        previous?.libraryId === saved ? { libraryId: saved, text: '' } : previous,
      );
      setSavedTitle(note.title);
      // If the app dies before this lands, the text comes back: a repeat, but nothing lost.
      await drafts.discard({ libraryId: saved, path: CAPTURE_DRAFT_PATH });
      // Runs behind the screen, so the next note can be started while the index catches up.
      void refresh();
    } else {
      setSaveProblem(result?.status === 'failed' ? result.problem.message : SAVE_BROKE_MESSAGE);
      if (result?.status === 'failed' && result.problem.accessMayBeLost) void recheckAccess();
    }
    savingNow.current = false;
    setSaving(false);
  };

  const discard = async () => {
    if (!ready) return;
    setDraft({ libraryId, text: '' });
    setSaveProblem(null);
    setSavedTitle(null);
    await drafts.discard({ libraryId, path: CAPTURE_DRAFT_PATH });
  };

  return {
    ready,
    text,
    setText,
    canSave,
    saving,
    save,
    discard,
    notWritableReason,
    problem: saveProblem ?? (draftFailed ? DRAFT_NOT_KEPT_MESSAGE : null),
    restoreFailed: libraryId !== null && restoreFailedFor === libraryId && !ready,
    retryRestore: () => setRestoreAttempt((attempt) => attempt + 1),
    savedTitle,
  };
}
