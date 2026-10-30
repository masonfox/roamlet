import { Platform, useColorScheme, type TextStyle } from 'react-native';

// Decision 7: light and dark follow the system, with system fonts only. There are no theme settings
// and no bundled fonts. Sizes are starting points that the platform's font-size setting scales, so
// nothing here may turn `allowFontScaling` off.

export interface ThemeColors {
  background: string;
  /** Raised areas such as the tab bar and headers. */
  surface: string;
  text: string;
  /** Secondary text. Still meets 4.5:1 against `background` and `surface`. */
  textMuted: string;
  /** Links, active navigation, and primary actions. Meets 4.5:1 too. */
  accent: string;
  danger: string;
  border: string;
}

export interface Theme {
  scheme: 'light' | 'dark';
  colors: ThemeColors;
  /** The system's interface font is the default, so UI text needs no `fontFamily`. */
  fonts: {
    /** The system serif, for note text. */
    reading: string;
    /** For source blocks and tables. */
    mono: string;
  };
  type: {
    title: TextStyle;
    heading: TextStyle;
    body: TextStyle;
    reading: TextStyle;
    mono: TextStyle;
    caption: TextStyle;
  };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
}

const LIGHT: ThemeColors = {
  background: '#FBFAF8',
  surface: '#F2F0EC',
  text: '#1C1B19',
  textMuted: '#5F5B54',
  accent: '#2B5A87',
  danger: '#A8261D',
  border: '#D9D5CE',
};

const DARK: ThemeColors = {
  background: '#141312',
  surface: '#1F1D1B',
  text: '#ECE9E4',
  textMuted: '#ABA69E',
  accent: '#8DB4DC',
  danger: '#F2A29B',
  border: '#3A3734',
};

const FONTS: Theme['fonts'] = Platform.select({
  ios: { reading: 'Georgia', mono: 'Menlo' },
  default: { reading: 'serif', mono: 'monospace' },
});

const TYPE: Theme['type'] = {
  title: { fontSize: 22, lineHeight: 28, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22 },
  reading: { fontFamily: FONTS.reading, fontSize: 18, lineHeight: 27 },
  mono: { fontFamily: FONTS.mono, fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 13, lineHeight: 18 },
};

const SPACING: Theme['spacing'] = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

function themeWith(scheme: Theme['scheme'], colors: ThemeColors): Theme {
  return { scheme, colors, fonts: FONTS, type: TYPE, spacing: SPACING };
}

export const lightTheme = themeWith('light', LIGHT);
export const darkTheme = themeWith('dark', DARK);

/** The current theme. Components using it update when the system appearance changes. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

/** Options for any navigator header, so they all match. */
export function headerOptions(theme: Theme) {
  return {
    headerStyle: { backgroundColor: theme.colors.surface },
    headerTintColor: theme.colors.text,
  };
}
