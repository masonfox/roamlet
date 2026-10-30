import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  SqlDatabaseHost,
  SqlDriver,
  SqlExecutor,
  SqlRunResult,
  SqlValue,
} from '../../src/core/ports';

function plainRow<Row>(row: unknown): Row {
  return { ...(row as object) } as Row;
}

class ConnectionExecutor implements SqlExecutor {
  constructor(protected readonly connection: DatabaseSync) {}

  async exec(sql: string): Promise<void> {
    this.connection.exec(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<SqlRunResult> {
    const result = this.connection.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async all<Row>(sql: string, params: SqlValue[] = []): Promise<Row[]> {
    const rows = this.connection.prepare(sql).all(...(params as SQLInputValue[]));
    return rows.map((row) => plainRow<Row>(row));
  }

  async get<Row>(sql: string, params: SqlValue[] = []): Promise<Row | null> {
    const row = this.connection.prepare(sql).get(...(params as SQLInputValue[]));
    return row === undefined ? null : plainRow<Row>(row);
  }
}

/** Fails on use once its transaction has ended, to catch work that escapes the callback. */
class TransactionExecutor extends ConnectionExecutor {
  ended = false;

  private check(): void {
    if (this.ended) throw new Error('Transaction executor used after its transaction ended');
  }

  async exec(sql: string): Promise<void> {
    this.check();
    return super.exec(sql);
  }

  async run(sql: string, params?: SqlValue[]): Promise<SqlRunResult> {
    this.check();
    return super.run(sql, params);
  }

  async all<Row>(sql: string, params?: SqlValue[]): Promise<Row[]> {
    this.check();
    return super.all<Row>(sql, params);
  }

  async get<Row>(sql: string, params?: SqlValue[]): Promise<Row | null> {
    this.check();
    return super.get<Row>(sql, params);
  }
}

function openConnection(path: string): DatabaseSync {
  const connection = new DatabaseSync(path);
  try {
    connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

/**
 * A `SqlDriver` over `node:sqlite` for core tests. Like the Expo driver, a transaction runs on its
 * own connection and transactions queue, so other statements see only committed data, and a write
 * outside `tx` during a transaction fails with a locked database.
 */
export class NodeSqlDriver extends ConnectionExecutor implements SqlDriver {
  private transactionConnection: DatabaseSync | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    super(openConnection(path));
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.runTransaction(work));
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.queue;
    this.transactionConnection?.close();
    this.connection.close();
  }

  private async runTransaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    this.transactionConnection ??= openConnection(this.path);
    const connection = this.transactionConnection;
    const tx = new TransactionExecutor(connection);
    connection.exec('BEGIN EXCLUSIVE');
    try {
      const result = await work(tx);
      connection.exec('COMMIT');
      return result;
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    } finally {
      tx.ended = true;
    }
  }
}

/** Keeps databases as files in `directory`. */
export class NodeSqlDatabaseHost implements SqlDatabaseHost {
  constructor(private readonly directory: string) {}

  async open(name: string): Promise<SqlDriver> {
    return new NodeSqlDriver(this.pathOf(name));
  }

  async delete(name: string): Promise<void> {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(this.pathOf(name) + suffix, { force: true });
    }
  }

  pathOf(name: string): string {
    return join(this.directory, name);
  }
}
