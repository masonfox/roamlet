// Throwaway screen for tasks 1.6 and 1.7: pick a folder, list it, and replace a file with exact
// bytes, on a real device. Task 1.12 deletes it. Open it with the roamlet:///spike link.

import { useState } from 'react';
import { Button, FlatList, Pressable, ScrollView, Text, View } from 'react-native';

import { RoamletFs, type FileEntry, type LibraryRoot } from '../modules/roamlet-fs';

// A BOM, CRLF, an accented character, and an emoji: anything that re-encodes would change these.
const TEST_BYTES = Uint8Array.from([
  0xef, 0xbb, 0xbf, 0x23, 0x2b, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3a, 0x20, 0x73, 0x70, 0x69, 0x6b,
  0x65, 0x0d, 0x0a, 0x0d, 0x0a, 0x63, 0x61, 0x66, 0xc3, 0xa9, 0x20, 0xf0, 0x9f, 0xa6, 0x8a, 0x0d,
  0x0a,
]);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function Spike() {
  const [root, setRoot] = useState<LibraryRoot>({ kind: 'app_owned' });
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const say = (line: string) => setLog((lines) => [line, ...lines]);

  const run = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      say(`${label} rejected: ${String(error)}`);
    }
  };

  const list = async (target: LibraryRoot) => {
    const started = Date.now();
    const result = await RoamletFs.list(target);
    setEntries(result.entries);
    say(
      `list: ${result.entries.length} entries, ${result.failures.length} failures, ` +
        `${Date.now() - started} ms ${JSON.stringify(result.failures)}`
    );
  };

  const pick = () =>
    run('pick', async () => {
    const result = await RoamletFs.pickFolder();
    say(`pick: ${JSON.stringify(result)}`);
    if (result.status === 'picked') {
      setRoot(result.root);
      await list(result.root);
    }
  });

  const restoreAndRecover = () =>
    run('restore', async () => {
    say(`restore: ${JSON.stringify(await RoamletFs.restore(root))}`);
    say(`recover: ${JSON.stringify(await RoamletFs.recover(root))}`);
    await list(root);
  });

  const create = () =>
    run('create', async () => {
    const path = `spike-${Date.now()}.org`;
    say(`create ${path}: ${JSON.stringify(await RoamletFs.createExclusive(root, path, TEST_BYTES))}`);
    say(`create again: ${JSON.stringify(await RoamletFs.createExclusive(root, path, TEST_BYTES))}`);
    await list(root);
  });

  const replace = (entry: FileEntry) =>
    run('replace', async () => {
      const before = await RoamletFs.digest(root, entry.path);
      if (!before.ok) {
        say(`digest: ${JSON.stringify(before)}`);
        return;
      }
      const result = await RoamletFs.replaceFile(root, entry.path, TEST_BYTES, before.hash);
      say(`replace ${entry.path}: ${JSON.stringify(result)}`);

      const after = await RoamletFs.readBytes(root, entry.path);
      say(`exact bytes: ${after.ok ? sameBytes(after.bytes, TEST_BYTES) : JSON.stringify(after)}`);
      const stale = await RoamletFs.replaceFile(root, entry.path, TEST_BYTES, before.hash);
      say(`replace with the old hash: ${stale.status}`);

      const names = (await RoamletFs.list(root)).entries.map((item) => item.path);
      say(`exact name: ${names.includes(entry.path)}`);
      say(`leftovers: ${JSON.stringify(names.filter((name) => name.includes('.roamlet-')))}`);
      await list(root);
    });

  return (
    <View style={{ flex: 1, padding: 16, gap: 8 }}>
      <Text>Root: {root.kind === 'external' ? root.name : 'app-owned'}</Text>
      <Text>Internal: {RoamletFs.internalDirectory()}</Text>
      <Button title="Pick folder" onPress={pick} />
      <Button title="Restore, recover, and list" onPress={restoreAndRecover} />
      <Button title="Create a test file" onPress={create} />
      <Text>Tap a file to replace it with the test bytes. This overwrites it.</Text>
      <FlatList
        style={{ flex: 1 }}
        data={entries.filter((entry) => !entry.isDir)}
        keyExtractor={(entry) => entry.path}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => replace(item)} style={{ padding: 8 }}>
            <Text>
              {item.path} ({item.size} bytes)
            </Text>
          </Pressable>
        )}
      />
      <ScrollView style={{ flex: 1 }}>
        {log.map((line, index) => (
          <Text key={log.length - index} selectable>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
