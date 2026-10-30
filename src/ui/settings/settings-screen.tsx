import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';

import type { ReconcileResult } from '../../core/index';
import { ANDROID_FOLDER_GUIDANCE, type ChooseFolderResult, type LibraryState } from '../../core/library';
import type { PathFailure } from '../../core/ports';
import { useLibrary } from '../library-context';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { Diagnostics } from './diagnostics';
import { exportLibrary, type ExportOutcome } from './export-library';
import { useLibraryReport } from './use-library-report';

const APP_OWNED_NAME = 'Roamlet’s own folder';

const PROVIDER_GUIDANCE: string =
  Platform.select({
    ios: 'Choose a folder from iCloud Drive, Dropbox, Working Copy, or this iPhone. Some providers, such as Google Drive and OneDrive, may not allow folder access. If so, Roamlet will say so and keep your current library.',
    android: `A folder on this device works best, such as one Syncthing keeps up to date. Cloud apps may not offer their folders here. ${ANDROID_FOLDER_GUIDANCE}`,
  }) ?? '';

const STAY_BEHIND_NOTE =
  'Roamlet opens your folder in place, and doesn’t add or copy anything until you save. Notes in Roamlet’s own folder stay there and aren’t moved. To reach them, switch back here or export them first.';

const APP_OWNED_LOCATION: string =
  Platform.select({
    ios: 'On this device, and visible in the Files app under Roamlet.',
    android: 'On this device, private to Roamlet. Use Export to get your notes out.',
  }) ?? '';

function locationOf(state: Exclude<LibraryState, { status: 'starting' }>): {
  name: string;
  place: string;
} {
  if (state.root.kind === 'app_owned') return { name: APP_OWNED_NAME, place: APP_OWNED_LOCATION };
  return { name: state.root.name, place: 'A folder you chose. Your files stay where they are.' };
}

function accessOf(state: LibraryState): string {
  if (state.status === 'starting') return 'Opening…';
  if (state.status === 'unavailable') return 'Access lost';
  return state.writable ? 'Can be read and edited' : 'Read-only';
}

