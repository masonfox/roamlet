import { Stack } from 'expo-router';

import { headerOptions, useTheme } from '../../../src/ui/theme';

// A stack, so the reader can open over the folder tree and leave it where it was.
export default function NotesLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        ...headerOptions(theme),
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Notes' }} />
      <Stack.Screen name="read" options={{ title: 'Note' }} />
    </Stack>
  );
}
