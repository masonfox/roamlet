import { act, render, screen } from '@testing-library/react-native';
import { Appearance, DeviceEventEmitter, StyleSheet, Text, useColorScheme } from 'react-native';

import CaptureScreen from '../../app/(tabs)/capture';
import { darkTheme, lightTheme, useTheme, type Theme } from './theme';

jest.mock('react-native/Libraries/Utilities/NativeAppearance', () => ({
  __esModule: true,
  default: {
    getColorScheme: () => 'light',
    setColorScheme: () => undefined,
    addListener: () => undefined,
    removeListeners: () => undefined,
  },
}));

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each<[string, Theme]>([
  ['light', lightTheme],
  ['dark', darkTheme],
])('%s theme', (_name, theme) => {
  it.each(['text', 'textMuted', 'accent', 'danger'] as const)('%s stays legible', (color) => {
    expect(contrast(theme.colors[color], theme.colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.colors[color], theme.colors.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('uses system fonts', () => {
    expect(['Georgia', 'serif']).toContain(theme.fonts.reading);
    expect(['Menlo', 'monospace']).toContain(theme.fonts.mono);
  });
});

// The React Native preset replaces this hook with a fixed answer. These tests need the real one,
// which follows the system through the event below.
beforeEach(() => {
  jest
    .mocked(useColorScheme)
    .mockImplementation(
      jest.requireActual('react-native/Libraries/Utilities/useColorScheme').default,
    );
});

/** Delivers a change the way the native side does. */
async function systemAppearance(colorScheme: 'light' | 'dark') {
  Appearance.getColorScheme();
  await act(async () => {
    DeviceEventEmitter.emit('appearanceChanged', { colorScheme });
  });
}

describe('useTheme', () => {
  function Scheme() {
    return <Text>{useTheme().scheme}</Text>;
  }

  afterEach(async () => {
    await systemAppearance('light');
  });

  it('follows the appearance while running', async () => {
    await systemAppearance('light');
    await render(<Scheme />);
    expect(screen.getByText('light')).toBeTruthy();

    await systemAppearance('dark');
    expect(screen.getByText('dark')).toBeTruthy();

    await systemAppearance('light');
    expect(screen.getByText('light')).toBeTruthy();
  });

  it('recolors a mounted screen without a restart', async () => {
    await systemAppearance('light');
    await render(<CaptureScreen />);
    const color = () => StyleSheet.flatten(screen.getByText('Capture').props.style).color;
    expect(color()).toBe(lightTheme.colors.textMuted);

    await systemAppearance('dark');
    expect(color()).toBe(darkTheme.colors.textMuted);
  });
});
