import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { conflictCopyNotePath, LibraryIndex } from '../../src/core/index';
import { MemoryFileStore } from '../support/memory-file-store';
import { useIndexHost } from './index-helpers';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';
const ID_H = '00000000-0000-4000-8000-00000000000d';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

const FIXTURES = join(__dirname, '..', 'fixtures');
const FIXTURE_NOTE_ID = '00000000-0000-4000-8000-000000000054';
const FIXTURE_DROPBOX_COPY = "note (Laptop's conflicted copy 2026-01-15).org";
const FIXTURE_SYNCTHING_COPY = 'note.sync-conflict-20260115-093000-ABCDEFG.org';

function note(id: string, title: string, body = ''): string {
  return `:PROPERTIES:\n:ID:       ${id}\n:END:\n#+title: ${title}\n\n${body}\n`;
}

function fixture(name: string): Uint8Array {
  return readFileSync(join(FIXTURES, name));
}

describe('index queries', () => {
  const env = useIndexHost();
  let index: LibraryIndex;

  beforeEach(async () => {
    index = await LibraryIndex.open(env.host, 'lib');
  });
  afterEach(() => index.close());

  describe('folder tree', () => {
    it('Browsing folders: root shows folders and notes, opening a folder shows its notes', async () => {
      await index.reconcile(
        new MemoryFileStore({
          'daily/2026-01-02.org': note(ID_A, 'January second'),
          '20260101-idea.org': note(ID_B, 'Idea'),
          'daily/deep/er/old.org': note(ID_C, 'Old'),
        }),
      );

      const root = await index.listFolder('');
      expect(root.folders).toEqual([{ path: 'daily', name: 'daily' }]);
      expect(root.files.map((file) => [file.path, file.title])).toEqual([
        ['20260101-idea.org', 'Idea'],
      ]);

      const daily = await index.listFolder('daily');
      expect(daily.folders).toEqual([{ path: 'daily/deep', name: 'deep' }]);
      expect(daily.files.map((file) => file.name)).toEqual(['2026-01-02.org']);

      const deep = await index.listFolder('daily/deep');
      expect(deep.folders).toEqual([{ path: 'daily/deep/er', name: 'er' }]);
      expect(deep.files).toEqual([]);
    });

    it('does not take a folder sharing a name prefix for a subfolder', async () => {
      await index.reconcile(
        new MemoryFileStore({
          'daily/a.org': 'text',
          'daily-old/b.org': 'text',
          'daily0/c.org': 'text',
        }),
      );

      expect((await index.listFolder('daily')).folders).toEqual([]);
      expect((await index.listFolder('')).folders.map((folder) => folder.name)).toEqual([
        'daily',
        'daily-old',
        'daily0',
      ]);
    });

    it('hides folders with no notes, and needs no listing while browsing', async () => {
      const store = new MemoryFileStore({
        'a.org': 'text',
        'attachments/image.png': 'bytes',
        'conflicts/a.org.conflict-20260115093000': 'text',
      });
      store.mkdir('empty');
      await index.reconcile(store);
      store.failOperation('list');
      store.calls = [];

      const root = await index.listFolder('');

      expect(root.folders).toEqual([]);
      expect(store.calls).toEqual([]);
    });

    it('Mixed library: marks no-ID and not-downloaded files apart from notes', async () => {
      const store = new MemoryFileStore({
        'id.org': note(ID_A, 'With ID'),
        'no-id.org': '#+title: Without ID\nText\n',
        'cloud.org': note(ID_B, 'Cloud'),
      });
      store.setDownloaded('cloud.org', false);
      await index.reconcile(store);

      const files = (await index.listFolder('')).files;
      const marks = files.map((file) => [file.path, file.hasNodes, file.contentIndexed, file.status]);
      expect(marks).toEqual([
        ['cloud.org', false, false, 'not_downloaded'],
        ['id.org', true, true, 'ok'],
        ['no-id.org', false, true, 'ok'],
      ]);
    });

    it('Matching the real folder: a moved file shows at its new location', async () => {
      const store = new MemoryFileStore({ 'a.org': 'text' });
      await index.reconcile(store);
      store.rename('a.org', 'moved/a.org');
      await index.reconcile(store);

      expect((await index.listFolder('')).files).toEqual([]);
      expect((await index.listFolder('moved')).files.map((file) => file.path)).toEqual(['moved/a.org']);
    });

    it('Empty library: nothing to list', async () => {
      await index.reconcile(new MemoryFileStore());
      expect(await index.listFolder('')).toEqual({ folders: [], files: [] });
      expect(await index.counts()).toEqual({ files: 0, nodes: 0, links: 0 });
    });
  });

  describe('Indexed content', () => {
    it('Scenario: File without nodes — indexed and searchable', async () => {
      await index.reconcile(new MemoryFileStore({ 'plain.org': '#+title: Plain\nfindable words\n' }));

      expect(await index.getFile('plain.org')).toMatchObject({ title: 'Plain', hasNodes: false });
      expect((await index.search('findable'))[0]).toMatchObject({
        filePath: 'plain.org',
        nodeId: null,
        title: 'Plain',
      });
      expect((await index.problems()).filesWithoutIds).toEqual(['plain.org']);
    });

    it('records tags, inherited ones included, with level and position', async () => {
      const text = `#+filetags: :top:\n:PROPERTIES:\n:ID: ${ID_A}\n:END:\n`;
      const heading = `#+title: T\n#+filetags: :top:\n* One :a:\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\n`;
      await index.reconcile(new MemoryFileStore({ 'x.org': text, 'y.org': heading }));

      expect(await index.resolveLink(ID_H)).toEqual({
        id: ID_H,
        filePath: 'y.org',
        level: 1,
        title: 'One',
        tags: ['top', 'a'],
        startOffset: heading.indexOf('* One'),
      });
    });
  });

  describe('links', () => {
    beforeEach(async () => {
      await index.reconcile(
        new MemoryFileStore({
          'a.org': `${note(ID_A, 'A', `To b: [[id:${ID_B}][desc]], gone: [[id:${MISSING}]]`)}* H\n:PROPERTIES:\n:ID: ${ID_H}\n:END:\nHeading to b: [[id:${ID_B}]]\n`,
          'b.org': note(ID_B, 'B', `To the heading: [[id:${ID_H}][there]]`),
          'c.org': note(ID_C, 'C'),
          'nodeless.org': `Text with a link to [[id:${ID_C}][c]] and no node.\n`,
        }),
      );
    });

    it('Viewing backlinks: every linking node, with its description and position', async () => {
      const links = await index.backlinks(ID_B);

      expect(links.map((link) => [link.source.id, link.source.filePath, link.description])).toEqual([
        [ID_A, 'a.org', 'desc'],
        [ID_H, 'a.org', null],
      ]);
      expect(links[0].targetId).toBe(ID_B);
      expect(links[0].startOffset).toBeGreaterThan(0);
    });

    it('No backlinks: an empty list', async () => {
      expect(await index.backlinks(ID_A)).toEqual([]);
    });

    it('a link outside any node is an outgoing link, but no backlink', async () => {
      expect(await index.backlinks(ID_C)).toEqual([]);
      const outgoing = await index.outgoingLinks('nodeless.org');
      expect(outgoing).toEqual([
        {
          sourceId: null,
          targetId: ID_C,
          description: 'c',
          startOffset: expect.any(Number),
          target: expect.objectContaining({ id: ID_C }),
        },
      ]);
    });

    it('collects backlinks to any node of an open file', async () => {
      const links = await index.backlinksForFile('a.org');
      expect(links.map((link) => [link.source.id, link.targetId])).toEqual([[ID_B, ID_H]]);
    });

    it('lists outgoing links in document order, resolved or not', async () => {
      const links = await index.outgoingLinks('a.org');

      expect(links.map((link) => [link.sourceId, link.targetId, link.target?.filePath ?? null])).toEqual([
        [ID_A, ID_B, 'b.org'],
        [ID_A, MISSING, null],
        [ID_H, ID_B, 'b.org'],
      ]);
    });

    it('resolves a heading-level target to its file and position', async () => {
      const target = await index.resolveLink(ID_H);
      expect(target).toMatchObject({ filePath: 'a.org', level: 1, title: 'H' });
      expect(target?.startOffset).toBeGreaterThan(0);
    });

    it('resolves an unknown ID to null', async () => {
      expect(await index.resolveLink(MISSING)).toBeNull();
    });
  });

  it('Target later appears: the link resolves with no change to the linking file', async () => {
    const linking = note(ID_A, 'A', `[[id:${ID_B}][b]]`);
    const store = new MemoryFileStore({ 'a.org': linking });
    await index.reconcile(store);
    expect((await index.problems()).unresolvedLinks).toHaveLength(1);
    store.calls = [];
    store.writeFile('b.org', note(ID_B, 'B'));

    await index.reconcile(store);

    expect((await index.outgoingLinks('a.org'))[0].target?.id).toBe(ID_B);
    expect((await index.problems()).unresolvedLinks).toEqual([]);
    expect(store.calls.some((call) => call.path === 'a.org')).toBe(false);
    expect(store.peekText('a.org')).toBe(linking);
  });

  describe('Data problem reporting', () => {
    it('Scenario: Duplicate IDs — both accessible, reported, unchanged, resolving the same way', async () => {
      const store = new MemoryFileStore({
        'z.org': note(ID_A, 'Later path'),
        'a.org': note(ID_A, 'Earlier path'),
        'links.org': note(ID_B, 'Links', `[[id:${ID_A}]]`),
      });
      const before = store.peekText('z.org');
      await index.reconcile(store);

      const [duplicate] = (await index.problems()).duplicateIds;
      expect(duplicate.id).toBe(ID_A);
      expect(duplicate.nodes.map((node) => node.filePath)).toEqual(['a.org', 'z.org']);
      expect(await index.getFile('z.org')).toMatchObject({ title: 'Later path', status: 'ok' });
      expect((await index.search('Later')).map((hit) => hit.filePath)).toEqual(['z.org']);
      expect(store.peekText('z.org')).toBe(before);

      for (let i = 0; i < 3; i += 1) {
        expect(await index.resolveLink(ID_A)).toMatchObject({ filePath: 'a.org' });
      }
      expect((await index.outgoingLinks('links.org'))[0].target?.filePath).toBe('a.org');
    });

    it('the lowest path wins whatever order files were indexed in', async () => {
      const store = new MemoryFileStore({ 'm.org': note(ID_A, 'Middle') });
      await index.reconcile(store);
      expect(await index.resolveLink(ID_A)).toMatchObject({ filePath: 'm.org' });

      store.writeFile('a.org', note(ID_A, 'First'));
      await index.reconcile(store);
      expect(await index.resolveLink(ID_A)).toMatchObject({ filePath: 'a.org' });

      store.remove('a.org');
      await index.reconcile(store);
      expect(await index.resolveLink(ID_A)).toMatchObject({ filePath: 'm.org' });
    });

    it('a duplicate within one file resolves to the earlier one', async () => {
      await index.reconcile(
        new MemoryFileStore({ 'dup.org': fixture('duplicate-ids-a.org') }),
      );
      const id = '00000000-0000-4000-8000-000000000053';

      expect(await index.resolveLink(id)).toMatchObject({ title: 'Twice in one file' });
      expect((await index.problems()).duplicateIds.map((dup) => dup.id)).toEqual([id]);
    });

    it('Scenario: Sync conflict copy of a note — both accessible, reported, neither changed', async () => {
      const files = {
        'note.org': fixture('note.org'),
        [FIXTURE_DROPBOX_COPY]: fixture(FIXTURE_DROPBOX_COPY),
        [FIXTURE_SYNCTHING_COPY]: fixture(FIXTURE_SYNCTHING_COPY),
      };
      const store = new MemoryFileStore(files);

      await index.reconcile(store);

      const duplicate = (await index.problems()).duplicateIds.find((dup) => dup.id === FIXTURE_NOTE_ID);
      // Paths compare by bytes, and ' ' sorts before '.', so Dropbox's copy is the winner here.
      expect(duplicate?.nodes.map((node) => node.filePath)).toEqual([
        FIXTURE_DROPBOX_COPY,
        'note.org',
        FIXTURE_SYNCTHING_COPY,
      ]);
      expect((await index.listFolder('')).files.map((file) => file.path).sort()).toEqual(
        Object.keys(files).sort(),
      );
      for (const [path, bytes] of Object.entries(files)) expect(store.peek(path)).toEqual(bytes);
    });

    it('Scenario: Unreadable file — reported, and all other files are indexed', async () => {
      const store = new MemoryFileStore({
        'a.org': note(ID_A, 'A'),
        'bad.org': note(ID_B, 'Bad'),
        'c.org': note(ID_C, 'C'),
      });
      store.failOperation('readBytes', { path: 'bad.org', kind: 'provider_error' });

      const result = await index.reconcile(store);

      expect(result.readFailures.map((failure) => failure.path)).toEqual(['bad.org']);
      expect((await index.problems()).unreadable).toEqual(['bad.org']);
      expect(await index.getFile('bad.org')).toMatchObject({
        status: 'unreadable',
        contentIndexed: false,
        title: 'bad',
      });
      expect(await index.resolveLink(ID_A)).not.toBeNull();
      expect(await index.resolveLink(ID_C)).not.toBeNull();
    });

    it('reports invalid UTF-8 without decoding it, whichever state it was in before', async () => {
      const invalid = new Uint8Array([0x23, 0x2b, 0xff, 0xfe, 0x0a]);
      const store = new MemoryFileStore({ 'bad.org': note(ID_A, 'Valid at first') });
      await index.reconcile(store);
      store.writeFile('bad.org', invalid);

      await index.reconcile(store);

      const problems = await index.problems();
      expect(problems.invalidUtf8).toEqual(['bad.org']);
      expect(problems.filesWithoutIds).toEqual([]);
      expect(await index.resolveLink(ID_A)).toBeNull();
      expect(await index.search('Valid')).toEqual([]);
      expect((await index.listFolder('')).files[0]).toMatchObject({
        title: 'bad',
        status: 'invalid_utf8',
        contentIndexed: false,
      });
      expect(store.peek('bad.org')).toEqual(invalid);

      store.calls = [];
      await index.reconcile(store);
      expect(store.calls).toEqual([{ op: 'list' }]);

      store.setMtime('bad.org', Date.UTC(2027, 0, 1));
      await index.reconcile(store);
      expect((await index.problems()).invalidUtf8).toEqual(['bad.org']);

      store.setDownloaded('bad.org', false);
      await index.reconcile(store);
      store.setDownloaded('bad.org', true);
      await index.reconcile(store);
      expect((await index.problems()).invalidUtf8).toEqual(['bad.org']);
    });

    it('reports unresolved links, files without IDs, and counts for a whole library', async () => {
      await index.reconcile(
        new MemoryFileStore({
          'broken.org': fixture('broken-links.org'),
          'plain.org': 'no id here\n',
          'loose.org': `Loose [[id:${MISSING}][gone]]\n`,
        }),
      );

      const problems = await index.problems();
      expect(problems.filesWithoutIds).toEqual(['loose.org', 'plain.org']);
      const unresolved = problems.unresolvedLinks.filter((link) => link.targetId.endsWith('999999999999'));
      expect(unresolved).toEqual([
        expect.objectContaining({ filePath: 'broken.org', description: 'gone' }),
      ]);
      expect(problems.unresolvedLinks).toContainEqual(
        expect.objectContaining({ filePath: 'loose.org', sourceId: null, targetId: MISSING }),
      );
      expect(await index.counts()).toMatchObject({ files: 3, nodes: 1 });
    });

    it('does not block the rest of the library for any fixture', async () => {
      const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.org'));
      const store = new MemoryFileStore(
        Object.fromEntries(names.map((name) => [name, fixture(name)])),
      );

      const result = await index.reconcile(store);

      expect(result.added).toHaveLength(names.length);
      expect((await index.counts()).files).toBe(names.length);
      const uniquePaths = new Set((await index.listFolder('')).files.map((file) => file.path));
      expect(uniquePaths.size).toBe(names.length);
    });
  });

  describe('conflict copies', () => {
    it('lists Roamlet conflict copies with the note each came from, without indexing them', async () => {
      const store = new MemoryFileStore({
        'note.org': note(ID_A, 'Note'),
        'note.org.conflict-20260115093000': note(ID_A, 'Conflict copy text'),
        'sub/other.org.conflict-20260116101500': 'text',
        'unrelated.conflict-20260115093000': 'text',
        'image.png': 'bytes',
      });

      await index.reconcile(store);

      const copies = await index.conflictCopies();
      expect(copies).toEqual([
        {
          path: 'note.org.conflict-20260115093000',
          notePath: 'note.org',
          size: expect.any(Number),
          mtime: expect.any(Number),
        },
        {
          path: 'sub/other.org.conflict-20260116101500',
          notePath: 'sub/other.org',
          size: 4,
          mtime: expect.any(Number),
        },
      ]);
      expect((await index.problems()).duplicateIds).toEqual([]);
      expect((await index.search('Conflict')).length).toBe(0);
      expect(await index.counts()).toMatchObject({ files: 1, nodes: 1 });
      expect((await index.listFolder('')).files.map((file) => file.path)).toEqual(['note.org']);
      expect(store.calls.some((call) => call.path?.includes('conflict'))).toBe(false);
    });

    it('follows copies appearing, changing, and going away', async () => {
      const store = new MemoryFileStore({ 'note.org': 'text' });
      await index.reconcile(store);
      expect(await index.conflictCopies()).toEqual([]);

      store.writeFile('note.org.conflict-20260115093000', 'one');
      await index.reconcile(store);
      expect((await index.conflictCopies()).map((copy) => copy.size)).toEqual([3]);

      store.writeFile('note.org.conflict-20260115093000', 'longer');
      await index.reconcile(store);
      expect((await index.conflictCopies()).map((copy) => copy.size)).toEqual([6]);

      store.remove('note.org.conflict-20260115093000');
      await index.reconcile(store);
      expect(await index.conflictCopies()).toEqual([]);
    });

    it('recognizes only names shaped like a conflict copy', () => {
      const stamp = '20260115093000';
      expect(conflictCopyNotePath(`note.org.conflict-${stamp}`)).toBe('note.org');
      expect(conflictCopyNotePath(`a/b/note.org.conflict-${stamp}-2`)).toBe('a/b/note.org');
      expect(conflictCopyNotePath('note.org')).toBeNull();
      expect(conflictCopyNotePath('note.org.conflict-')).toBeNull();
      expect(conflictCopyNotePath('note.org.conflict-1')).toBeNull();
      expect(conflictCopyNotePath(`note.txt.conflict-${stamp}`)).toBeNull();
      expect(conflictCopyNotePath(`note.org.conflict-${stamp}.org`)).toBeNull();
      expect(conflictCopyNotePath(`a.org.conflict-${stamp}/note.txt`)).toBeNull();
      expect(conflictCopyNotePath(`.note.org.conflict-${stamp}`)).toBeNull();
      expect(conflictCopyNotePath('note.sync-conflict-20260115-093000-ABCDEFG.org')).toBeNull();
    });
  });
});
