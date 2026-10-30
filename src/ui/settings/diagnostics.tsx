import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { LibraryProblems } from '../../core/index';
import { useTheme } from '../theme';
import type { LibraryReport } from './use-library-report';

interface Category {
  key: string;
  title: string;
  /** How many problems, which for some categories is more than one per file. */
  count: number;
  /** One line per affected file. */
  lines: string[];
}

function duplicateLines(problems: LibraryProblems): string[] {
  return problems.duplicateIds.flatMap(({ id, nodes }) =>
    nodes.map((node) => `${node.filePath} (${id})`),
  );
}

function categoriesOf({ problems, conflictCopies }: LibraryReport): Category[] {
  return [
    {
      key: 'duplicate-ids',
      title: 'Duplicate IDs',
      count: problems.duplicateIds.length,
      lines: duplicateLines(problems),
    },
    {
      key: 'unresolved-links',
      title: 'Unresolved links',
      count: problems.unresolvedLinks.length,
      lines: problems.unresolvedLinks.map((link) => `${link.filePath} (${link.targetId})`),
    },
    {
      key: 'files-without-ids',
      title: 'Files without IDs',
      count: problems.filesWithoutIds.length,
      lines: problems.filesWithoutIds,
    },
    {
      key: 'invalid-utf8',
      title: 'Files that aren’t valid UTF-8',
      count: problems.invalidUtf8.length,
      lines: problems.invalidUtf8,
    },
    {
      key: 'not-downloaded',
      title: 'Files not on this device',
      count: problems.notDownloaded.length,
      lines: problems.notDownloaded.map((file) => file.path),
    },
    {
      key: 'unreadable',
      title: 'Files that couldn’t be read',
      count: problems.unreadable.length,
      lines: problems.unreadable,
    },
    {
      key: 'conflict-copies',
      title: 'Conflict copies',
      count: conflictCopies.length,
      lines: conflictCopies.map((copy) => copy.path),
    },
  ];
}

function CategoryRow({ category }: { category: Category }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const { title, count, lines } = category;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${count}`}
        accessibilityHint={open ? 'Hides the affected files' : 'Shows the affected files'}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
        }}
      >
        <Text style={[theme.type.body, { color: theme.colors.accent, flexShrink: 1 }]}>{title}</Text>
        <Text style={[theme.type.body, { color: theme.colors.text }]}>{count}</Text>
      </Pressable>
      {open
        ? lines.map((line, position) => (
            <Text
              key={`${position}:${line}`}
              style={[
                theme.type.caption,
                { color: theme.colors.textMuted, paddingBottom: theme.spacing.xs },
              ]}
            >
              {line}
            </Text>
          ))
        : null}
    </View>
  );
}

/** Each problem category with a count and its files. Empty categories are left out. */
export function Diagnostics({ report }: { report: LibraryReport }) {
  const theme = useTheme();
  const categories = categoriesOf(report).filter((category) => category.count > 0);
  if (categories.length === 0) {
    return <Text style={[theme.type.body, { color: theme.colors.text }]}>No problems found.</Text>;
  }
  return (
    <View>
      {categories.map((category) => (
        <CategoryRow key={category.key} category={category} />
      ))}
    </View>
  );
}
