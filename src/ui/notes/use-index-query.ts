import { useEffect, useState, type DependencyList } from 'react';

import type { LibraryIndex } from '../../core/index';
import { useLibrary } from '../library-context';

export interface IndexQueryResult<T> {
  /** The latest answer for this index, kept while a newer one loads. Null until there is one. */
  data: T | null;
  /** True when the latest query was rejected, as when the database is being replaced. */
  failed: boolean;
}

/**
 * Runs a query against the active index, and again whenever indexed data may have changed. `deps`
 * lists what `query` reads besides the index. An answer from an earlier run is ignored, so a slow
 * query can't overwrite a newer one.
 */
export function useIndexQuery<T>(
  query: (index: LibraryIndex) => Promise<T>,
  deps: DependencyList,
): IndexQueryResult<T> {
  const { index, revision } = useLibrary();
  const [result, setResult] = useState<{ index: LibraryIndex; data: T | null; failed: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!index) return;
    let current = true;
    query(index).then(
      (data) => {
        if (current) setResult({ index, data, failed: false });
      },
      () => {
        if (current) setResult((previous) => ({ index, data: previous?.data ?? null, failed: true }));
      },
    );
    return () => {
      current = false;
    };
    // `query` is rebuilt every render, and what it reads is in `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, revision, ...deps]);

  // An answer from another library's index must not show under this one.
  if (!index || result?.index !== index) return { data: null, failed: false };
  return { data: result.data, failed: result.failed };
}
