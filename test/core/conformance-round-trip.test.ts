import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyEdit } from '../../src/core/library/note';
import { checkIdChanges, editableBody, scan } from '../../src/core/org';
import type { AllowlistEntry, OracleDump, Results } from '../emacs/compare';
import { compare, diff, scanFiles } from '../emacs/compare';
import {
  buildScenario,
  expectedResults,
  firstDifference,
  readOrgFiles,
  SCENARIOS,
  undoTitleEdit,
} from '../emacs/round-trip';

const FIXTURES = join(__dirname, '..', 'fixtures');
const ALLOWLIST = join(__dirname, '..', 'emacs', 'allowlist.json');
const roundTripDir = process.env.ROUND_TRIP_DIR;
const oraclePath = process.env.ORACLE_JSON;

const fixtures = readOrgFiles(FIXTURES);
const fixtureNames = Object.keys(fixtures);
const decode = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

/** Org-roam's database gives the position of each node, which `scanFiles` is compared with instead. */
const withoutPositions = (results: Results): Results => ({
  ...results,
  nodes: results.nodes.map((node) => ({ ...node, pos: 0 })),
});

/** Files whose bytes aren't what the edit should have left, each with the offset of the first wrong byte. */
function byteDifferences(
  actual: Record<string, Uint8Array>,
  expected: Record<string, Uint8Array>,
): string[] {
  const differences: string[] = [];
  for (const file of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if (!actual[file] || !expected[file]) {
      differences.push(`${file} ${actual[file] ? 'is extra' : 'is missing'}`);
      continue;
    }
    const offset = firstDifference(actual[file], expected[file]);
    if (offset !== null) differences.push(`${file} differs at byte ${offset}`);
  }
  return differences.sort();
}

describe('firstDifference', () => {
  it.each([
    ['identical bytes', [1, 2, 3], [1, 2, 3], null],
    ['a changed byte', [1, 2, 3], [1, 9, 3], 1],
    ['a lost trailing byte', [1, 2, 3], [1, 2], 2],
    ['an added trailing byte', [1, 2], [1, 2, 3], 2],
    ['no bytes', [], [], null],
  ])('reports %s', (_name, a, b, offset) => {
    expect(firstDifference(Uint8Array.from(a), Uint8Array.from(b))).toBe(offset);
  });
});

describe('expectedResults', () => {
  const ID = '00000000-0000-4000-8000-000000000001';
  const node = { id: ID, file: 'a.org', level: 0, pos: 1, title: 'A title', tags: [] };
  const before: Results = { files: ['a.org'], nodes: [node], links: [] };
  const none = { titles: {}, newNodes: [], newLinks: [] };

  it('keeps what no edit touched', () => {
    expect(expectedResults(before, none)).toEqual(before);
  });

  it('changes only the title of the file-level node', () => {
    const heading = { ...node, id: 'b', level: 1 };
    const results = expectedResults(
      { ...before, nodes: [node, heading] },
      { ...none, titles: { 'a.org': { from: 'A title', to: 'A title edited' } } },
    );
    expect(results.nodes.map(({ title }) => title)).toEqual(['A title edited', 'A title']);
  });

  it('gives an untitled file its first title', () => {
    const results = expectedResults(
      { ...before, nodes: [{ ...node, title: '' }] },
      { ...none, titles: { 'a.org': { from: '', to: 'New' } } },
    );
    expect(results.nodes[0].title).toBe('New');
  });

  it('flags a node that Org-roam lost and a link that it never found', () => {
    const results = expectedResults(before, {
      ...none,
      newNodes: [{ id: 'new', file: 'b.org', title: 'B' }],
      newLinks: [{ source: ID, dest: 'new' }],
    });
    expect(diff(withoutPositions(results), withoutPositions(before))).toEqual([
      'file-only-in-oracle b.org',
      `link ${ID} -> new oracle=1 scanner=0`,
      'node-only-in-oracle b.org new "B"',
    ]);
  });
});

