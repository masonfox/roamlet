import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildScenario, readOrgFiles, SCENARIOS } from './round-trip';

const FIXTURES = join(__dirname, '..', 'fixtures');
const output = process.env.ROUND_TRIP_DIR;

// Not a check. Core's imports only resolve under Jest, so this is how CI runs the scripted edits, and
// Emacs then syncs the result (.github/workflows/conformance.yml). The checks are in
// test/core/conformance-round-trip.test.ts.
const describeWithOutput = output ? describe : describe.skip;

describeWithOutput('writing the round-trip corpus', () => {
  it.each(SCENARIOS)('writes %s', (name) => {
    const directory = join(output!, name);
    mkdirSync(directory, { recursive: true });
    const { files } = buildScenario(name, readOrgFiles(FIXTURES));
    for (const [file, bytes] of Object.entries(files)) {
      writeFileSync(join(directory, file), bytes);
    }
  });
});
