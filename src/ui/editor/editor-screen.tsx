import { Stack, usePreventRemove } from 'expo-router';
import { useRef, useState, type ComponentRef } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  View,
  type TextInputSelectionChangeEvent,
} from 'react-native';

import { insertLink, type IdWarning, type Span } from '../../core/org';
import { LinkPicker, type PickedLink } from '../link-picker';
import { ActionButton } from '../settings/action-button';
import { useTheme } from '../theme';
import { useNoteEditor } from './use-note-editor';

function describeWarning(warning: IdWarning): string {
  const node = warning.level === 0 ? 'This note' : `The heading “${warning.title}”`;
  switch (warning.kind) {
    case 'removed':
      return `${node} will no longer exist as a node, because its ID ${warning.id} is gone. Links to it will stop working.`;
    case 'changed':
      return `${node} will change ID from ${warning.id} to ${warning.newId}. Links to the old ID will stop working.`;
    case 'duplicated':
      return `${node} will use the ID ${warning.id}, which is already in use.`;
  }
}

function Message({ text, urgent = false }: { text: string; urgent?: boolean }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole={urgent ? 'alert' : undefined}
      accessibilityLiveRegion={urgent ? 'assertive' : 'polite'}
      style={[theme.type.body, { color: urgent ? theme.colors.danger : theme.colors.textMuted }]}
    >
      {text}
    </Text>
  );
}

/**
 * The editor: a title field and the file's body as plain text, saved only when asked.
 */
export function EditorScreen({ path }: { path: string }) {
  const theme = useTheme();
  const editor = useNoteEditor(path);
  const { body, dirty, saving } = editor;

  // Keyboard avoidance has to know how far down the window this screen starts.
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [topInWindow, setTopInWindow] = useState(0);

  const [pickerOpen, setPickerOpen] = useState(false);
  // Only set just after inserting a link, to move the cursor past it. Otherwise the field owns it.
  const [forcedSelection, setForcedSelection] = useState<Span | undefined>(undefined);
  // Null until the field reports one, which means the end of the text.
  const selection = useRef<Span | null>(null);
  const insertAt = useRef<Span | null>(null);

  usePreventRemove(dirty, ({ repeat }) => {
    Alert.alert('Discard your changes?', 'Your edits to this note haven’t been saved.', [
      { text: 'Keep editing', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          void editor.discard();
          repeat();
        },
      },
    ]);
  });

  const onSelectionChange = (event: TextInputSelectionChangeEvent) => {
    const { start, end } = event.nativeEvent.selection;
    selection.current = { start, end };
    setForcedSelection(undefined);
  };

  const openPicker = () => {
    // The field can report a change on losing focus, so the cursor is read now.
    const { start, end } = selection.current ?? { start: body.length, end: body.length };
    insertAt.current = { start: Math.min(start, body.length), end: Math.min(end, body.length) };
    setPickerOpen(true);
  };

  const onPick = (link: PickedLink) => {
    const at = insertAt.current ?? { start: body.length, end: body.length };
    const inserted = insertLink(body, at, link.id, link.title);
    editor.setBody(inserted.text);
    const cursor = { start: inserted.cursor, end: inserted.cursor };
    selection.current = cursor;
    setForcedSelection(cursor);
    setPickerOpen(false);
  };

  const confirmReload = () => {
    Alert.alert('Reload the file?', 'Your text will be replaced by the current file.', [
      { text: 'Keep my text', style: 'cancel' },
      { text: 'Reload', style: 'destructive', onPress: () => void editor.reload() },
    ]);
  };

  const options = <Stack.Screen options={{ title: 'Edit' }} />;

  if (!editor.editing) {
    const { load, unavailableMessage } = editor;
    const message =
      unavailableMessage ?? (load.status === 'loading' ? null : load.message);
    const canRetry =
      !unavailableMessage && (load.status === 'failed' || load.status === 'draft_unreadable');
    return (
      <View style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        {options}
        {message ? <Message text={message} urgent={load.status !== 'read_only'} /> : null}
        {canRetry ? <ActionButton label="Try again" onPress={editor.retry} /> : null}
      </View>
    );
  }

  return (
    <View
      ref={frame}
      style={{ flex: 1 }}
      onLayout={() => frame.current?.measureInWindow((_x, y) => setTopInWindow(y))}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={topInWindow}
        style={{ flex: 1, padding: theme.spacing.lg, gap: theme.spacing.sm }}
      >
        {options}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: theme.spacing.lg,
          }}
        >
          <ActionButton label="Insert link" onPress={openPicker} disabled={saving} />
          <ActionButton
            label={saving ? 'Saving' : 'Save'}
            onPress={() => void editor.save()}
            disabled={!editor.canSave}
          />
        </View>

        {editor.notWritableReason ? (
          <Message text={`${editor.notWritableReason} Your text is kept here as a draft.`} />
        ) : null}
        {editor.problem ? <Message text={editor.problem} urgent /> : null}
        {editor.status ? <Message text={editor.status} /> : null}

        {editor.stale ? (
          <View>
            <Message
              text="This file changed after you started editing, so it wasn’t overwritten. Your text is still here."
              urgent
            />
            <ActionButton
              label="Save my text as a conflict copy"
              hint="Saves your text in a new file beside the note"
              onPress={() => void editor.saveCopy()}
              disabled={saving || editor.notWritableReason !== null}
            />
            <ActionButton
              label="Reload the file"
              hint="Replaces your text with the current file"
              danger
              onPress={confirmReload}
              disabled={saving || editor.notWritableReason !== null}
            />
          </View>
        ) : null}

        {editor.idWarnings ? (
          <View>
            {editor.idWarnings.map((warning, position) => (
              <Message key={position} text={describeWarning(warning)} urgent />
            ))}
            <ActionButton label="Back to editing" onPress={editor.cancelSave} />
            <ActionButton
              label="Save anyway"
              danger
              onPress={() => void editor.confirmSave()}
              disabled={saving}
            />
          </View>
        ) : null}

        <TextInput
          accessibilityLabel="Title"
          autoCorrect={false}
          editable={!saving}
          placeholder="Title"
          placeholderTextColor={theme.colors.textMuted}
          value={editor.title}
          onChangeText={editor.setTitle}
          style={[
            theme.type.title,
            {
              color: theme.colors.text,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
              paddingVertical: theme.spacing.xs,
            },
          ]}
        />
        {/* Corrections and capitals would change text the user didn't touch. */}
        <TextInput
          accessibilityLabel="Note text"
          accessibilityHint="Plain text, including headings, drawers, and blocks exactly as written."
          autoCapitalize="none"
          autoCorrect={false}
          editable={!saving}
          multiline
          scrollEnabled
          selection={forcedSelection}
          smartInsertDelete={false}
          spellCheck={false}
          textAlignVertical="top"
          value={body}
          onChangeText={editor.setBody}
          onSelectionChange={onSelectionChange}
          style={[theme.type.mono, { flex: 1, color: theme.colors.text }]}
        />

        <LinkPicker visible={pickerOpen} onPick={onPick} onClose={() => setPickerOpen(false)} />
      </KeyboardAvoidingView>
    </View>
  );
}
