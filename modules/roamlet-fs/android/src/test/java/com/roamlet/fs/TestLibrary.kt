package com.roamlet.fs

import android.Manifest
import android.content.pm.ProviderInfo
import android.provider.DocumentsContract
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.nio.file.Files

/** A UTF-8 note with a BOM, CRLF, and text that any re-encoding would change. */
internal val OLD_BYTES = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) +
  "#+title: Old\r\n\r\ncafé 日本語 🦊\r\n".toByteArray()
internal val NEW_BYTES = "#+title: New\n\nthe new text, longer than the old one, and with é\n".toByteArray()
internal val SIBLING_BYTES = "#+title: Sibling\n".toByteArray()
internal val IGNORED_BYTES = "[core]\n".toByteArray()

/** A library on either root kind, with one [FaultPlan] across the provider, backend, and journal. */
internal abstract class TestLibrary {
  val plan = FaultPlan()
  val base: File = Files.createTempDirectory("roamlet").toFile()
  val journalDir = File(base, "txn")
  private val realJournals = FileJournalStore(journalDir)

  abstract fun seed(path: String, bytes: ByteArray)
  abstract fun snapshot(): Map<String, List<Byte>>
  protected abstract fun backend(): LibraryBackend

  /** A new library object over the same state, as after a process restart. */
  fun open(): RoamletLibrary =
    RoamletLibrary(FaultyBackend(backend(), plan), FaultyJournals(realJournals, plan), ids())

  /** Unwrapped journals, for reading state with no steps counted. */
  val journals: JournalStore get() = realJournals

  private var counter = 0
  private fun ids(): () -> String = { "id${counter++}" }

  open fun close() {
    base.deleteRecursively()
  }
}

internal class PlainTestLibrary : TestLibrary() {
  private val root = File(base, "root").also { it.mkdirs() }

  override fun seed(path: String, bytes: ByteArray) {
    File(root, path).also { it.parentFile!!.mkdirs() }.writeBytes(bytes)
  }

  override fun snapshot() = root.allFiles().associateWith { File(root, it).readBytes().toList() }

  override fun backend() = PlainFileBackend(root)
}

internal class SafTestLibrary(quirks: Quirks) : TestLibrary() {
  val provider = registerProvider()
  val treeUri = DocumentsContract.buildTreeDocumentUri(FAKE_AUTHORITY, FAKE_ROOT_ID)

  init {
    provider.reset(File(base, "blobs").also { it.mkdirs() }, quirks, plan)
  }

  override fun seed(path: String, bytes: ByteArray) = provider.seed(path, bytes)
  override fun snapshot() = provider.snapshot()
  override fun backend() = SafBackend(RuntimeEnvironment.getApplication().contentResolver, treeUri, sleep = {})
}

private fun registerProvider(): FakeDocumentsProvider {
  val info = ProviderInfo().apply {
    authority = FAKE_AUTHORITY
    exported = true
    grantUriPermissions = true
    readPermission = Manifest.permission.MANAGE_DOCUMENTS
    writePermission = Manifest.permission.MANAGE_DOCUMENTS
  }
  return Robolectric.buildContentProvider(FakeDocumentsProvider::class.java).create(info).get()
}
