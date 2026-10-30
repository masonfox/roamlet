package com.roamlet.fs

import android.database.Cursor
import android.database.MatrixCursor
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException

internal const val FAKE_AUTHORITY = "com.roamlet.fs.fake"
internal const val FAKE_ROOT_ID = "root"

/** How a provider departs from the plain behavior, each seen in or allowed by real providers. */
internal data class Quirks(
  val supportsRename: Boolean = true,
  /** Adds an extension to documents it creates. */
  val alterOnCreate: Boolean = false,
  /** Adds an extension on the first rename to each name ending in `.org`, not on correction. */
  val alterOrgRenameOnce: Boolean = false,
  /** Adds an extension on every rename, so names can't be corrected. */
  val alterEveryRename: Boolean = false,
  /** Gives a document a new id when it's renamed, as path-based providers do. */
  val renameChangesId: Boolean = false,
  /** Makes names unique rather than refusing a name in use, as the Android file provider does. */
  val uniqueNames: Boolean = false,
)

/**
 * A real DocumentsProvider, reached through ContentResolver and DocumentsContract as on a device,
 * with content in real files so descriptors behave. Every provider call is a [FaultPlan] step.
 */
internal class FakeDocumentsProvider : DocumentsProvider() {
  private class Node(
    var id: String,
    var parent: String?,
    var name: String,
    val isDir: Boolean,
    val file: File?,
  )

  var plan = FaultPlan()
  var quirks = Quirks()
  var loadingQueriesLeft = 0
  var childQueries = 0
  var documentQueries = 0
  var refuseChildQueriesOf: String? = null
  lateinit var blobs: File
  private val nodes = mutableMapOf<String, Node>()
  private var nextId = 0
  private val alteredOnce = mutableSetOf<String>()

  fun reset(blobDir: File, newQuirks: Quirks, newPlan: FaultPlan) {
    blobs = blobDir
    quirks = newQuirks
    plan = newPlan
    nodes.clear()
    alteredOnce.clear()
    nextId = 0
    loadingQueriesLeft = 0
    childQueries = 0
    documentQueries = 0
    refuseChildQueriesOf = null
    nodes[FAKE_ROOT_ID] = Node(FAKE_ROOT_ID, null, "Notes", true, null)
  }

  /** Seeds a file, bypassing faults and quirks. Parent folders are made as needed. */
  fun seed(path: String, bytes: ByteArray) {
    var parent = FAKE_ROOT_ID
    val segments = path.split("/")
    for (segment in segments.dropLast(1)) {
      parent = nodes.values.firstOrNull { it.parent == parent && it.name == segment }?.id
        ?: addNode(parent, segment, isDir = true).id
    }
    val node = addNode(parent, segments.last(), isDir = false)
    node.file!!.writeBytes(bytes)
  }

  fun removeRootForTest() {
    nodes.remove(FAKE_ROOT_ID)
  }

  /** Every file in the tree by path, with its bytes. */
  fun snapshot(): Map<String, List<Byte>> =
    nodes.values.filter { !it.isDir }.associate { pathOf(it) to it.file!!.readBytes().toList() }

  fun readSeeded(path: String): ByteArray? =
    nodes.values.firstOrNull { !it.isDir && pathOf(it) == path }?.file?.readBytes()

  private fun pathOf(node: Node): String {
    val segments = generateSequence(node) { current -> current.parent?.let { nodes[it] } }
      .filter { it.id != FAKE_ROOT_ID }.map { it.name }.toList().reversed()
    return segments.joinToString("/")
  }

  private fun addNode(parent: String, name: String, isDir: Boolean): Node {
    val id = "doc-${nextId++}"
    val file = if (isDir) null else File(blobs, id).also { it.createNewFile() }
    return Node(id, parent, name, isDir, file).also { nodes[id] = it }
  }

  private fun node(id: String): Node = nodes[id] ?: throw FileNotFoundException("no document $id")

  private fun nameInUse(parent: String?, name: String) =
    nodes.values.any { it.parent == parent && it.name == name }

  private fun uniqueName(parent: String?, name: String): String {
    val stem = name.substringBeforeLast('.')
    val extension = if ('.' in name) ".${name.substringAfterLast('.')}" else ""
    var counter = 1
    var candidate = "$stem ($counter)$extension"
    while (nameInUse(parent, candidate)) {
      counter += 1
      candidate = "$stem ($counter)$extension"
    }
    return candidate
  }

