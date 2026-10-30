import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';

import { useLibrary } from '../library-context';
import { useTheme } from '../theme';
import { Notice, TextButton } from './controls';
import { FolderTree } from './folder-tree';
import { ReconnectNotice } from './reconnect-notice';
import { SearchResults } from './search-results';

function EmptyLibrary() {
  const theme = useTheme();
  const router = useRouter();
  return (
    <View style={{ padding: theme.spacing.lg }}>
      <Text style={[theme.type.body, { color: theme.colors.text }]}>
        No notes yet. Capture a note to start one here, or open a folder of Org files you already
        have.
      </Text>
      <TextButton label="Capture a note" onPress={() => router.navigate('/capture')} />
      <TextButton label="Open a folder in Settings" onPress={() => router.navigate('/settings')} />
    </View>
  );
}

function StatusNotices() {
  const { state, failure, lastResult, index } = useLibrary();
  if (state.status === 'unavailable') {
    return (
      <ReconnectNotice
        message={`${state.message} Notes already indexed stay searchable, but files can’t be opened until access returns.`}
      />
    );
  }
  if (failure) return <Notice message={failure.message} />;
  if (state.status === 'starting' || !index) return <Notice message="Opening your library…" />;
  if (lastResult && lastResult.listing !== 'complete') {
    return (
      <Notice message="Some folders couldn’t be read just now, so what’s shown may be out of date. Nothing was changed." />
    );
  }
  return null;
}

function SearchField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <TextInput
        accessibilityLabel="Search notes"
        placeholder="Search notes"
        placeholderTextColor={theme.colors.textMuted}
        value={value}
        onChangeText={onChange}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[
          theme.type.body,
          { flex: 1, minHeight: 44, color: theme.colors.text, paddingVertical: theme.spacing.sm },
        ]}
      />
      {value !== '' ? (
        <TextButton label="Clear" accessibilityLabel="Clear search" onPress={() => onChange('')} />
      ) : null}
    </View>
  );
}

export function NotesScreen() {
  const { state, index, refreshing, progress, lastResult } = useLibrary();
  const [query, setQuery] = useState('');
  const theme = useTheme();
  const searching = query.trim() !== '';

  // Until the first run ends, an empty index only means nothing has been read yet.
  const indexing =
    state.status === 'available' && (refreshing || !lastResult) ? (
      <View style={{ padding: theme.spacing.lg }}>
        <Text
          accessibilityLiveRegion="polite"
          style={[theme.type.body, { color: theme.colors.textMuted }]}
        >
          {progress ? `Indexing notes: ${progress.processed} of ${progress.total}` : 'Looking for notes…'}
        </Text>
      </View>
    ) : null;

  // When the library is unavailable, its notice already says why there is nothing to show.
  const emptyTree = state.status === 'unavailable' ? undefined : (indexing ?? <EmptyLibrary />);

  return (
    <View style={{ flex: 1 }}>
      <SearchField value={query} onChange={setQuery} />
      <StatusNotices />
      {!index ? null : searching ? (
        <SearchResults query={query} />
      ) : (
        <FolderTree empty={emptyTree} />
      )}
    </View>
  );
}
