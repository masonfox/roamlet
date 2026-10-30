import { Text, View } from 'react-native';

import { useTheme } from '../../../src/ui/theme';

export default function NotesScreen() {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, padding: theme.spacing.lg }}>
      <Text style={[theme.type.body, { color: theme.colors.textMuted }]}>Notes</Text>
    </View>
  );
}
