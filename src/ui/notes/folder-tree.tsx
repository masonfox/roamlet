import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { FlatList } from 'react-native';

import type { FolderEntry, FolderListing, IndexedFile } from '../../core/index';
import { ListRow } from './controls';
import { rowLabel, statusMarks } from './file-marks';
import { readerHref } from './routes';
import { useIndexQuery } from './use-index-query';

type TreeRow =
  | { kind: 'folder'; folder: FolderEntry; depth: number; expanded: boolean }
  | { kind: 'file'; file: IndexedFile; depth: number };

function flatten(
  listings: Map<string, FolderListing>,
  expanded: ReadonlySet<string>,
  path: string,
  depth: number,
  rows: TreeRow[],
): void {
  const listing = listings.get(path);
  if (!listing) return;
  for (const folder of listing.folders) {
    const open = expanded.has(folder.path);
    rows.push({ kind: 'folder', folder, depth, expanded: open });
    if (open) flatten(listings, expanded, folder.path, depth + 1, rows);
  }
  for (const file of listing.files) rows.push({ kind: 'file', file, depth });
}

function fileMarks(file: IndexedFile): string[] {
  const marks = statusMarks(file.status);
  if (file.contentIndexed && !file.hasNodes) marks.push('No ID');
  return marks;
}

/**
 * The library's folders and `.org` files from the index, so browsing never waits on a listing.
 * Folders open in place. `empty` shows when the root has nothing.
 */
export function FolderTree({ empty }: { empty?: ReactElement }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const { data: listings } = useIndexQuery(
    async (index) => {
      const paths = ['', ...expanded];
      const results = await Promise.all(paths.map((path) => index.listFolder(path)));
      return new Map(paths.map((path, i) => [path, results[i]]));
    },
    [expanded],
  );

  const rows = useMemo(() => {
    const next: TreeRow[] = [];
    if (listings) flatten(listings, expanded, '', 0, next);
    return next;
  }, [listings, expanded]);

  const toggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);

  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => (row.kind === 'folder' ? `d:${row.folder.path}` : `f:${row.file.path}`)}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={listings ? empty : undefined}
      renderItem={({ item }) => {
        if (item.kind === 'folder') {
          const { folder, depth, expanded: open } = item;
          return (
            <ListRow
              title={`${open ? '▾' : '▸'} ${folder.name}`}
              accessibilityLabel={`Folder ${folder.name}`}
              accessibilityState={{ expanded: open }}
              indent={depth}
              onPress={() => toggle(folder.path)}
            />
          );
        }
        const { file, depth } = item;
        const marks = fileMarks(file);
        return (
          <ListRow
            title={file.title}
            details={[file.name]}
            marks={marks}
            accessibilityLabel={rowLabel([`Note ${file.title}`, file.name, ...marks])}
            indent={depth}
            onPress={() => router.push(readerHref(file.path))}
          />
        );
      }}
    />
  );
}