/** Files, in the units people see elsewhere. Not localized, as nothing else in the app is yet. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function chooseMessageOf(result: ChooseFolderResult): string | null {
  switch (result.status) {
    case 'cancelled':
      return null;
    case 'refused':
      return result.message;
    case 'activated':
      return result.reconnected ? 'Folder reconnected. Any unsaved text is still there.' : null;
  }
}

function listingMessageOf(result: ReconcileResult | null): string | null {
  if (result?.listing === 'failed') {
    return 'The library couldn’t be listed just now, so the index was left as it was.';
  }
  if (result?.listing === 'partial') {
    const folders = result.listingFailures.map((failed) => failed.path).join(', ');
    return `Some folders couldn’t be listed, so their notes may be out of date: ${folders}`;
  }
  return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text accessibilityRole="header" style={[theme.type.heading, { color: theme.colors.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        gap: theme.spacing.sm,
      }}
    >
      <Text style={[theme.type.body, { color: theme.colors.textMuted }]}>{label}</Text>
      <Text style={[theme.type.body, { color: theme.colors.text, flexShrink: 1 }]}>{value}</Text>
    </View>
  );
}

function Muted({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[theme.type.caption, { color: theme.colors.textMuted }]}>{children}</Text>;
}

function Alerted({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[theme.type.body, { color: theme.colors.danger }]}
    >
      {children}
    </Text>
  );
}

function PathList({ intro, paths }: { intro: string; paths: PathFailure[] }) {
  if (paths.length === 0) return null;
  return (
    <View>
      <Muted>{intro}</Muted>
      {paths.map(({ path }) => (
        <Muted key={path}>{path || 'The library folder'}</Muted>
      ))}
    </View>
  );
}

function ExportSummary({ outcome }: { outcome: ExportOutcome }) {
  const theme = useTheme();
  if (outcome.status === 'failed') return <Alerted>{outcome.message}</Alerted>;
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text accessibilityLiveRegion="polite" style={[theme.type.body, { color: theme.colors.text }]}>
        {outcome.status === 'shared'
          ? `Archive prepared with ${outcome.included} ${outcome.included === 1 ? 'file' : 'files'}.`
          : 'There’s nothing on this device to export.'}
      </Text>
      <PathList intro="Left out because they couldn’t be read here:" paths={outcome.omitted} />
      <PathList intro="Folders that couldn’t be listed:" paths={outcome.unlistedFolders} />
    </View>
  );
}

export function SettingsScreen() {
  const theme = useTheme();
  const {
    state,
    store,
    refreshing,
    progress,
    lastRefreshAt,
    lastResult,
    failure,
    rebuild,
    chooseFolder,
    switchToAppOwnedFolder,
    recheckAccess,
  } = useLibrary();
  const report = useLibraryReport();

  const [choosing, setChoosing] = useState(false);
  const [chooseMessage, setChooseMessage] = useState<string | null>(null);
  const [rebuildStatus, setRebuildStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<ExportOutcome | null>(null);

  const switchWith = async (action: () => Promise<ChooseFolderResult>) => {
    setChoosing(true);
    setChooseMessage(null);
    setRebuildStatus('idle');
    setExported(null);
    setChooseMessage(chooseMessageOf(await action()));
    setChoosing(false);
  };

  const startRebuild = async () => {
    setRebuildStatus('running');
    await rebuild();
    setRebuildStatus('done');
  };

  const startExport = async () => {
    if (!store) return;
    setExporting(true);
    setExported(null);
    const outcome = await exportLibrary(store);
    setExported(outcome);
    setExporting(false);
    if (outcome.status === 'failed' && outcome.accessMayBeLost) void recheckAccess();
  };

  const rebuilding = rebuildStatus === 'running';
  const progressText = progress ? `${progress.processed} of ${progress.total} notes` : null;
  const activity = rebuilding
    ? `Rebuilding the index${progressText ? `: ${progressText}` : '…'}`
    : refreshing
      ? progressText
        ? `Indexing: ${progressText}`
        : 'Checking for changes…'
      : null;
  const listingMessage = listingMessageOf(lastResult);
  const rebuilt = rebuildStatus === 'done' && !failure && !listingMessage;

  return (
    <ScrollView
      contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.xl }}
      style={{ flex: 1 }}
    >
      <Section title="Library">
        {state.status === 'starting' ? null : (
          <>
            <Row label="Active" value={locationOf(state).name} />
            <Muted>{locationOf(state).place}</Muted>
          </>
        )}
        <Row label="Access" value={accessOf(state)} />
        <Row label="Notes use" value={report ? formatSize(report.notesSize) : '…'} />
        {state.status === 'available' && state.readOnlyMessage ? (
          <Muted>{state.readOnlyMessage}</Muted>
        ) : null}
        {state.status === 'available' && state.notice ? <Muted>{state.notice}</Muted> : null}
        {state.status === 'unavailable' ? <Alerted>{state.message}</Alerted> : null}
        {failure ? <Alerted>{failure.message}</Alerted> : null}
        {activity ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[theme.type.body, { color: theme.colors.text }]}
          >
            {activity}
          </Text>
        ) : null}
        {listingMessage ? <Muted>{listingMessage}</Muted> : null}
      </Section>

      <Section title="Folder">
        <ActionButton
          label={
            state.status === 'unavailable'
              ? 'Reconnect folder'
              : state.status === 'available' && state.root.kind === 'external'
                ? 'Change folder'
                : 'Choose a folder'
          }
          hint="Opens the system folder picker"
          disabled={choosing || state.status === 'starting'}
          onPress={() => void switchWith(chooseFolder)}
        />
        {state.status !== 'starting' && state.root.kind === 'external' ? (
          <ActionButton
            label="Switch to Roamlet’s own folder"
            hint="Your chosen folder is left as it is"
            disabled={choosing}
            onPress={() => void switchWith(switchToAppOwnedFolder)}
          />
        ) : null}
        {chooseMessage ? <Alerted>{chooseMessage}</Alerted> : null}
        <Muted>{PROVIDER_GUIDANCE}</Muted>
        <Muted>{STAY_BEHIND_NOTE}</Muted>
      </Section>

      <Section title="Maintenance">
        <ActionButton
          label="Export library"
          hint="Shares a zip archive of your notes"
          disabled={!store || exporting}
          onPress={() => void startExport()}
        />
        {exporting ? (
          <Text accessibilityLiveRegion="polite" style={[theme.type.body, { color: theme.colors.text }]}>
            Preparing the archive…
          </Text>
        ) : null}
        {exported ? <ExportSummary outcome={exported} /> : null}
        <ActionButton
          label="Rebuild Index"
          hint="Reads every note again. Your notes aren’t changed."
          disabled={state.status !== 'available' || rebuilding}
          onPress={() => void startRebuild()}
        />
        {rebuilt ? <Muted>Index rebuilt.</Muted> : null}
      </Section>

      <Section title="Statistics">
        <Row label="Files" value={report ? String(report.counts.files) : '…'} />
        <Row label="Nodes" value={report ? String(report.counts.nodes) : '…'} />
        <Row label="Links" value={report ? String(report.counts.links) : '…'} />
        <Row
          label="Last refresh"
          value={lastRefreshAt ? lastRefreshAt.toLocaleString() : 'Not yet since opening the app'}
        />
      </Section>

      <Section title="Diagnostics">
        {report ? <Diagnostics report={report} /> : <Muted>Not available until the index opens.</Muted>}
      </Section>
    </ScrollView>
  );
}
