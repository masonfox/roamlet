import { memo, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useTheme } from '../theme';
import type { HeadingBlock, ListItemBlock, PreformattedBlock, ReaderBlock } from './blocks';
import { InlineText } from './inline-text';

// One level of a list's source indentation, usually two blanks, as on-screen space.
const LIST_INDENT_PER_BLANK = 8;

const PREFORMATTED_LABEL: Record<PreformattedBlock['kind'], string> = {
  table: 'Table',
  source: 'Source block',
  example: 'Fixed-width text',
};

function Heading({ block, text }: { block: HeadingBlock; text: string }) {
  const theme = useTheme();
  const before = [block.todo, block.priority && `[#${block.priority}]`].filter(Boolean).join(' ');
  return (
    <Text
      accessibilityRole="header"
      style={[
        block.level === 1 ? theme.type.title : theme.type.heading,
        { color: theme.colors.text, marginTop: theme.spacing.md },
      ]}
    >
      {before ? <Text style={{ color: theme.colors.textMuted }}>{before} </Text> : null}
      <InlineText text={text} span={block.titleSpan} />
      {block.tags.length > 0 ? (
        <Text style={[theme.type.caption, { color: theme.colors.textMuted }]}>
          {'  '}:{block.tags.join(':')}:
        </Text>
      ) : null}
    </Text>
  );
}

function ListItem({ block, text }: { block: ListItemBlock; text: string }) {
  const theme = useTheme();
  const readingStyle = [theme.type.reading, { color: theme.colors.text }];
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing.sm,
        paddingLeft: block.indent * LIST_INDENT_PER_BLANK,
      }}
    >
      <Text style={readingStyle}>{block.marker}</Text>
      <Text style={[readingStyle, { flex: 1 }]}>
        <InlineText text={text} span={block.contentSpan} />
      </Text>
    </View>
  );
}

function Preformatted({ block }: { block: PreformattedBlock }) {
  const theme = useTheme();
  const label = PREFORMATTED_LABEL[block.kind];
  return (
    <View style={{ backgroundColor: theme.colors.surface, padding: theme.spacing.md }}>
      {block.language ? (
        <Text style={[theme.type.caption, { color: theme.colors.textMuted }]}>{block.language}</Text>
      ) : null}
      {/* Sideways, so wide lines keep their shape and never widen the page. */}
      <ScrollView
        horizontal
        accessibilityLabel={block.language ? `${label}, ${block.language}` : label}
      >
        <Text style={[theme.type.mono, { color: theme.colors.text }]}>{block.content}</Text>
      </ScrollView>
    </View>
  );
}

function QuoteInset({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border,
        paddingLeft: theme.spacing.md,
      }}
    >
      {children}
    </View>
  );
}

export const BlockView = memo(function BlockView({ block, text }: { block: ReaderBlock; text: string }) {
  const theme = useTheme();
  const content = (() => {
    switch (block.kind) {
      case 'heading':
        return <Heading block={block} text={text} />;
      case 'paragraph':
        return (
          <Text style={[theme.type.reading, { color: theme.colors.text }]}>
            <InlineText text={text} span={block.span} />
          </Text>
        );
      case 'listItem':
        return <ListItem block={block} text={text} />;
      case 'table':
      case 'source':
      case 'example':
        return <Preformatted block={block} />;
      default:
        return (
          <Text
            style={
              block.style === 'verse'
                ? [theme.type.reading, { color: theme.colors.text }]
                : [theme.type.mono, { color: theme.colors.textMuted }]
            }
          >
            {block.content}
          </Text>
        );
    }
  })();
  return (
    <View style={{ paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs }}>
      {block.quoted ? <QuoteInset>{content}</QuoteInset> : content}
    </View>
  );
});
