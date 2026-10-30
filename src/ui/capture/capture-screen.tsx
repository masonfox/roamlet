import { useRef, useState, type ComponentRef } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputSelectionChangeEvent,
} from 'react-native';

import { insertLink, type Span } from '../../core/org';
import { LinkPicker, type PickedLink } from '../link-picker';
import { useTheme } from '../theme';
import { DRAFT_UNREADABLE_MESSAGE, useCapture } from './use-capture';

function ActionButton({
  label,
  onPress,
  disabled = false,
  prominent = false,
  destructive = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  prominent?: boolean;
  destructive?: boolean;
}) {
  const theme = useTheme();
  const color = disabled
    ? theme.colors.textMuted
    : destructive
      ? theme.colors.danger
      : theme.colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: theme.spacing.sm }}
    >
      <Text style={[prominent ? theme.type.heading : theme.type.body, { color }]}>{label}</Text>
    </Pressable>
  );
}

/** Quick capture: only text, with the first line as the title. */
export function CaptureScreen() {
  const theme = useTheme();
  const capture = useCapture();
  const { ready, text } = capture;

  const [pickerOpen, setPickerOpen] = useState(false);
  // Only set just after inserting a link, to move the cursor past it. Otherwise the field owns it.
  const [forcedSelection, setForcedSelection] = useState<Span | undefined>(undefined);
  // Null until the field reports one, which means the end of the text.
  const selection = useRef<Span | null>(null);
  const insertAt = useRef<Span | null>(null);
  // Keyboard avoidance needs to know how far down the window this screen starts, below the header.
  const frame = useRef<ComponentRef<typeof View>>(null);
  const [topInWindow, setTopInWindow] = useState(0);

  const onSelectionChange = (event: TextInputSelectionChangeEvent) => {
    const { start, end } = event.nativeEvent.selection;
    selection.current = { start, end };
    setForcedSelection(undefined);
  };

  const openPicker = () => {
    // The field can report a change on losing focus, so the cursor is read now.
    const { start, end } = selection.current ?? { start: text.length, end: text.length };
    insertAt.current = { start: Math.min(start, text.length), end: Math.min(end, text.length) };
    setPickerOpen(true);
  };

  const onPick = (link: PickedLink) => {
    const at = insertAt.current ?? { start: text.length, end: text.length };
    const inserted = insertLink(text, at, link.id, link.title);
    capture.setText(inserted.text);
    const cursor = { start: inserted.cursor, end: inserted.cursor };
    selection.current = cursor;
    setForcedSelection(cursor);
    setPickerOpen(false);
  };

  const confirmDiscard = () => {
    Alert.alert('Discard this text?', 'It will be gone for good, and no note will be created.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => void capture.discard() },
    ]);
  };

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
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: theme.spacing.sm,
          }}
        >
          <ActionButton
            label="Insert link"
            onPress={openPicker}
            disabled={!ready || capture.saving}
          />
          <ActionButton
            label="Discard"
            destructive
            onPress={confirmDiscard}
            disabled={text === '' || capture.saving}
          />
          <ActionButton
            label={capture.saving ? 'Saving' : 'Save'}
            prominent
            onPress={() => void capture.save()}
            disabled={!capture.canSave}
          />
        </View>

        {capture.notWritableReason ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[theme.type.body, { color: theme.colors.textMuted }]}
          >
            {capture.notWritableReason}
            {ready ? ' Your text is kept here as a draft.' : ''}
          </Text>
        ) : null}
        {capture.problem ? (
          <Text
            accessibilityLiveRegion="assertive"
            style={[theme.type.body, { color: theme.colors.danger }]}
          >
            {capture.problem}
          </Text>
        ) : null}
        {capture.restoreFailed ? (
          <View style={{ gap: theme.spacing.xs, alignItems: 'flex-start' }}>
            <Text
              accessibilityLiveRegion="assertive"
              style={[theme.type.body, { color: theme.colors.danger }]}
            >
              {DRAFT_UNREADABLE_MESSAGE}
            </Text>
            <ActionButton label="Try again" onPress={capture.retryRestore} />
          </View>
        ) : null}
        {capture.savedTitle ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[theme.type.body, { color: theme.colors.textMuted }]}
          >
            Saved “{capture.savedTitle}”.
          </Text>
        ) : null}

        <TextInput
          accessibilityLabel="Capture text"
          accessibilityHint="The first line becomes the note’s title."
          editable={ready && !capture.saving}
          multiline
          placeholder="Write something. The first line becomes the title."
          placeholderTextColor={theme.colors.textMuted}
          scrollEnabled
          selection={forcedSelection}
          textAlignVertical="top"
          value={text}
          onChangeText={capture.setText}
          onSelectionChange={onSelectionChange}
          style={[theme.type.reading, { flex: 1, color: theme.colors.text }]}
        />

        <LinkPicker visible={pickerOpen} onPick={onPick} onClose={() => setPickerOpen(false)} />
      </KeyboardAvoidingView>
    </View>
  );
}
