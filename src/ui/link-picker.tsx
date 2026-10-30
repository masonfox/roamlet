import { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';

import { linkText } from '../core/org';
import type { SearchResult } from '../core/index';
import { useLibrary } from './library-context';
import { useTheme } from './theme';

export interface PickedLink {
  /** The node's ID. */
  id: string;
  title: string;
  /** `[[id:UUID][Title]]`, well formed whatever the title holds. */
  linkText: string;
}

interface LinkTarget {
  id: string;
  title: string;
  /** Tells apart nodes with the same title. */
  location: string;
}

const SEARCH_LIMIT = 50;

/** Only nodes can be linked to. A duplicate ID's first result is the one the link resolves to. */
function linkTargets(results: SearchResult[]): LinkTarget[] {
  const targets = new Map<string, LinkTarget>();
  for (const result of results) {
    if (result.nodeId === null || targets.has(result.nodeId)) continue;
    targets.set(result.nodeId, {
      id: result.nodeId,
      title: result.title,
      location: result.level > 0 ? `Heading in ${result.fileTitle}` : result.filePath,
    });
  }
  return [...targets.values()];
}

/**
 * Searches the library for a note or heading to link to. Inserting the result is up to the caller:
 * `insertLink` from the core does so at the cursor. Read the cursor before showing this, since the
 * text field loses focus to the search field.
 */
export function LinkPicker({
  visible,
  onPick,
  onClose,
}: {
  visible: boolean;
  onPick: (link: PickedLink) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      {visible ? <LinkPickerContent onPick={onPick} onClose={onClose} /> : null}
    </Modal>
  );
}

function LinkPickerContent({
  onPick,
  onClose,
}: {
  onPick: (link: PickedLink) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { index, revision } = useLibrary();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; targets: LinkTarget[] } | null>(null);
  const [failedQuery, setFailedQuery] = useState<string | null>(null);

  useEffect(() => {
    if (!index || query.trim() === '') return;
    let current = true;
    index.search(query, { limit: SEARCH_LIMIT }).then(
      (results) => {
        if (!current) return;
        setFound({ query, targets: linkTargets(results) });
        setFailedQuery(null);
      },
      () => {
        if (current) setFailedQuery(query);
      },
    );
    // A later search, or the index being closed, makes this one's answer meaningless.
    return () => {
      current = false;
    };
  }, [index, revision, query]);

  const searching = query.trim() !== '';
  const targets = searching && found?.query === query ? found.targets : null;
  let message: string | null = null;
  if (!index) message = 'Search isn’t available right now.';
  else if (failedQuery === query) message = 'Search didn’t work. Try again in a moment.';
  else if (!searching) message = 'Search for a note or heading to link to.';
  else if (targets?.length === 0) message = 'No notes with an ID match this search.';

  return (
    <View
      accessibilityViewIsModal
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        padding: theme.spacing.lg,
        paddingTop: theme.spacing.xl * 2,
        gap: theme.spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text accessibilityRole="header" style={[theme.type.title, { color: theme.colors.text, flex: 1 }]}>
          Insert link
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close link search"
          hitSlop={theme.spacing.sm}
          onPress={onClose}
        >
          <Text style={[theme.type.body, { color: theme.colors.accent }]}>Close</Text>
        </Pressable>
      </View>
      <TextInput
        accessibilityLabel="Search for a note to link to"
        autoFocus
        autoCorrect={false}
        placeholder="Search notes"
        placeholderTextColor={theme.colors.textMuted}
        returnKeyType="search"
        value={query}
        onChangeText={setQuery}
        style={[
          theme.type.body,
          {
            color: theme.colors.text,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
            paddingVertical: theme.spacing.sm,
          },
        ]}
      />
      {message ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[theme.type.body, { color: theme.colors.textMuted }]}
        >
          {message}
        </Text>
      ) : null}
      <FlatList
        data={targets ?? []}
        keyExtractor={(target) => target.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Link to ${item.title}. ${item.location}`}
            style={{ paddingVertical: theme.spacing.md }}
            onPress={() =>
              onPick({ id: item.id, title: item.title, linkText: linkText(item.id, item.title) })
            }
          >
            <Text style={[theme.type.body, { color: theme.colors.text }]}>{item.title}</Text>
            <Text style={[theme.type.caption, { color: theme.colors.textMuted }]}>{item.location}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
