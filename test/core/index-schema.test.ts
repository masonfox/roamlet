import { writeFileSync } from 'node:fs';

import { indexDatabaseName, openIndexDatabase, SCHEMA_VERSION } from '../../src/core/index/schema';
import type { SqlDriver } from '../../src/core/ports';
import { NodeSqlDriver } from '../support/node-sql-driver';
import { useIndexHost } from './index-helpers';

const NAME = 'index-test.db';

describe('Node SqlDriver', () => {
  const env = useIndexHost();
  let db: SqlDriver;

  beforeEach(async () => {
    db = new NodeSqlDriver(env.host.pathOf('driver.db'));
    await db.exec('CREATE TABLE t (v TEXT)');
  });
  afterEach(() => db.close());

  it('runs, reads, and reports changes and rowids', async () => {
    expect(await db.run('INSERT INTO t VALUES (?)', ['a'])).toEqual({ changes: 1, lastInsertRowId: 1 });
    expect(await db.all('SELECT v FROM t')).toEqual([{ v: 'a' }]);
    expect(await db.get('SELECT v FROM t')).toEqual({ v: 'a' });
    expect(await db.get('SELECT v FROM t WHERE v = ?', ['b'])).toBeNull();
  });

  it('commits when the work resolves', async () => {
    const result = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await db.all('SELECT v FROM t')).toEqual([{ v: 'a' }]);
  });

  it('rolls back and rejects when the work rejects', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.all('SELECT v FROM t')).toEqual([]);
  });

  it('hides uncommitted work from other statements', async () => {
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
      expect(await db.all('SELECT v FROM t')).toEqual([]);
      expect(await tx.all('SELECT v FROM t')).toEqual([{ v: 'a' }]);
    });
  });

  it('queues concurrent transactions', async () => {
    const order: string[] = [];
    const slow = db.transaction(async (tx) => {
      order.push('first starts');
      await tx.run('INSERT INTO t VALUES (?)', ['a']);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('first ends');
    });
    const quick = db.transaction(async () => {
      order.push('second');
    });
    await Promise.all([slow, quick]);
    expect(order).toEqual(['first starts', 'first ends', 'second']);
  });

  it('refuses a transaction executor used after its transaction', async () => {
    let leaked: Parameters<Parameters<SqlDriver['transaction']>[0]>[0] | undefined;
    await db.transaction(async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.all('SELECT v FROM t')).rejects.toThrow('after its transaction');
  });

  it('has fts5 with diacritic folding', async () => {
    await db.exec(`CREATE VIRTUAL TABLE s USING fts5(a, tokenize="unicode61 remove_diacritics 2")`);
    await db.run('INSERT INTO s (a) VALUES (?)', ['Café']);
    expect(await db.all(`SELECT a FROM s WHERE s MATCH 'cafe*'`)).toEqual([{ a: 'Café' }]);
  });
});

describe('index database', () => {
  const env = useIndexHost();

  async function userVersion(db: SqlDriver): Promise<number> {
    const row = await db.get<{ user_version: number }>('PRAGMA user_version');
    return row!.user_version;
  }

  it('creates the schema at the current version', async () => {
    const db = await openIndexDatabase(env.host, NAME);
    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    const tables = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name IN
         ('files', 'nodes', 'node_tags', 'links', 'search', 'search_units', 'conflict_copies')
       ORDER BY name`,
    );
    expect(tables.map((table) => table.name)).toEqual([
      'conflict_copies',
      'files',
      'links',
      'node_tags',
      'nodes',
      'search',
      'search_units',
    ]);
    await db.close();
  });

  it('keeps a database at the current version', async () => {
    const first = await openIndexDatabase(env.host, NAME);
    await first.run(
      `INSERT INTO files (path, parent, name, size, mtime, status, title)
       VALUES ('a.org', '', 'a.org', 1, 1, 'ok', 'A')`,
    );
    await first.close();

    const second = await openIndexDatabase(env.host, NAME);
    expect(await second.all('SELECT path FROM files')).toEqual([{ path: 'a.org' }]);
    await second.close();
  });

  it('Scenario: Index format change — a mismatched user_version recreates the database', async () => {
    const first = await openIndexDatabase(env.host, NAME);
    await first.run(
      `INSERT INTO files (path, parent, name, size, mtime, status, title)
       VALUES ('a.org', '', 'a.org', 1, 1, 'ok', 'A')`,
    );
    await first.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    await first.close();

    const second = await openIndexDatabase(env.host, NAME);
    expect(await userVersion(second)).toBe(SCHEMA_VERSION);
    expect(await second.all('SELECT path FROM files')).toEqual([]);
    await second.close();
  });

  it('recreates a database left with no schema version', async () => {
    const raw = await env.host.open(NAME);
    await raw.exec('CREATE TABLE files (unrelated TEXT)');
    await raw.close();

    const db = await openIndexDatabase(env.host, NAME);
    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    expect(await db.all('SELECT path FROM files')).toEqual([]);
    await db.close();
  });

  it('recreates a database at the current version that lacks a table', async () => {
    const raw = await env.host.open(NAME);
    await raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    await raw.close();

    const db = await openIndexDatabase(env.host, NAME);
    expect(await db.all('SELECT path FROM files')).toEqual([]);
    await db.close();
  });

  it('Scenario: Index missing — an unreadable file is replaced', async () => {
    writeFileSync(env.host.pathOf(NAME), 'this is not a sqlite database, not even close'.repeat(100));

    const db = await openIndexDatabase(env.host, NAME);
    expect(await userVersion(db)).toBe(SCHEMA_VERSION);
    expect(await db.all('SELECT path FROM files')).toEqual([]);
    await db.close();
  });

  it('names databases per library, and keeps the name a single path segment', () => {
    expect(indexDatabaseName('abc')).toBe('index-abc.db');
    expect(indexDatabaseName('a/b')).toBe('index-a%2Fb.db');
    expect(indexDatabaseName('abc')).not.toBe(indexDatabaseName('abd'));
  });
});
