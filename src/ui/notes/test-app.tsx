import { Slot } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Text } from 'react-native';

import TabsLayout from '../../../app/(tabs)/_layout';
import NotesLayout from '../../../app/(tabs)/notes/_layout';
import NotesRoute from '../../../app/(tabs)/notes/index';
import ReadRoute from '../../../app/(tabs)/notes/read';
import Index from '../../../app/index';
import { LibraryProvider } from '../library-context';
import type { TestLibrary } from '../test-library';

// Not a test file: renders the real Notes routes over a test library. Nothing under app/ imports
// this. The other tabs and the editor are stand-ins, since other screens own them.

export function renderNotesApp(library: TestLibrary, initialUrl = '/notes') {
  return renderRouter(
    {
      _layout: () => (
        <LibraryProvider controller={library.controller}>
          <Slot />
        </LibraryProvider>
      ),
      index: Index,
      '(tabs)/_layout': TabsLayout,
      '(tabs)/notes/_layout': NotesLayout,
      '(tabs)/notes/index': NotesRoute,
      '(tabs)/notes/read': ReadRoute,
      '(tabs)/notes/edit': () => <Text>Editor stand-in</Text>,
      '(tabs)/capture': () => <Text>Capture stand-in</Text>,
      '(tabs)/settings': () => <Text>Settings stand-in</Text>,
    },
    { initialUrl },
  );
}

/** A note with a file-level ID. */
export function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}`;
}
