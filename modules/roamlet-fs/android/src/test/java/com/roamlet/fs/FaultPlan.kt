package com.roamlet.fs

import java.io.File
import java.io.InputStream

/** Process death. An Error, so no `catch (e: Exception)` in the code under test can react to it. */
internal class SimulatedKill : Error("killed")

internal class InjectedFailure(step: String) : IllegalStateException("injected failure at $step")

internal enum class FaultKind {
  /** The process dies before the step takes effect. */
  KILL_BEFORE,

  /** The step takes effect, then the process dies, so the result is lost. */
  KILL_AFTER,

  /** The step fails with no effect, and the app carries on. */
  ERROR_BEFORE,

  /** The step takes effect but reports failure, and the app carries on. */
  ERROR_AFTER,

  /** This step and every later one fail, as when a provider goes away. */
  OUTAGE,

  /** On a backend write: half the bytes land, then the process dies. Other steps are unaffected. */
  TORN_WRITE,

  /** On a backend write: different bytes land, and the provider reports success. */
  CORRUPT_WRITE,
}

/** Numbers every step of a run, and fails the chosen one. The same plan spans all the layers. */
internal class FaultPlan {
  val trace = mutableListOf<String>()
  private var failAt = -1
  private var kind = FaultKind.KILL_BEFORE
  private var outage = false

  var killed = false
    private set

  fun arm(index: Int, faultKind: FaultKind) {
    trace.clear()
    failAt = index
    kind = faultKind
    killed = false
    outage = false
  }

  fun disarm() {
    arm(-1, FaultKind.KILL_BEFORE)
  }

  fun <T> step(name: String, effect: () -> T): T {
    if (killed) throw SimulatedKill()
    if (outage) throw InjectedFailure(name)
    val index = trace.size
    trace.add(name)
    if (index != failAt) return effect()
    return when (kind) {
      FaultKind.KILL_BEFORE -> {
        killed = true
        throw SimulatedKill()
      }
      FaultKind.KILL_AFTER -> {
        effect()
        killed = true
        throw SimulatedKill()
      }
      FaultKind.ERROR_BEFORE -> throw InjectedFailure(name)
      FaultKind.ERROR_AFTER -> {
        effect()
        throw InjectedFailure(name)
      }
      FaultKind.OUTAGE -> {
        outage = true
        throw InjectedFailure(name)
      }
      FaultKind.TORN_WRITE, FaultKind.CORRUPT_WRITE -> effect()
    }
  }

  /** A write has more ways to go wrong than other steps, because its effect can be partial. */
  fun write(bytes: ByteArray, effect: (ByteArray) -> Unit) {
    val hit = trace.size == failAt && !killed && !outage
    when {
      hit && kind == FaultKind.TORN_WRITE -> {
        trace.add("backend.write")
        effect(bytes.copyOf(bytes.size / 2))
        killed = true
        throw SimulatedKill()
      }
      hit && kind == FaultKind.CORRUPT_WRITE -> {
        trace.add("backend.write")
        effect(bytes + 0x21.toByte())
      }
      else -> step("backend.write") { effect(bytes) }
    }
  }
}

/** Adds fault points around any backend, including those a provider can't express: torn writes. */
internal class FaultyBackend(
  private val delegate: LibraryBackend,
  private val plan: FaultPlan,
) : LibraryBackend {
  override fun root() = plan.step("backend.root") { delegate.root() }
  override fun children(dir: Doc) = plan.step("backend.children") { delegate.children(dir) }
  override fun create(dir: Doc, name: String) = plan.step("backend.create") { delegate.create(dir, name) }
  override fun rename(doc: Doc, name: String) = plan.step("backend.rename") { delegate.rename(doc, name) }
  override fun delete(doc: Doc) = plan.step("backend.delete") { delegate.delete(doc) }
  override fun openRead(doc: Doc): InputStream = plan.step("backend.openRead") { delegate.openRead(doc) }
  override fun write(doc: Doc, bytes: ByteArray) = plan.write(bytes) { delegate.write(doc, it) }
}

internal class FaultyJournals(
  private val delegate: JournalStore,
  private val plan: FaultPlan,
) : JournalStore {
  override fun all() = plan.step("journal.all") { delegate.all() }
  override fun write(journal: Journal) = plan.step("journal.write") { delegate.write(journal) }
  override fun delete(id: String) = plan.step("journal.delete") { delegate.delete(id) }
  override fun writeBackup(id: String, bytes: ByteArray) =
    plan.step("journal.writeBackup") { delegate.writeBackup(id, bytes) }
  override fun readBackup(id: String) = plan.step("journal.readBackup") { delegate.readBackup(id) }
  override fun deleteBackup(id: String) = plan.step("journal.deleteBackup") { delegate.deleteBackup(id) }
  override fun sweep() = plan.step("journal.sweep") { delegate.sweep() }
}

internal fun File.allFiles(): List<String> =
  walkTopDown().filter { it.isFile }.map { it.relativeTo(this).invariantSeparatorsPath }.sorted().toList()
