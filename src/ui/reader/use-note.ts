import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { describeFailure, openNote, type Note, type OpenResult } from '../../core/library';
import { scan, type OrgDocument } from '../../core/org';
import { useLibrary } from '../library-context';
import { buildBlocks, type ReaderBlock } from './blocks';

export type NoteLoad =
  | { status: 'loading' }
  /** `readable` is null for a file that isn't valid UTF-8, which is never decoded. */
  | {
      status: 'opened';
      note: Note;
      readable: { text: string; doc: OrgDocument; blocks: ReaderBlock[] } | null;
    }
  /** No library files can be reached at all. */
  | { status: 'library_unavailable'; message: string }
  | { status: 'failed'; message: string; notDownloaded: boolean };

function parsed(note: Note, path: string) {
  if (note.text === null) return null;
  const doc = scan(note.text, { fileName: path });
  return { text: note.text, doc, blocks: buildBlocks(note.text, doc) };
}

/**
 * Reads the current file, never indexed text, so the reader can't show stale content. It reads again
 * on focus, as after an edit, and after each refresh, as when a sync tool changed the file. A file
 * that didn't change keeps its parsed form, so the list stays where it is.
 */
export function useNote(path: string): { load: NoteLoad; reload: () => void } {
  const { state, store, lastResult, failure, recheckAccess } = useLibrary();
  const writable = state.status === 'available' ? state.writable : true;
  const [loaded, setLoaded] = useState<NoteLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  const lastHash = useRef<string | null>(null);
  const downloadRequested = useRef(false);

  /** What to show now, or null when that is already showing or a newer read has started. */
  const read = useCallback(async (): Promise<NoteLoad | null> => {
    if (!store) return null;
    const run = ++latest.current;
    let result: OpenResult;
    try {
      result = await openNote(store, path, { writable });
    } catch (error) {
      // The stores report failures as results, so this is a bug in a native call.
      result = {
        status: 'failed',
        problem: describeFailure(
          { kind: 'provider_error', message: error instanceof Error ? error.message : String(error) },
          'open',
        ),
      };
    }
    if (run !== latest.current) return null;

    if (result.status === 'opened') {
      const { note } = result;
      if (note.hash === lastHash.current) return null;
      lastHash.current = note.hash;
      return { status: 'opened', note, readable: parsed(note, path) };
    }
    lastHash.current = null;
    const { problem } = result;
    if (problem.kind === 'not_downloaded' && !downloadRequested.current) {
      downloadRequested.current = true;
      store.requestDownload([path]).catch(() => undefined);
    }
    if (problem.accessMayBeLost) void recheckAccess();
    return {
      status: 'failed',
      message: problem.message,
      notDownloaded: problem.kind === 'not_downloaded',
    };
  }, [store, path, writable, recheckAccess]);

  const readAndShow = useCallback(() => {
    void read().then((next) => {
      if (next) setLoaded(next);
    });
  }, [read]);

  useEffect(() => {
    if (store) {
      readAndShow();
    } else {
      // A read still running must not land after the library was lost.
      latest.current += 1;
      lastHash.current = null;
    }
  }, [store, readAndShow, lastResult, attempt]);

  // Focus also comes with the first render, which the effect above has covered.
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focused.current) readAndShow();
      focused.current = true;
    }, [readAndShow]),
  );

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  if (store) return { load: loaded, reload };
  if (state.status === 'unavailable') {
    return { load: { status: 'library_unavailable', message: state.message }, reload };
  }
  if (failure) return { load: { status: 'library_unavailable', message: failure.message }, reload };
  return { load: { status: 'loading' }, reload };
}
