package com.roamlet.fs

import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

private const val JOURNAL_VERSION = 1
private const val JOURNAL_SUFFIX = ".json"
private const val BACKUP_SUFFIX = ".bak"

internal enum class SaveMode {
  /** Replace by swapping in a temp document with renames. */
  SWAP,

  /** Replace by rewriting the target, with a backup in internal storage. */
  IN_PLACE,

  /** New file: write a temp document, then rename it to the final name. */
  CREATE_SWAP,

  /** New file on a provider that can't rename: write at the final name. */
  CREATE_IN_PLACE,
}

internal data class Journal(
  val id: String,
  val mode: SaveMode,
  /** Library-relative path of the file being saved. */
  val path: String,
  val newHash: String,
  /** IN_PLACE only: the hash of the content in the backup. */
  val oldHash: String? = null,
  /** CREATE_IN_PLACE only: the document this save made, once it exists. */
  val createdRef: String? = null,
) {
  val tempName get() = ".roamlet-$id.tmp"
  val oldName get() = ".roamlet-$id.old"
}

/** Save journals and backups, which live in internal storage and never in the library. */
internal interface JournalStore {
  fun all(): List<Journal>

  /** When this returns, the journal is durable and complete. */
  fun write(journal: Journal)
  fun delete(id: String)
  fun writeBackup(id: String, bytes: ByteArray)
  fun readBackup(id: String): ByteArray?
  fun deleteBackup(id: String)

  /** Removes whatever a crash stranded with no journal: backups and half-written files. */
  fun sweep()
}

/** One folder per library: `libraries/<libraryId>/txn/` in Decision 3. */
internal class FileJournalStore(private val dir: File) : JournalStore {
  override fun all(): List<Journal> =
    dir.listFiles { file -> file.name.endsWith(JOURNAL_SUFFIX) }.orEmpty().mapNotNull { file ->
      try {
        file.readText().toJournal()
      } catch (e: JSONException) {
        // Writes are atomic, so this is disk damage, and there's nothing to act on.
        Log.w("RoamletFs", "dropping unreadable journal ${file.name}", e)
        file.delete()
        null
      }
    }

  override fun write(journal: Journal) {
    writeAtomically(File(dir, journal.id + JOURNAL_SUFFIX), journal.toJson().toByteArray())
  }

  override fun delete(id: String) {
    deleteFile(File(dir, id + JOURNAL_SUFFIX))
  }

  override fun writeBackup(id: String, bytes: ByteArray) {
    writeAtomically(File(dir, id + BACKUP_SUFFIX), bytes)
  }

  override fun readBackup(id: String): ByteArray? =
    File(dir, id + BACKUP_SUFFIX).takeIf { it.exists() }?.readBytes()

  override fun deleteBackup(id: String) {
    deleteFile(File(dir, id + BACKUP_SUFFIX))
  }

  override fun sweep() {
    val files = dir.listFiles().orEmpty()
    val live = files.map { it.name }.filter { it.endsWith(JOURNAL_SUFFIX) }
      .map { it.removeSuffix(JOURNAL_SUFFIX) }.toSet()
    files.filterNot { it.name.endsWith(JOURNAL_SUFFIX) }
      .filterNot { it.name.endsWith(BACKUP_SUFFIX) && it.name.removeSuffix(BACKUP_SUFFIX) in live }
      .forEach { it.delete() }
  }

  private fun writeAtomically(file: File, bytes: ByteArray) {
    if (!dir.isDirectory && !dir.mkdirs()) throw IOException("can't create $dir")
    val part = File(dir, file.name + ".part")
    FileOutputStream(part).use {
      it.write(bytes)
      it.flush()
      it.fd.sync()
    }
    if (!part.renameTo(file)) throw IOException("can't move ${part.name} into place")
  }

  private fun deleteFile(file: File) {
    if (!file.delete() && file.exists()) throw IOException("can't delete ${file.name}")
  }
}

private fun Journal.toJson(): String = JSONObject()
  .put("version", JOURNAL_VERSION)
  .put("id", id)
  .put("mode", mode.name)
  .put("path", path)
  .put("newHash", newHash)
  .put("oldHash", oldHash ?: JSONObject.NULL)
  .put("createdRef", createdRef ?: JSONObject.NULL)
  .toString()

private fun String.toJournal(): Journal {
  val json = JSONObject(this)
  return Journal(
    id = json.getString("id"),
    mode = SaveMode.valueOf(json.getString("mode")),
    path = json.getString("path"),
    newHash = json.getString("newHash"),
    oldHash = if (json.isNull("oldHash")) null else json.getString("oldHash"),
    createdRef = if (json.isNull("createdRef")) null else json.getString("createdRef"),
  )
}
