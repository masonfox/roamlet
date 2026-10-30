import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useTheme } from '../theme';

/** Tall enough to tap, whatever the font size. */
const MIN_TOUCH_HEIGHT = 44;

export function TextButton({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={{ minHeight: MIN_TOUCH_HEIGHT, justifyContent: 'center' }}
    >
      <Text style={[theme.type.body, { color: theme.colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

/** A row of a list that opens something, with a title and any number of lines beneath it. */
export function ListRow({
  title,
  details,
  marks,
  accessibilityLabel,
  accessibilityState,
  indent = 0,
  onPress,
}: {
  title: string;
  details?: string[];
  /** Status words such as "No ID". They stand out from `details`, in the same place. */
  marks?: string[];
  accessibilityLabel: string;
  accessibilityState?: { expanded: boolean };
  indent?: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      onPress={onPress}
      style={{
        minHeight: MIN_TOUCH_HEIGHT,
        justifyContent: 'center',
        paddingVertical: theme.spacing.sm,
        paddingLeft: theme.spacing.lg + indent * theme.spacing.lg,
        paddingRight: theme.spacing.lg,
      }}
    >
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{title}</Text>
      {details?.map((detail) => (
        <Text key={detail} style={[theme.type.caption, { color: theme.colors.textMuted }]}>
          {detail}
        </Text>
      ))}
      {marks?.map((mark) => (
        <Text key={mark} style={[theme.type.caption, { color: theme.colors.danger }]}>
          {mark}
        </Text>
      ))}
    </Pressable>
  );
}

/** A message that sits above or below a list, with any actions that go with it. */
export function Notice({ message, children }: { message: string; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
      }}
    >
      <Text style={[theme.type.body, { color: theme.colors.text }]}>{message}</Text>
      {children}
    </View>
  );
}
