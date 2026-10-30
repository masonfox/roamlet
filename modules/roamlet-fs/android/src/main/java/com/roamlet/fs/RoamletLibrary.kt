package com.roamlet.fs

import android.util.Log
import java.io.FileNotFoundException
import java.io.IOException
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID

internal data class Failure(val kind: String, val message: String)

internal data class PathFailure(val path: String, val failure: Failure)

internal data class Entry(val path: String, val doc: Doc)

internal data class Listing(val entries: List<Entry>, val failures: List<PathFailure>)

internal sealed class ReadOutcome {
  class Ok(val bytes: ByteArray) : ReadOutcome()
  data class Failed(val failure: Failure) : ReadOutcome()
}

internal sealed class DigestOutcome {
  data class Ok(val hash: String) : DigestOutcome()
  data class Failed(val failure: Failure) : DigestOutcome()
}

internal sealed class CreateOutcome {
  data class Created(val path: String) : CreateOutcome()
  object Exists : CreateOutcome()
  data class Failed(val failure: Failure) : CreateOutcome()
}

internal sealed class ReplaceOutcome {
  data class Replaced(val hash: String) : ReplaceOutcome()
  data class Stale(val currentHash: String) : ReplaceOutcome()
  data class Failed(val failure: Failure) : ReplaceOutcome()
}

internal sealed class RecoverOutcome {
  object Ok : RecoverOutcome()
  data class Failed(val failure: Failure) : RecoverOutcome()
}

/** Thrown before the target is touched, when renames can't be trusted to keep exact names. */
private class RenameUnreliableException(message: String) : IOException(message)

/**
 * One library root: the batched listing, reads, and the save protocols of Decision 4.
 *
 * Every journal is written before the first change in the library. Decision 4 lists the swap's
 * journal after the temp document, but that order would strand the temp on a crash in between.
 */