  /** The name the provider picks, or a refusal when the name is taken. */
  private fun settleName(parent: String?, name: String): String {
    if (!nameInUse(parent, name)) return name
    if (quirks.uniqueNames) return uniqueName(parent, name)
    throw IllegalStateException("$name already exists")
  }

  override fun onCreate() = true

  override fun queryRoots(projection: Array<out String>?): Cursor =
    MatrixCursor(projection ?: arrayOf(Root.COLUMN_ROOT_ID))

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
    plan.step("provider.queryDocument") {
      documentQueries += 1
      MatrixCursor(projection ?: DEFAULT_COLUMNS).also { addRow(it, node(documentId)) }
    }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor = plan.step("provider.queryChildren") {
    childQueries += 1
    if (refuseChildQueriesOf == parentDocumentId) throw SecurityException("refused")
    val cursor = MatrixCursor(projection ?: DEFAULT_COLUMNS)
    if (loadingQueriesLeft > 0) {
      loadingQueriesLeft -= 1
      cursor.extras = Bundle().apply { putBoolean(DocumentsContract.EXTRA_LOADING, true) }
    } else {
      node(parentDocumentId)
      nodes.values.filter { it.parent == parentDocumentId }.forEach { addRow(cursor, it) }
    }
    cursor
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    val writing = mode.contains('w')
    return plan.step(if (writing) "provider.openWrite" else "provider.openRead") {
      val file = node(documentId).file ?: throw FileNotFoundException("$documentId is a folder")
      ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
    }
  }

  override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String =
    plan.step("provider.create") {
      val wanted = if (quirks.alterOnCreate) "$displayName.bin" else displayName
      addNode(parentDocumentId, settleName(parentDocumentId, wanted), isDir = false).id
    }

  override fun renameDocument(documentId: String, displayName: String): String? =
    plan.step("provider.rename") {
      if (!quirks.supportsRename) throw UnsupportedOperationException("rename not supported")
      val node = node(documentId)
      val alterOnce = quirks.alterOrgRenameOnce && displayName.endsWith(".org") &&
        alteredOnce.add(displayName)
      val wanted = if (quirks.alterEveryRename || alterOnce) "$displayName.txt" else displayName
      node.name = settleName(node.parent, wanted)
      if (quirks.renameChangesId) {
        nodes.remove(node.id)
        node.id = "doc-${nextId++}"
        nodes[node.id] = node
        node.id
      } else {
        null
      }
    }

  override fun deleteDocument(documentId: String) {
    plan.step("provider.delete") {
      val node = node(documentId)
      nodes.remove(documentId)
      node.file?.delete()
    }
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
    var current = nodes[documentId]
    while (current != null) {
      if (current.parent == parentDocumentId) return true
      current = current.parent?.let { nodes[it] }
    }
    return false
  }

  private fun addRow(cursor: MatrixCursor, node: Node) {
    val row = cursor.newRow()
    row.add(Document.COLUMN_DOCUMENT_ID, node.id)
    row.add(Document.COLUMN_DISPLAY_NAME, node.name)
    row.add(
      Document.COLUMN_MIME_TYPE,
      if (node.isDir) Document.MIME_TYPE_DIR else "application/octet-stream",
    )
    row.add(Document.COLUMN_SIZE, node.file?.length() ?: 0L)
    row.add(Document.COLUMN_LAST_MODIFIED, node.file?.lastModified() ?: 0L)
    val rename = if (quirks.supportsRename) Document.FLAG_SUPPORTS_RENAME else 0
    row.add(
      Document.COLUMN_FLAGS,
      if (node.isDir) {
        Document.FLAG_DIR_SUPPORTS_CREATE or rename
      } else {
        Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE or rename
      },
    )
  }

  private companion object {
    val DEFAULT_COLUMNS = arrayOf(
      Document.COLUMN_DOCUMENT_ID,
      Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_MIME_TYPE,
      Document.COLUMN_SIZE,
      Document.COLUMN_LAST_MODIFIED,
      Document.COLUMN_FLAGS,
    )
  }
}
