import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeSqlDatabaseHost } from '../support/node-sql-driver';

export interface IndexHostEnv {
  host: NodeSqlDatabaseHost;
}

/**
 * Gives each test a fresh directory of databases. All are removed after the suite, once tests'
 * own `afterEach` hooks have closed their connections: Windows won't delete an open database.
 */
export function useIndexHost(): IndexHostEnv {
  const env = {} as IndexHostEnv;
  let base: string;
  let count = 0;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'roamlet-index-'));
  });
  beforeEach(() => {
    const directory = join(base, String(count++));
    mkdirSync(directory);
    env.host = new NodeSqlDatabaseHost(directory);
  });
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  return env;
}
