import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AccessibilityInfo, FlatList, Linking, Text, View } from 'react-native';

import type { IndexedNode } from '../../core/index';
import { useLibrary } from '../library-context';
import { Notice, TextButton } from '../notes/controls';
import { ReconnectNotice } from '../notes/reconnect-notice';
import { editorHref, readerHref } from '../notes/routes';
import { useIndexQuery } from '../notes/use-index-query';
import { useTheme } from '../theme';
import { blockIndexAt, type ReaderBlock } from './blocks';
import { BlockView } from './block-view';
import { LinkContext, type LinkActions } from './link-context';
import { LinkSections } from './link-sections';
import { useNote } from './use-note';

const UNRESOLVED_MESSAGE =
  'This note isn’t in this library, so the link can’t be followed. The link is unchanged, and will work if the note appears here.';
const UNRESOLVED_WHILE_INDEXING =
  'This note wasn’t found in this library, but Roamlet is still indexing, so it may appear shortly.';
const WEB_LINK_FAILED = 'This link couldn’t be opened.';

// Unmeasured rows make the first attempt fall short, and each retry measures more of them.
const MAX_SCROLL_ATTEMPTS = 10;

function keyOf(block: ReaderBlock): string {
  return String(block.span.start);
}

const EMPTY_TARGETS: ReadonlyMap<string, IndexedNode | null> = new Map();

/** The ID links of a note, resolved as of now, so a target that later syncs in just starts working. */
function useLinkTargets(ids: string[]): ReadonlyMap<string, IndexedNode | null> {
  const key = ids.join('\n');
  const { data } = useIndexQuery(
    async (index) => {
      const nodes = await Promise.all(ids.map((id) => index.resolveLink(id)));
      return new Map(ids.map((id, i) => [id, nodes[i]]));
    },
    [key],
  );
  return data ?? EMPTY_TARGETS;
}

function NoteList({
  title,
  text,
  blocks,
  scrollTo,
  notices,
  footer,
}: {
  title: string;
  text: string;
  blocks: ReaderBlock[];
  scrollTo: number | null;
  notices: ReactElement | null;
  footer: ReactElement;
}) {
  const theme = useTheme();
  const list = useRef<FlatList<ReaderBlock>>(null);
  const attempts = useRef(0);

  useEffect(() => {
    if (scrollTo === null) return;
    attempts.current = 0;
    const frame = requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index: scrollTo, viewPosition: 0, animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [scrollTo]);

  return (
    <FlatList
      ref={list}
      data={blocks}
      keyExtractor={keyOf}
      renderItem={({ item }) => <BlockView block={item} text={text} />}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        if (attempts.current >= MAX_SCROLL_ATTEMPTS) return;
        attempts.current += 1;
        list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
        requestAnimationFrame(() =>
          list.current?.scrollToIndex({ index, viewPosition: 0, animated: false }),
        );
      }}
      ListHeaderComponent={
        <View>
          {notices}
          <Text
            accessibilityRole="header"
            style={[
              theme.type.title,
              { color: theme.colors.text, padding: theme.spacing.lg, paddingBottom: theme.spacing.sm },
            ]}
          >
            {title}
          </Text>
        </View>
      }
      ListFooterComponent={footer}
    />
  );
}

export function ReaderScreen({ path, nodeId }: { path: string; nodeId: string | null }) {
  const theme = useTheme();
  const router = useRouter();
  const { index, refreshing } = useLibrary();
  const { load, reload } = useNote(path);
  const [message, setMessage] = useState<string | null>(null);

  const show = useCallback((next: string) => {
    setMessage(next);
    AccessibilityInfo.announceForAccessibility(next);
  }, []);

  const showUnresolved = useCallback(
    () => show(refreshing ? UNRESOLVED_WHILE_INDEXING : UNRESOLVED_MESSAGE),
    [show, refreshing],
  );

  const readable = load.status === 'opened' ? load.readable : null;
  const ids = useMemo(
    () => [...new Set(readable?.doc.links.map((link) => link.target) ?? [])],
    [readable],
  );
  const targets = useLinkTargets(ids);

  const links = useMemo<LinkActions>(
    () => ({
      targets,
      // Asks the index afresh, so a tap is right even if the list hasn't caught up yet.
      openId: (id) => {
        if (!index) {
          show(UNRESOLVED_MESSAGE);
          return;
        }
        void index.resolveLink(id).then(
          (node) => {
            if (node) router.push(readerHref(node.filePath, node.id));
            else showUnresolved();
          },
          () => showUnresolved(),
        );
      },
      openWeb: (url) => {
        Linking.openURL(url).catch(() => show(WEB_LINK_FAILED));
      },
    }),
    [targets, index, router, show, showUnresolved],
  );

  // The current file says where a heading is. The index may be behind it.
  const scrollTo = useMemo(() => {
    const node = nodeId ? readable?.doc.nodes.find((candidate) => candidate.id === nodeId) : null;
    if (!readable || !node || node.level === 0) return null;
    return blockIndexAt(readable.blocks, node.startOffset);
  }, [readable, nodeId]);

  // The index knows this while the file can't be read.
  const { data: indexedFile } = useIndexQuery((db) => db.getFile(path), [path]);
  const title = readable?.doc.title ?? indexedFile?.title ?? path;
  const editable = load.status === 'opened' && load.note.editable;

  // Stable, because a new options object makes the navigator render this screen again.
  const screenOptions = useMemo(
    () => ({
      title,
      headerRight: editable
        ? () => (
            <TextButton
              label="Edit"
              accessibilityLabel={`Edit ${title}`}
              onPress={() => router.push(editorHref(path))}
            />
          )
        : undefined,
    }),
    [title, editable, router, path],
  );

  const footer = <LinkSections path={path} onUnresolved={showUnresolved} />;

  let body: ReactElement;
  if (load.status === 'opened' && readable) {
    const readOnlyMessage = load.note.editable ? null : load.note.message;
    body = (
      <NoteList
        title={readable.doc.title}
        text={readable.text}
        blocks={readable.blocks}
        scrollTo={scrollTo}
        notices={readOnlyMessage ? <Notice message={readOnlyMessage} /> : null}
        footer={footer}
      />
    );
  } else {
    let notice: ReactElement | null = null;
    if (load.status === 'library_unavailable') {
      notice = <ReconnectNotice message={load.message} />;
    } else if (load.status === 'failed') {
      notice = (
        <Notice
          message={
            load.notDownloaded
              ? `${load.message} Roamlet asked for it to be downloaded, which needs a connection.`
              : load.message
          }
        >
          <TextButton label="Try again" onPress={reload} />
        </Notice>
      );
    } else if (load.status === 'opened') {
      notice = <Notice message={load.note.editable ? '' : load.note.message} />;
    }
    body = (
      <NoteList
        title={title}
        text=""
        blocks={[]}
        scrollTo={null}
        notices={notice}
        footer={load.status === 'loading' ? <View /> : footer}
      />
    );
  }

  return (
    <LinkContext.Provider value={links}>
      <Stack.Screen options={screenOptions} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <View style={{ flex: 1 }}>{body}</View>
        {message ? (
          <Notice message={message}>
            <TextButton label="Dismiss" accessibilityLabel="Dismiss message" onPress={() => setMessage(null)} />
          </Notice>
        ) : null}
      </View>
    </LinkContext.Provider>
  );
}
