import { Pressable, Text } from 'react-native';

import { useTheme } from '../theme';

/** A plain text action. Its height follows the text, so large font sizes don't clip it. */
export function ActionButton({
  label,
  hint,
  onPress,
  disabled = false,
  danger = false,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const theme = useTheme();
  const color = disabled ? theme.colors.textMuted : danger ? theme.colors.danger : theme.colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: 'center', paddingVertical: theme.spacing.xs }}
    >
      <Text style={[theme.type.body, { color }]}>{label}</Text>
    </Pressable>
  );
}