describe.each(SCENARIOS)('scripted edits: %s', (name) => {
  const scenario = buildScenario(name, fixtures);

  it('leaves every byte outside the edited ranges unchanged', () => {
    expect(byteDifferences(scenario.files, scenario.expected)).toEqual([]);
  });

  it('raises no ID warnings', () => {
    const warnings = fixtureNames.flatMap((file) =>
      checkIdChanges(scan(decode(fixtures[file])), scan(decode(scenario.files[file]))),
    );
    expect(warnings).toEqual([]);
  });
});

describe.each(['body-start', 'body-end', 'title', 'body-and-title'] as const)(
  'coverage of %s',
  (name) => {
    it('edits every fixture', () => {
      const { files } = buildScenario(name, fixtures);
      const unedited = fixtureNames.filter(
        (file) => firstDifference(files[file], fixtures[file]) === null,
      );
      expect(unedited).toEqual([]);
    });
  },
);

describe('a save with both edits', () => {
  it('gives what the save path gives', () => {
    const { files } = buildScenario('body-and-title', fixtures);
    const { effect } = buildScenario('title', fixtures);
    for (const file of fixtureNames) {
      const text = decode(fixtures[file]);
      const body = `Edited by Roamlet.\n${editableBody(text, scan(text))}`;
      const saved = applyEdit(text, { body, title: effect.titles[file].to });
      expect([file, saved]).toEqual([file, decode(files[file])]);
    }
  });
});

// Emacs runs only in CI (.github/workflows/conformance.yml), which sets these.
const describeWithOracle = roundTripDir && oraclePath ? describe : describe.skip;

describeWithOracle.each(SCENARIOS)('round trip through Emacs Org-roam: %s', (name) => {
  const scenario = buildScenario(name, fixtures);
  let before: OracleDump;
  let oracle: OracleDump;
  let onDisk: Record<string, Buffer>;

  // Jest runs the body of a skipped `describe` too, so the files are read here.
  beforeAll(() => {
    before = JSON.parse(readFileSync(oraclePath!, 'utf8'));
    oracle = JSON.parse(readFileSync(join(roundTripDir!, `${name}.json`), 'utf8'));
    onDisk = readOrgFiles(join(roundTripDir!, name));
  });

  it('still holds the expected bytes after the sync', () => {
    expect(byteDifferences(onDisk, scenario.expected)).toEqual([]);
  });

  it('finds the expected nodes and links in Org-roam', () => {
    const expected = expectedResults(before, scenario.effect);
    expect(diff(withoutPositions(expected), withoutPositions(oracle))).toEqual([]);
  });

  it('matches the scanner on the edited files, except for listed differences', () => {
    const allowlist: AllowlistEntry[] = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
    const texts = Object.fromEntries(
      Object.entries(onDisk).map(([file, bytes]) => [file, decode(bytes)]),
    );
    const differences = diff(oracle, scanFiles(texts)).map(undoTitleEdit);
    expect(compare(differences, allowlist)).toEqual({
      unexpected: [],
      stale: scenario.resolved,
      unjustified: [],
    });
  });

  it('reports a backlink on the target of each inserted link', () => {
    const missing = scenario.effect.newLinks.filter(
      ({ source, dest }) =>
        !oracle.backlinks.some((link) => link.source === source && link.dest === dest),
    );
    expect(missing).toEqual([]);
  });

  it('parses each inserted description as written, which reads as the title', () => {
    for (const { file, dest, title, description } of scenario.inserted) {
      const found = oracle.descriptions.filter((link) => link.file === file && link.dest === dest);
      expect([file, found.map((link) => link.description)]).toEqual([file, [description]]);
      expect(description.replaceAll('​', '')).toBe(title);
      const scanned = scan(decode(onDisk[file])).links.filter((link) => link.target === dest);
      expect([file, scanned.map((link) => link.description)]).toEqual([file, [description]]);
    }
  });

  it('agrees with Org-roam on the node and slug of each new note', () => {
    for (const { id, title, fileName } of scenario.created) {
      const node = oracle.nodes.find((candidate) => candidate.id === id);
      expect([fileName, node?.file, node?.title]).toEqual([fileName, fileName, title]);
      expect(fileName).toBe(`20260615103000-${node?.slug}.org`);
    }
  });
});
