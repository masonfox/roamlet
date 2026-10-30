import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type {
  SqlDatabaseHost,
  SqlDriver,
  SqlExecutor,
  SqlRunResult,
  SqlValue,
} from '../core/ports';

function executorOver(db: SQLiteDatabase): SqlExecutor {
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params = []): Promise<SqlRunResult> => {
      const result = await db.runAsync(sql, params);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
    },
    all: <Row>(sql: string, params: SqlValue[] = []) => db.getAllAsync<Row>(sql, params),
    get: <Row>(sql: string, params: SqlValue[] = []) => db.getFirstAsync<Row>(sql, params),
  };
}

/**
 * A `SqlDriver` over `expo-sqlite`. Each transaction gets its own connection from
 * `withExclusiveTransactionAsync`. A second writer would fail with a locked database instead of
 * waiting, so transactions queue here, and WAL mode lets reads continue during one.
 */
class ExpoSqlDriver implements SqlDriver {
  private readonly executor: SqlExecutor;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SQLiteDatabase) {
    this.executor = executorOver(db);
  }

  exec(sql: string): Promise<void> {
    return this.executor.exec(sql);
  }

  run(sql: string, params?: SqlValue[]): Promise<SqlRunResult> {
    return this.executor.run(sql, params);
  }

  all<Row>(sql: string, params?: SqlValue[]): Promise<Row[]> {
    return this.executor.all<Row>(sql, params);
  }

  get<Row>(sql: string, params?: SqlValue[]): Promise<Row | null> {
    return this.executor.get<Row>(sql, params);
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      let result: { value: T } | undefined;
      await this.db.withExclusiveTransactionAsync(async (txn) => {
        result = { value: await work(executorOver(txn)) };
      });
      return (result as { value: T }).value;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async close(): Promise<void> {
    await this.queue;
    await this.db.closeAsync();
  }
}

/** `expo-sqlite` rejects a delete of a missing database, and the port allows one. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}

/** Keeps databases in `directory`, such as `Paths.cache.uri` for the index (Decision 5, A4). */
export class ExpoSqlDatabaseHost implements SqlDatabaseHost {
  constructor(private readonly directory: string) {}

  async open(name: string): Promise<SqlDriver> {
    const db = await openDatabaseAsync(name, undefined, this.directory);
    try {
      await db.execAsync('PRAGMA journal_mode = WAL;');
    } catch (error) {
      await db.closeAsync();
      throw error;
    }
    return new ExpoSqlDriver(db);
  }

  async delete(name: string): Promise<void> {
    try {
      await deleteDatabaseAsync(name, this.directory);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
