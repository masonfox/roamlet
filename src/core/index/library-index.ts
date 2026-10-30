import type { SqlDatabaseHost, SqlDriver } from '../ports';
import * as queries from './queries';
import { reconcile, type IndexFileSource, type ReconcileOptions, type ReconcileResult } from './reconcile';
import { indexDatabaseName, openIndexDatabase } from './schema';
import { search, type SearchOptions, type SearchResult } from './search';

/**
 * One library's index. Open one per active library, and close it before switching. Queries read
 * committed data and can run during a reconcile, so results appear as a rebuild progresses.
 */
export class LibraryIndex {
  // Runs one at a time, because a rebuild replaces the database under a reconcile.
  private tail: Promise<unknown> = Promise.resolve();
  private queuedReconcile: Promise<ReconcileResult> | null = null;

  private constructor(
    private readonly host: SqlDatabaseHost,
    private readonly name: string,
    private db: Promise<SqlDriver>,
  ) {}

  /** Opens a library's index, recreating it if it is missing, unreadable, or an older format. */
  static async open(host: SqlDatabaseHost, libraryId: string): Promise<LibraryIndex> {
    const name = indexDatabaseName(libraryId);
    const db = await openIndexDatabase(host, name);
    return new LibraryIndex(host, name, Promise.resolve(db));
  }

  /**
   * Brings the index in line with the files. A call made while one is running gets a single
   * follow-up run, shared with any other such call, so changes the running one may have missed are
   * still picked up. A caller sharing a run gets the result, and its `onProgress` is only used if
   * it was first.
   */
  reconcile(files: IndexFileSource, options?: ReconcileOptions): Promise<ReconcileResult> {
    this.queuedReconcile ??= this.enqueue(async () => {
      this.queuedReconcile = null;
      return reconcile(files, await this.db, options);
    });
    return this.queuedReconcile;
  }

  /**
   * Deletes the database and reconciles against the empty one. If this is interrupted, the next
   * `reconcile` finishes the job, since files already done are unchanged.
   */
  rebuild(files: IndexFileSource, options?: ReconcileOptions): Promise<ReconcileResult> {
    return this.enqueue(async () => {
      const old = await this.db;
      this.db = (async () => {
        await old.close();
        await this.host.delete(this.name);
        return openIndexDatabase(this.host, this.name);
      })();
      return reconcile(files, await this.db, options);
    });
  }

  async close(): Promise<void> {
    await this.tail;
    await (await this.db).close();
  }

  async listFolder(path: string): Promise<queries.FolderListing> {
    return queries.listFolder(await this.db, path);
  }

  async getFile(path: string): Promise<queries.IndexedFile | null> {
    return queries.getFile(await this.db, path);
  }

  async nodesInFile(path: string): Promise<queries.IndexedNode[]> {
    return queries.nodesInFile(await this.db, path);
  }

  async resolveLink(id: string): Promise<queries.IndexedNode | null> {
    return queries.resolveLink(await this.db, id);
  }

  async backlinks(id: string): Promise<queries.Backlink[]> {
    return queries.backlinks(await this.db, id);
  }

  async backlinksForFile(path: string): Promise<queries.Backlink[]> {
    return queries.backlinksForFile(await this.db, path);
  }

  async outgoingLinks(path: string): Promise<queries.OutgoingLink[]> {
    return queries.outgoingLinks(await this.db, path);
  }

  async problems(): Promise<queries.LibraryProblems> {
    return queries.libraryProblems(await this.db);
  }

  async counts(): Promise<queries.LibraryCounts> {
    return queries.libraryCounts(await this.db);
  }

  async notesSize(): Promise<number> {
    return queries.notesSize(await this.db);
  }

  async conflictCopies(): Promise<queries.ConflictCopy[]> {
    return queries.conflictCopies(await this.db);
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    return search(await this.db, query, options);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}
