package com.roamlet.fs

import android.content.ContentResolver
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

// Providers may answer a child query with what they have so far and fetch the rest. That must not
// look like a complete listing, or reconcile would treat the missing files as deleted (Decision 5).
private const val LOADING_RETRIES = 20
private const val LOADING_WAIT_MS = 500L

// Neutral, so providers have no reason to add an extension (Decision 4).
private const val NEUTRAL_MIME_TYPE = "application/octet-stream"

private val COLUMNS = arrayOf(
  Document.COLUMN_DOCUMENT_ID,
  Document.COLUMN_DISPLAY_NAME,
  Document.COLUMN_MIME_TYPE,
  Document.COLUMN_SIZE,
  Document.COLUMN_LAST_MODIFIED,
  Document.COLUMN_FLAGS,
)

/** An external folder, through a persisted tree grant. */
internal class SafBackend(
  private val resolver: ContentResolver,
  private val treeUri: Uri,
  private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) : LibraryBackend {
  private fun uriOf(ref: String): Uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, ref)

  override fun root(): Doc = query(uriOf(DocumentsContract.getTreeDocumentId(treeUri)))

  override fun children(dir: Doc): List<Doc> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dir.ref)
    repeat(LOADING_RETRIES + 1) { attempt ->
      if (attempt > 0) sleep(LOADING_WAIT_MS)
      val cursor = resolver.query(uri, COLUMNS, null, null, null)
        ?: throw IOException("provider returned no cursor for ${dir.name}")
      cursor.use {
        val extras = it.extras
        extras?.getString(DocumentsContract.EXTRA_ERROR)?.let { error -> throw IOException(error) }
        if (extras?.getBoolean(DocumentsContract.EXTRA_LOADING) != true) {
          return generateSequence { if (it.moveToNext()) it.toDoc() else null }.toList()
        }
      }
    }
    throw IOException("provider is still loading ${dir.name}")
  }

  override fun create(dir: Doc, name: String): Doc {
    val uri = DocumentsContract.createDocument(resolver, uriOf(dir.ref), NEUTRAL_MIME_TYPE, name)
      ?: throw IOException("provider did not create $name")
    return query(uriOf(DocumentsContract.getDocumentId(uri)))
  }

  override fun rename(doc: Doc, name: String): Doc {
    // A null result means the document kept its id or, for old target SDKs, that the rename failed.
    // Querying covers both, because the caller checks the name either way.
    val renamed = DocumentsContract.renameDocument(resolver, uriOf(doc.ref), name)
    return query(if (renamed != null) uriOf(DocumentsContract.getDocumentId(renamed)) else uriOf(doc.ref))
  }

  override fun delete(doc: Doc) {
    if (!DocumentsContract.deleteDocument(resolver, uriOf(doc.ref))) {
      throw IOException("provider did not delete ${doc.name}")
    }
  }

  override fun openRead(doc: Doc): InputStream =
    resolver.openInputStream(uriOf(doc.ref)) ?: throw IOException("provider did not open ${doc.name}")

  override fun write(doc: Doc, bytes: ByteArray) {
    val output = resolver.openOutputStream(uriOf(doc.ref), "wt")
      ?: throw IOException("provider did not open ${doc.name}")
    output.use {
      it.write(bytes)
      it.flush()
      syncIfPossible(it)
    }
  }

  private fun query(uri: Uri): Doc {
    val cursor = resolver.query(uri, COLUMNS, null, null, null)
      ?: throw IOException("provider returned no cursor")
    return cursor.use {
      if (!it.moveToFirst()) throw FileNotFoundException("no document at $uri")
      it.toDoc()
    }
  }
}

private fun syncIfPossible(output: OutputStream) {
  try {
    (output as? FileOutputStream)?.fd?.sync()
  } catch (_: IOException) {
    // Pipes and some provider descriptors can't be synced. The read-back still checks the content.
  }
}

private fun Cursor.toDoc(): Doc {
  val flags = getInt(getColumnIndexOrThrow(Document.COLUMN_FLAGS))
  val sizeColumn = getColumnIndexOrThrow(Document.COLUMN_SIZE)
  val mtimeColumn = getColumnIndexOrThrow(Document.COLUMN_LAST_MODIFIED)
  return Doc(
    ref = getString(getColumnIndexOrThrow(Document.COLUMN_DOCUMENT_ID)),
    name = getString(getColumnIndexOrThrow(Document.COLUMN_DISPLAY_NAME)),
    isDir = getString(getColumnIndexOrThrow(Document.COLUMN_MIME_TYPE)) == Document.MIME_TYPE_DIR,
    size = if (isNull(sizeColumn)) 0 else getLong(sizeColumn),
    mtime = if (isNull(mtimeColumn)) 0 else getLong(mtimeColumn),
    canWrite = flags and Document.FLAG_SUPPORTS_WRITE != 0,
    canRename = flags and Document.FLAG_SUPPORTS_RENAME != 0,
    canDelete = flags and Document.FLAG_SUPPORTS_DELETE != 0,
    canCreate = flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0,
  )
}
