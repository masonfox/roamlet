import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryFileStore } from '../../test/support/memory-file-store';
import { NodeSqlDatabaseHost } from '../../test/support/node-sql-driver';
import { libraryIdOf } from '../core/library';
import type {
  FileStore,
  LibraryAccess,
  LibraryRecordStore,
  LibraryRoot,
  PickFolderResult,
  RecoverResult,
  RestoreResult,
  SqlDatabaseHost,
  SqlDriver,
} from '../core/ports';
import { LibraryController, type LibraryServices } from './library-controller';

// Not a test file: helpers for tests of anything using the library context, with real SQLite.
// Nothing under app/ imports this, so it never reaches the bundle.

const DAMAGED = 'database disk image is malformed';

/** Behaves like a real database host until `damage`, then fails like a corrupt file. */
export class DamageableDatabaseHost implements SqlDatabaseHost {
  private damaged = false;
  private permanent = false;
  deletes = 0;

  constructor(
    private readonly inner: SqlDatabaseHost,
    private readonly log: string[],
  ) {}

  /** Deleting the database cures it, unless `permanent`, as when storage itself has failed. */
  damage(options: { permanent?: boolean } = {}): void {
    this.damaged = true;
    this.permanent = options.permanent ?? false;
  }

  repair(): void {
    this.damaged = false;
    this.permanent = false;
  }

  async open(name: string): Promise<SqlDriver> {
    this.log.push('index.open');
    if (this.permanent) throw new Error(DAMAGED);
    const driver = await this.inner.open(name);
    const check = () => {
      if (this.damaged) throw new Error(DAMAGED);
    };
    return {
      exec: async (sql) => {
        check();
        return driver.exec(sql);
      },
      run: async (sql, params) => {
        check();
        return driver.run(sql, params);
      },
      all: async <Row>(sql: string, params?: Parameters<SqlDriver['all']>[1]) => {
        check();
        return driver.all<Row>(sql, params);
      },
      get: async <Row>(sql: string, params?: Parameters<SqlDriver['get']>[1]) => {
        check();
        return driver.get<Row>(sql, params);
      },
      transaction: async (work) => {
        check();
        return driver.transaction(work);
      },
      close: () => driver.close(),
    };
  }

  async delete(name: string): Promise<void> {
    this.log.push('index.delete');
    this.deletes += 1;
    if (!this.permanent) this.damaged = false;
    await this.inner.delete(name);
  }
}

export interface TestLibrary {
  controller: LibraryController;
  services: LibraryServices;
  /** The app-owned library's files. */
  store: MemoryFileStore;
  /** Each file store for any root, by library. */
  storeFor(root: LibraryRoot): MemoryFileStore;
  databases: DamageableDatabaseHost;
  /** Platform steps in order: `records.read`, `restore`, `recover`, `index.open`, `list`, … */
  log: string[];
  /** What `restore` answers from now on, for every root. Starts usable and writable. */
  setRestore(answer: RestoreResult): void;
  /** What `recover` answers from now on. Starts as success. */
  setRecover(answer: RecoverResult): void;
  /** What the folder picker gives from now on. Starts as cancelled. */
  setPick(answer: PickFolderResult): void;
  /** Closes the controller and deletes its databases. Call in `afterEach`. */
  dispose(): Promise<void>;
}

/** A controller over an in-memory library and real SQLite, not yet started. */
export function createTestLibrary(
  options: { files?: Record<string, string>; record?: string | null } = {},
): TestLibrary {
  const log: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'roamlet-ui-'));
  const databases = new DamageableDatabaseHost(new NodeSqlDatabaseHost(directory), log);
  const stores = new Map<string, MemoryFileStore>();
  let restoreAnswer: RestoreResult = { status: 'ok', writable: true };
  let recoverAnswer: RecoverResult = { ok: true };
  let pickAnswer: PickFolderResult = { status: 'cancelled' };
  let recordText = options.record ?? null;

  const storeFor = (root: LibraryRoot): MemoryFileStore => {
    const id = libraryIdOf(root);
    let store = stores.get(id);
    if (!store) {
      store = new MemoryFileStore();
      stores.set(id, store);
    }
    return store;
  };
  const store = storeFor({ kind: 'app_owned' });
  for (const [path, content] of Object.entries(options.files ?? {})) store.writeFile(path, content);

  const logged = (inner: MemoryFileStore): FileStore => ({
    list: () => {
      log.push('list');
      return inner.list();
    },
    readBytes: (path) => inner.readBytes(path),
    digest: (path) => inner.digest(path),
    createExclusive: (path, bytes) => inner.createExclusive(path, bytes),
    replaceFile: (path, bytes, hash) => inner.replaceFile(path, bytes, hash),
    requestDownload: (paths) => inner.requestDownload(paths),
  });

  const access: LibraryAccess = {
    pickFolder: async () => pickAnswer,
    restore: async () => {
      log.push('restore');
      return restoreAnswer;
    },
    recover: async () => {
      log.push('recover');
      return recoverAnswer;
    },
    openStore: (root) => logged(storeFor(root)),
  };

  const records: LibraryRecordStore = {
    read: async () => {
      log.push('records.read');
      return { ok: true, text: recordText };
    },
    write: async (text) => {
      recordText = text;
      return { ok: true };
    },
  };

  const services: LibraryServices = {
    access,
    records,
    databases,
    ids: { newId: () => '00000000-0000-4000-8000-000000000000' },
    clock: { now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) },
  };
  const controller = new LibraryController(async () => services);

  return {
    controller,
    services,
    store,
    storeFor,
    databases,
    log,
    setRestore: (answer) => {
      restoreAnswer = answer;
    },
    setRecover: (answer) => {
      recoverAnswer = answer;
    },
    setPick: (answer) => {
      pickAnswer = answer;
    },
    dispose: async () => {
      await controller.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
