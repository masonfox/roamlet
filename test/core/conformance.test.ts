import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AllowlistEntry, OracleDump } from '../emacs/compare';
import { compare, diff, scanFiles } from '../emacs/compare';

const FIXTURES = join(__dirname, '..', 'fixtures');
const ALLOWLIST = join(__dirname, '..', 'emacs', 'allowlist.json');
const oraclePath = process.env.ORACLE_JSON;

// Emacs runs only in CI (.github/workflows/conformance.yml), which sets ORACLE_JSON.
const describeWithOracle = oraclePath ? describe : describe.skip;

describeWithOracle('conformance with Emacs Org-roam', () => {
  it('matches the oracle on the corpus, except for listed differences', () => {
    const oracle: OracleDump = JSON.parse(readFileSync(oraclePath!, 'utf8'));
    const allowlist: AllowlistEntry[] = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
    const files = Object.fromEntries(
      readdirSync(FIXTURES)
        .filter((name) => name.endsWith('.org'))
        .map((name) => [name, readFileSync(join(FIXTURES, name)).toString('utf8')]),
    );
    expect(compare(diff(oracle, scanFiles(files)), allowlist)).toEqual({
      unexpected: [],
      stale: [],
      unjustified: [],
    });
  });
});
