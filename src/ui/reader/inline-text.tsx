import { memo, useContext, useMemo, type ReactNode } from 'react';
import { Text, type TextStyle } from 'react-native';

import { tokenizeInline, type InlineToken, type Span } from '../../core/org';
import { useTheme, type Theme } from '../theme';
import { LinkContext, type LinkActions } from './link-context';

type LinkToken = Extract<InlineToken, { type: 'link' }>;

/** Org wraps prose at a fixed column, which on a phone would only leave ragged lines. */
function flowing(source: string): string {
  return source.replace(/[ \t]*\r?\n[ \t]*/g, ' ');
}

const WEB_LINK_TYPES = new Set(['http', 'https']);

function shownAsText(token: LinkToken): string {
  if (token.description !== null) return flowing(token.description);
  return token.linkType === 'fuzzy' ? token.target : `${token.linkType}:${token.target}`;
}

function renderLink(token: LinkToken, theme: Theme, links: LinkActions): ReactNode {
  const key = token.span.start;
  const linkStyle: TextStyle = { color: theme.colors.accent, textDecorationLine: 'underline' };

  if (token.linkType === 'id' && token.target !== '') {
    const target = links.targets.get(token.target);
    // Marked once known to be missing. Underlined or not tells it apart without relying on color.
    const missing = target === null;
    const shown = token.description === null ? target?.title || shownAsText(token) : shownAsText(token);
    return (
      <Text
        key={key}
        accessibilityRole="link"
        accessibilityLabel={missing ? `${shown}, note not in this library` : shown}
        onPress={() => links.openId(token.target)}
        style={missing ? { color: theme.colors.danger } : linkStyle}
      >
        {shown}
      </Text>
    );
  }
  if (WEB_LINK_TYPES.has(token.linkType)) {
    const url = `${token.linkType}:${token.target}`;
    const shown = shownAsText(token);
    return (
      <Text
        key={key}
        accessibilityRole="link"
        accessibilityLabel={`${shown}, opens outside Roamlet`}
        onPress={() => links.openWeb(url)}
        style={linkStyle}
      >
        {shown}
      </Text>
    );
  }
  return <Text key={key}>{shownAsText(token)}</Text>;
}

function renderTokens(
  text: string,
  tokens: InlineToken[],
  theme: Theme,
  links: LinkActions,
): ReactNode[] {
  return tokens.map((token) => {
    const key = token.span.start;
    switch (token.type) {
      case 'text':
        return flowing(text.slice(token.span.start, token.span.end));
      case 'verbatim':
      case 'code':
        return (
          <Text key={key} style={{ fontFamily: theme.fonts.mono }}>
            {flowing(text.slice(token.contentSpan.start, token.contentSpan.end))}
          </Text>
        );
      case 'link':
        return renderLink(token, theme, links);
      default: {
        const style: TextStyle = {
          bold: { fontWeight: '700' } as const,
          italic: { fontStyle: 'italic' } as const,
          underline: { textDecorationLine: 'underline' } as const,
          strike: { textDecorationLine: 'line-through' } as const,
        }[token.type];
        return (
          <Text key={key} style={style}>
            {renderTokens(text, token.children, theme, links)}
          </Text>
        );
      }
    }
  });
}

/** Renders one span of a note's text with its emphasis and links. Must sit inside a `Text`. */
export const InlineText = memo(function InlineText({ text, span }: { text: string; span: Span }) {
  const theme = useTheme();
  const links = useContext(LinkContext);
  const tokens = useMemo(() => tokenizeInline(text, span.start, span.end), [text, span]);
  return renderTokens(text, tokens, theme, links);
});