internal class RoamletLibrary(
  private val backend: LibraryBackend,
  private val journals: JournalStore,
  private val newId: () -> String = { UUID.randomUUID().toString() },
) {
  /** One query per directory, and no per-file queries. A failed directory doesn't stop the walk. */
  fun list(): Listing {
    val entries = mutableListOf<Entry>()
    val failures = mutableListOf<PathFailure>()
    val pending = ArrayDeque<Pair<Doc, String>>()
    try {
      pending.add(backend.root() to "")
    } catch (e: Exception) {
      return Listing(entries, listOf(PathFailure("", failureOf(e))))
    }
    while (pending.isNotEmpty()) {
      val (dir, path) = pending.removeFirst()
      val children = try {
        backend.children(dir)
      } catch (e: Exception) {
        failures.add(PathFailure(path, failureOf(e)))
        continue
      }
      for (child in children) {
        if (child.name.startsWith(".")) continue
        val childPath = if (path.isEmpty()) child.name else "$path/${child.name}"
        entries.add(Entry(childPath, child))
        if (child.isDir) pending.add(child to childPath)
      }
    }
    return Listing(entries, failures)
  }

  fun readBytes(path: String): ReadOutcome = try {
    ReadOutcome.Ok(readAll(requireFile(path)))
  } catch (e: Exception) {
    ReadOutcome.Failed(failureOf(e))
  }

  fun digest(path: String): DigestOutcome = try {
    DigestOutcome.Ok(hashOf(requireFile(path)))
  } catch (e: Exception) {
    DigestOutcome.Failed(failureOf(e))
  }

  /**
   * Finds each file and hands it to [fetch], which is expected not to wait for the content.
   * Reading a file is what makes a provider fetch it, so that's what [fetch] does.
   */
  fun requestDownload(paths: List<String>, fetch: (Doc) -> Unit): List<PathFailure> {
    val failures = mutableListOf<PathFailure>()
    for (path in paths) {
      try {
        fetch(requireFile(path))
      } catch (e: Exception) {
        failures.add(PathFailure(path, failureOf(e)))
      }
    }
    return failures
  }

  /** Reads the start of a file, so the provider fetches it. For use as a [requestDownload] fetch. */
  fun touch(doc: Doc) {
    backend.openRead(doc).use { it.read() }
  }

  fun recover(): RecoverOutcome = synchronized(this) {
    try {
      recoverPending()
      RecoverOutcome.Ok
    } catch (e: Exception) {
      RecoverOutcome.Failed(failureOf(e))
    }
  }

  fun replaceFile(path: String, bytes: ByteArray, expectedHash: String): ReplaceOutcome = synchronized(this) {
    try {
      // A save that failed earlier in this run may have left its recovery unfinished.
      recoverPending()
      val segments = segmentsOf(path)
      val parent = findDir(segments.dropLast(1))
        ?: throw FileNotFoundException("no folder for $path")
      val target = backend.children(parent).firstOrNull { it.name == segments.last() }
        ?: throw FileNotFoundException("no file at $path")
      // A swap could replace it anyway, through its folder, so the refusal has to be honored here.
      if (!target.canWrite) throw SecurityException("the provider refuses writes to $path")
      val current = readAll(target)
      val currentHash = sha256(current)
      if (currentHash != expectedHash) return@synchronized ReplaceOutcome.Stale(currentHash)

      val newHash = sha256(bytes)
      if (parent.canCreate && target.canRename && target.canDelete) {
        val journal = Journal(newId(), SaveMode.SWAP, path, newHash)
        try {
          swap(parent, target, journal, bytes)
          return@synchronized ReplaceOutcome.Replaced(newHash)
        } catch (e: RenameUnreliableException) {
          Log.w(TAG, "renames alter names here, so saving in place instead", e)
          finish(journal)
        } catch (e: Exception) {
          return@synchronized settleReplace(journal, target.name, parent, e)
        }
      }
      val journal = Journal(newId(), SaveMode.IN_PLACE, path, newHash, oldHash = currentHash)
      try {
        rewrite(target, journal, current, bytes)
        ReplaceOutcome.Replaced(newHash)
      } catch (e: Exception) {
        settleReplace(journal, target.name, parent, e)
      }
    } catch (e: Exception) {
      ReplaceOutcome.Failed(failureOf(e))
    }
  }

  fun createExclusive(path: String, bytes: ByteArray): CreateOutcome = synchronized(this) {
    try {
      recoverPending()
      val segments = segmentsOf(path)
      val name = segments.last()
      val parent = findDir(segments.dropLast(1))
        ?: throw FileNotFoundException("no folder for $path")
      if (backend.children(parent).any { foldName(it.name) == foldName(name) }) {
        return@synchronized CreateOutcome.Exists
      }
      val newHash = sha256(bytes)
      val swapJournal = Journal(newId(), SaveMode.CREATE_SWAP, path, newHash)
      try {
        val created = createBySwap(parent, name, swapJournal, bytes)
        if (created != null) return@synchronized created
        finish(swapJournal)
      } catch (e: Exception) {
        return@synchronized settleCreate(swapJournal, name, parent, e)
      }
      val journal = Journal(newId(), SaveMode.CREATE_IN_PLACE, path, newHash)
      try {
        createInPlace(parent, name, journal, bytes)
      } catch (e: Exception) {
        settleCreate(journal, name, parent, e)
      }
    } catch (e: Exception) {
      CreateOutcome.Failed(failureOf(e))
    }
  }

  private fun swap(parent: Doc, target: Doc, journal: Journal, bytes: ByteArray) {
    journals.write(journal)
    // The temp's own name can stay altered: recovery goes by its prefix, and it's about to move.
    var temp = backend.create(parent, journal.tempName)
    backend.write(temp, bytes)
    requireHash(temp, journal.newHash)
    // A provider that alters names on rename would strand the original under its old name, and
    // would alter it again on the way back. Find out while the target is still untouched.
    val probeName = journal.tempName + "2"
    temp = backend.rename(temp, probeName)
    if (temp.name != probeName) throw RenameUnreliableException("$probeName became ${temp.name}")

    val old = correctName(backend.rename(target, journal.oldName), journal.oldName)
    val placed = correctName(backend.rename(temp, target.name), target.name)
    requireHash(placed, journal.newHash)
    backend.delete(old)
    journals.delete(journal.id)
  }

  private fun rewrite(target: Doc, journal: Journal, current: ByteArray, bytes: ByteArray) {
    // In this order, a journal means its backup is complete. A stranded backup is swept.
    journals.writeBackup(journal.id, current)
    journals.write(journal)
    backend.write(target, bytes)
    requireHash(target, journal.newHash)
    discard(journal)
  }

  /** Returns null when this provider can't rename, so the caller must create at the final name. */
  private fun createBySwap(parent: Doc, name: String, journal: Journal, bytes: ByteArray): CreateOutcome? {
    journals.write(journal)
    val temp = backend.create(parent, journal.tempName)
    if (!temp.canRename) return null
    backend.write(temp, bytes)
    requireHash(temp, journal.newHash)
    val renamed = backend.rename(temp, name)
    if (renamed.name != name && nameTaken(parent, name)) {
      finish(journal)
      return CreateOutcome.Exists
    }
    requireHash(correctName(renamed, name), journal.newHash)
    journals.delete(journal.id)
    return CreateOutcome.Created(journal.path)
  }

  private fun createInPlace(parent: Doc, name: String, journal: Journal, bytes: ByteArray): CreateOutcome {
    journals.write(journal)
    val created = backend.create(parent, name)
    val recorded = journal.copy(createdRef = created.ref)
    journals.write(recorded)
    if (created.name != name && nameTaken(parent, name)) {
      finish(recorded)
      return CreateOutcome.Exists
    }
    val doc = correctName(created, name)
    backend.write(doc, bytes)
    requireHash(doc, journal.newHash)
    journals.delete(journal.id)
    return CreateOutcome.Created(journal.path)
  }

  // Providers that make names unique alter a name when something took it in the meantime.
  private fun nameTaken(parent: Doc, name: String) = backend.children(parent).any { it.name == name }

  /** The save failed, but the app lives: put the file in order now, and report what it holds. */
  private fun settleReplace(journal: Journal, name: String, parent: Doc, cause: Exception): ReplaceOutcome {
    val failure = ReplaceOutcome.Failed(failureOf(cause))
    return try {
      finish(journal)
      val target = backend.children(parent).firstOrNull { it.name == name }
      if (target != null && hashOf(target) == journal.newHash) {
        ReplaceOutcome.Replaced(journal.newHash)
      } else {
        failure
      }
    } catch (e: Exception) {
      // The journal stays, and the next recovery or save finishes this.
      Log.w(TAG, "couldn't finish a failed save yet", e)
      failure
    }
  }

  private fun settleCreate(journal: Journal, name: String, parent: Doc, cause: Exception): CreateOutcome {
    val failure = CreateOutcome.Failed(failureOf(cause))
    return try {
      val settled = currentJournal(journal)
      finish(settled)
      val target = backend.children(parent).firstOrNull { it.name == name }
      when {
        target == null -> failure
        hashOf(target) == journal.newHash -> CreateOutcome.Created(journal.path)
        else -> CreateOutcome.Exists
      }
    } catch (e: Exception) {
      Log.w(TAG, "couldn't finish a failed create yet", e)
      failure
    }
  }

  /** The stored form of a journal, which may have gained a `createdRef` since [journal] was made. */
  private fun currentJournal(journal: Journal): Journal =
    journals.all().firstOrNull { it.id == journal.id } ?: journal

  private fun recoverPending() {
    val pending = journals.all()
    // An unreachable folder throws here, and everything is kept for the next try.
    if (pending.isNotEmpty()) backend.root()
    pending.forEach { finish(it) }
    journals.sweep()
  }

  /** Leaves the file complete, whatever point its save reached, and removes all traces of the save. */
  private fun finish(journal: Journal) {
    val segments = segmentsOf(journal.path)
    // `recoverPending` showed that the root can be reached, so this means the folder is really gone.
    val parent = findDir(segments.dropLast(1))
    if (parent != null) {
      val name = segments.last()
      when (journal.mode) {
        SaveMode.SWAP -> finishSwap(parent, name, journal)
        SaveMode.IN_PLACE -> finishRewrite(parent, name, journal)
        SaveMode.CREATE_SWAP -> finishCreateSwap(parent, name, journal)
        SaveMode.CREATE_IN_PLACE -> finishCreateInPlace(parent, name, journal)
      }
    }
    discard(journal)
  }

  private fun finishSwap(parent: Doc, name: String, journal: Journal) {
    val children = backend.children(parent)
    val temp = children.firstOrNull { it.name.startsWith(journal.tempName) }
    val old = children.firstOrNull { it.name.startsWith(journal.oldName) }
    var placed = children.any { it.name == name }
    // With the target present, it's the original or a finished swap, and both are complete.
    if (!placed) {
      val complete = (listOfNotNull(temp) + children.filter { isAlteredName(it.name, name) })
        .firstOrNull { hashOf(it) == journal.newHash }
      if (complete != null) {
        correctName(backend.rename(complete, name), name)
        placed = true
      }
    }
    if (!placed && old != null) {
      correctName(backend.rename(old, name), name)
    }
    // Listing again, because the renames above may have used up `temp` or `old`.
    backend.children(parent)
      .filter { it.name.startsWith(journal.tempName) || it.name.startsWith(journal.oldName) }
      .forEach { backend.delete(it) }
  }

  private fun finishRewrite(parent: Doc, name: String, journal: Journal) {
    val target = backend.children(parent).firstOrNull { it.name == name }
    if (target != null) {
      val hash = hashOf(target)
      if (hash == journal.newHash || hash == journal.oldHash) return
    }
    val backup = journals.readBackup(journal.id)
    if (backup == null) {
      // A journal is only written after its complete backup, so this is disk damage.
      Log.e(TAG, "the backup for ${journal.id} is gone")
      return
    }
    val doc = target ?: correctName(backend.create(parent, name), name)
    backend.write(doc, backup)
    requireHash(doc, journal.oldHash ?: sha256(backup))
  }

  private fun finishCreateSwap(parent: Doc, name: String, journal: Journal) {
    // A finished swap needs nothing. Anything else is incomplete or misnamed, and the caller's
    // draft still has the text, so it can go.
    backend.children(parent)
      .filter {
        it.name.startsWith(journal.tempName) ||
          (isAlteredName(it.name, name) && hashOf(it) == journal.newHash)
      }
      .forEach { backend.delete(it) }
  }

  private fun finishCreateInPlace(parent: Doc, name: String, journal: Journal) {
    // Only ever removes what this save made: its recorded document, or the empty file it may have
    // made just before recording it. A file someone else made is neither.
    backend.children(parent)
      .filter { it.name == name || isAlteredName(it.name, name) }
      .filter { it.ref == journal.createdRef || it.size == 0L }
      .filter { it.name != name || hashOf(it) != journal.newHash }
      .forEach { backend.delete(it) }
  }

  private fun discard(journal: Journal) {
    // In this order, a crash in between leaves a stranded backup, which is swept, rather than a
    // journal with nothing to restore from.
    journals.delete(journal.id)
    journals.deleteBackup(journal.id)
  }

  private fun correctName(doc: Doc, name: String): Doc {
    if (doc.name == name) return doc
    val corrected = if (doc.canRename) backend.rename(doc, name) else doc
    if (corrected.name != name) throw NameChangedException("$name became ${corrected.name}")
    return corrected
  }

  private fun requireHash(doc: Doc, hash: String) {
    if (hashOf(doc) != hash) throw IOException("${doc.name} doesn't hold the bytes written")
  }

  private fun hashOf(doc: Doc): String {
    val digest = MessageDigest.getInstance("SHA-256")
    backend.openRead(doc).use { input ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().toHex()
  }

  private fun readAll(doc: Doc): ByteArray = backend.openRead(doc).use { it.readBytes() }

  private fun requireFile(path: String): Doc {
    val segments = segmentsOf(path)
    val parent = findDir(segments.dropLast(1)) ?: throw FileNotFoundException("no folder for $path")
    val file = backend.children(parent).firstOrNull { it.name == segments.last() }
      ?: throw FileNotFoundException("no file at $path")
    if (file.isDir) throw FileNotFoundException("$path is a folder")
    return file
  }

  /** Null when a segment doesn't exist. A folder that can't be read throws instead. */
  private fun findDir(segments: List<String>): Doc? {
    var dir = backend.root()
    for (segment in segments) {
      dir = backend.children(dir).firstOrNull { it.name == segment && it.isDir } ?: return null
    }
    return dir
  }

  private companion object {
    const val TAG = "RoamletFs"
  }
}

internal fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun segmentsOf(path: String): List<String> {
  val segments = path.split("/")
  if (segments.any { it.isEmpty() || it == "." || it == ".." }) {
    throw FileNotFoundException("not a library path: $path")
  }
  return segments
}

// Filesystems differ on case and Unicode normalization, so collision checks ignore both.
private fun foldName(name: String): String = Normalizer.normalize(name, Normalizer.Form.NFC).lowercase()

/** What providers make of a name they changed: `note.org.txt`, or `note (1).org`. */
private fun isAlteredName(candidate: String, name: String): Boolean {
  if (candidate == name) return false
  val stem = name.substringBeforeLast('.')
  return candidate.startsWith("$name.") || candidate.startsWith("$stem (")
}

internal fun failureOf(error: Exception): Failure {
  val kind = when (error) {
    is SecurityException -> "access_denied"
    is FileNotFoundException -> "not_found"
    is NameChangedException -> "name_changed"
    else -> "provider_error"
  }
  return Failure(kind, error.message ?: error.javaClass.simpleName)
}
