import { Tabs } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { headerOptions, useTheme } from '../../src/ui/theme';

// The default bar height is fixed, which would clip labels at large font sizes.
const TAB_BAR_HEIGHT = 49;

export default function TabsLayout() {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        ...headerOptions(theme),
        sceneStyle: { backgroundColor: theme.colors.background },
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textMuted,
        // Labels only. Icon sets are bundled fonts, which Decision 7 rules out.
        tabBarIcon: () => null,
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: theme.type.body.fontSize },
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          height: Math.ceil(TAB_BAR_HEIGHT * Math.max(fontScale, 1)) + insets.bottom,
        },
      }}
    >
      <Tabs.Screen name="notes" options={{ title: 'Notes', headerShown: false }} />
      <Tabs.Screen name="capture" options={{ title: 'Capture' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
