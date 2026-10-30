package com.roamlet.fs

import java.io.IOException
import java.io.InputStream

/** A file or folder in a library, as the backend last saw it. */
internal data class Doc(
  /** A document id or an absolute path. Only valid for the backend that made it. */
  val ref: String,
  val name: String,
  val isDir: Boolean,
  val size: Long,
  val mtime: Long,
  val canWrite: Boolean,
  val canRename: Boolean,
  val canDelete: Boolean,
  /** For folders: new documents can be created inside. */
  val canCreate: Boolean,
)

/**
 * What the save protocol needs from a root. Two implementations, so external and app-owned folders
 * share one code path (Decision 10). Failures are thrown; [RoamletLibrary] turns them into results.
 */
internal interface LibraryBackend {
  fun root(): Doc
  fun children(dir: Doc): List<Doc>

  /** Creates an empty file. The returned name may differ from [name]: callers must check. */
  fun create(dir: Doc, name: String): Doc

  /** The returned name may differ from [name], and the returned ref may differ from [doc]'s. */
  fun rename(doc: Doc, name: String): Doc
  fun delete(doc: Doc)
  fun openRead(doc: Doc): InputStream

  /** Replaces the whole content, truncating. Providers may not honor that, so callers read back. */
  fun write(doc: Doc, bytes: ByteArray)
}

/** The provider stored something under a name we didn't ask for, and it couldn't be corrected. */
internal class NameChangedException(message: String) : IOException(message)
