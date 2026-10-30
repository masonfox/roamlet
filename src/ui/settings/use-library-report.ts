import { useEffect, useRef, useState } from 'react';

import type { ConflictCopy, LibraryCounts, LibraryIndex, LibraryProblems } from '../../core/index';
import { useLibrary } from '../library-context';

/** What Settings shows about the indexed library, read together so the numbers agree. */
export interface LibraryReport {
  counts: LibraryCounts;
  notesSize: number;
  problems: LibraryProblems;
  conflictCopies: ConflictCopy[];
}

async function readReport(index: LibraryIndex): Promise<LibraryReport> {
  const [counts, notesSize, problems, conflictCopies] = await Promise.all([
    index.counts(),
    index.notesSize(),
    index.problems(),
    index.conflictCopies(),
  ]);
  return { counts, notesSize, problems, conflictCopies };
}

/**
 * The active library's report, or null until one has been read. Revisions arrive several times a
 * second during a rebuild and problems are the costliest query, so a run only updates this when it
 * ends, except that a newly opened index gets a first report straight away.
 */
export function useLibraryReport(): LibraryReport | null {
  const { index, revision, refreshing } = useLibrary();
  const [loaded, setLoaded] = useState<{ index: LibraryIndex; report: LibraryReport } | null>(null);
  const reported = useRef<LibraryIndex | null>(null);

  useEffect(() => {
    if (!index || (refreshing && reported.current === index)) return;
    reported.current = index;
    let current = true;
    readReport(index).then(
      (report) => {
        if (current) setLoaded({ index, report });
      },
      // Closed by a switch or replaced by a rebuild. The run's end brings a new revision.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [index, revision, refreshing]);

  return loaded && loaded.index === index ? loaded.report : null;
}
