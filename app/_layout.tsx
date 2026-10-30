import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { LibraryProvider } from '../src/ui/library-context';
import { LibraryController } from '../src/ui/library-controller';
import { loadNativeLibraryServices } from '../src/ui/native-library-services';
import { headerOptions, useTheme } from '../src/ui/theme';

const library = new LibraryController(loadNativeLibraryServices);

export default function RootLayout() {
  const theme = useTheme();
  return (
    <LibraryProvider controller={library}>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          ...headerOptions(theme),
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </LibraryProvider>
  );
}
