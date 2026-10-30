import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { useState } from 'react';
import { Text, TextInput } from 'react-native';

import RootLayout from '../../app/_layout';
import TabsLayout from '../../app/(tabs)/_layout';
import CaptureScreen from '../../app/(tabs)/capture';
import NotesLayout from '../../app/(tabs)/notes/_layout';
import NotesScreen from '../../app/(tabs)/notes/index';
import SettingsScreen from '../../app/(tabs)/settings';
import Index from '../../app/index';
import { useLibrary } from './library-context';

function CaptureWithText() {
  const [text, setText] = useState('');
  return <TextInput accessibilityLabel="Capture text" value={text} onChangeText={setText} />;
}

function NotesWithFolder() {
  const [folder, setFolder] = useState('root');
  return (
    <Text accessibilityLabel="Current folder" onPress={() => setFolder('daily')}>
      {folder}
    </Text>
  );
}

function LibraryStatus() {
  return <Text>{useLibrary().failure?.stage ?? 'no failure'}</Text>;
}

function pressTab(name: string) {
  return fireEvent.press(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
}

describe('the real app routes', () => {
  it('load in Jest without the native module, and report it missing', async () => {
    const router = await renderRouter({
      _layout: RootLayout,
      index: Index,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/notes/_layout': NotesLayout,
      '(tabs)/notes/index': LibraryStatus,
      '(tabs)/capture': CaptureScreen,
      '(tabs)/settings': SettingsScreen,
    });
    expect(router.getPathname()).toBe('/notes');
    expect(await screen.findByText('startup')).toBeTruthy();
  });
});

describe('primary destinations', () => {
  it('opens on Notes and reaches every destination', async () => {
    const router = await renderRouter({
      index: Index,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/notes/_layout': NotesLayout,
      '(tabs)/notes/index': NotesScreen,
      '(tabs)/capture': CaptureScreen,
      '(tabs)/settings': SettingsScreen,
    });
    expect(router.getPathname()).toBe('/notes');

    await pressTab('Capture');
    expect(router.getPathname()).toBe('/capture');

    await pressTab('Settings');
    expect(router.getPathname()).toBe('/settings');

    await pressTab('Notes');
    expect(router.getPathname()).toBe('/notes');
  });

  it('keeps unsaved capture text and the current folder when switching', async () => {
    await renderRouter({
      index: Index,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/notes/_layout': NotesLayout,
      '(tabs)/notes/index': NotesWithFolder,
      '(tabs)/capture': CaptureWithText,
      '(tabs)/settings': () => <Text>Settings screen</Text>,
    });

    await fireEvent.press(screen.getByLabelText('Current folder'));
    expect(screen.getByText('daily')).toBeTruthy();

    await pressTab('Capture');
    await fireEvent.changeText(screen.getByLabelText('Capture text'), 'half a thought');

    await pressTab('Settings');
    expect(screen.getByText('Settings screen')).toBeTruthy();

    await pressTab('Notes');
    expect(screen.getByText('daily')).toBeTruthy();

    await pressTab('Capture');
    expect(screen.getByLabelText('Capture text').props.value).toBe('half a thought');
  });
});
