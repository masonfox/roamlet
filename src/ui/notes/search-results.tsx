import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';

import type { SearchResult } from '../../core/index';
import { useTheme } from '../theme';
import { ListRow } from './controls';
import { rowLabel, statusMarks } from './file-marks';
import { readerHref } from './routes';
import { useIndexQuery } from './use-index-query';

// Enough to skip the keystrokes of a word being typed, without feeling late.
const TYPING_PAUSE_MS = 100;

function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), TYPING_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

function resultDetails(result: SearchResult): string[] {
  if (result.level > 0) return [`Heading in ${result.fileTitle}`, result.filePath];
  return [result.filePath];
}

/** Searches the index only, so it works the same with no network connection. */
export function SearchResults({ query }: { query: string }) {
  const theme = useTheme();
  const router = useRouter();
  const settled = useSettled(query);
  const { data, failed } = useIndexQuery((index) => index.search(settled), [settled]);
  // A previous query's results stay on screen until the new ones arrive, so the list doesn't flash.
  const results = data ?? [];

  return (
    <FlatList
      data={results}
      keyExtractor={(result, i) => `${result.filePath}:${result.startOffset}:${i}`}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={
        data || failed ? (
          <View style={{ padding: theme.spacing.lg }}>
            <Text
              accessibilityLiveRegion="polite"
              style={[theme.type.body, { color: theme.colors.textMuted }]}
            >
              {failed
                ? 'Search isn’t available right now. Your notes aren’t affected.'
                : `No notes match “${settled.trim()}”.`}
            </Text>
          </View>
        ) : undefined
      }
      renderItem={({ item }) => {
        const details = resultDetails(item);
        const marks = statusMarks(item.fileStatus);
        return (
          <ListRow
            title={item.title}
            details={details}
            marks={marks}
            accessibilityLabel={rowLabel([item.title, ...details, ...marks])}
            onPress={() => router.push(readerHref(item.filePath, item.nodeId))}
          />
        );
      }}
    />
  );
}
