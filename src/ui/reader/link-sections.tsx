import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { Backlink, OutgoingLink } from '../../core/index';
import { useLibrary } from '../library-context';
import { ListRow } from '../notes/controls';
import { rowLabel } from '../notes/file-marks';
import { readerHref } from '../notes/routes';
import { useIndexQuery } from '../notes/use-index-query';
import { useTheme } from '../theme';

/** One row per source node, however many links it has into this file. */
function uniqueSources(links: Backlink[]): Backlink[] {
  const seen = new Set<string>();
  return links.filter(({ source }) => {
    const key = `${source.filePath}\n${source.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Section({
  title,
  loaded,
  emptyText,
  children,
}: {
  title: string;
  loaded: boolean;
  emptyText: string;
  children: ReactNode[];
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.xl }}>
      <Text
        accessibilityRole="header"
        style={[
          theme.type.heading,
          { color: theme.colors.text, paddingHorizontal: theme.spacing.lg },
        ]}
      >
        {title}
      </Text>
      {children.length > 0 ? (
        children
      ) : (
        <Text
          style={[
            theme.type.body,
            {
              color: theme.colors.textMuted,
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.xs,
            },
          ]}
        >
          {loaded ? emptyText : 'Not available right now.'}
        </Text>
      )}
    </View>
  );
}

/**
 * Comes from the index, not the file, so it still works for a note that can't be opened. Unresolved
 * links are computed by the query, so they turn into working rows when the target appears.
 */
export function LinkSections({
  path,
  onUnresolved,
}: {
  path: string;
  onUnresolved: () => void;
}) {
  const router = useRouter();
  const { index } = useLibrary();
  const { data: backlinks } = useIndexQuery((db) => db.backlinksForFile(path), [path]);
  const { data: outgoing } = useIndexQuery((db) => db.outgoingLinks(path), [path]);
  const loaded = index !== null;

  return (
    <View style={{ paddingBottom: 48 }}>
      <Section title="Backlinks" loaded={loaded && backlinks !== null} emptyText="No notes link here.">
        {uniqueSources(backlinks ?? []).map(({ source }) => (
          <ListRow
            key={`${source.filePath}:${source.id}`}
            title={source.title}
            details={[source.filePath]}
            accessibilityLabel={rowLabel([`Backlink from ${source.title}`, source.filePath])}
            onPress={() => router.push(readerHref(source.filePath, source.id))}
          />
        ))}
      </Section>
      <Section
        title="Outgoing links"
        loaded={loaded && outgoing !== null}
        emptyText="This note has no links to other notes."
      >
        {(outgoing ?? []).map((link) => (
          <OutgoingRow
            key={link.startOffset}
            link={link}
            onOpen={() => {
              if (link.target) router.push(readerHref(link.target.filePath, link.target.id));
              else onUnresolved();
            }}
          />
        ))}
      </Section>
    </View>
  );
}

function OutgoingRow({ link, onOpen }: { link: OutgoingLink; onOpen: () => void }) {
  const title = link.target?.title || link.description || `id:${link.targetId}`;
  const details = link.target ? [link.target.filePath] : [];
  const marks = link.target ? [] : ['Not in this library'];
  return (
    <ListRow
      title={title}
      details={details}
      marks={marks}
      accessibilityLabel={rowLabel([`Link to ${title}`, ...details, ...marks])}
      onPress={onOpen}
    />
  );
}
