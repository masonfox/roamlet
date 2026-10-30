package com.roamlet.fs

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

private const val TARGET = "daily/note.org"
private const val SIBLING = "other.org"
private const val IGNORED = ".git/config"
private const val NEW_NOTE = "daily/new-note.org"

private val KILLS = setOf(FaultKind.KILL_BEFORE, FaultKind.KILL_AFTER, FaultKind.TORN_WRITE)

private data class Variant(val label: String, val make: () -> TestLibrary)

private val REPLACE_VARIANTS = listOf(
  Variant("rename capable") { SafTestLibrary(Quirks()) },
  Variant("no rename") { SafTestLibrary(Quirks(supportsRename = false)) },
  Variant("alters created names") { SafTestLibrary(Quirks(alterOnCreate = true)) },
  Variant("alters a .org rename once") { SafTestLibrary(Quirks(alterOrgRenameOnce = true)) },
  Variant("alters every rename") { SafTestLibrary(Quirks(alterEveryRename = true)) },
  Variant("rename changes id") { SafTestLibrary(Quirks(renameChangesId = true)) },
  Variant("app-owned") { PlainTestLibrary() },
)

private val CREATE_VARIANTS = REPLACE_VARIANTS + listOf(
  Variant("unique names") { SafTestLibrary(Quirks(uniqueNames = true)) },
  Variant("no rename, alters created names") {
    SafTestLibrary(Quirks(supportsRename = false, alterOnCreate = true))
  },
)

/** Fails every step of each save protocol, in every way, and checks recovery after each. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SaveProtocolFaultTest {
  private fun seeded(variant: Variant): TestLibrary = variant.make().also {
    it.seed(TARGET, OLD_BYTES)
    it.seed(SIBLING, SIBLING_BYTES)
    it.seed(IGNORED, IGNORED_BYTES)
  }

  private fun List<Byte>?.isBytes(bytes: ByteArray) = this == bytes.toList()

  /** The library is whole: one complete version of the note, nothing extra, and no journal left. */
  private fun assertWhole(library: TestLibrary, context: String, allowedTarget: List<ByteArray>): List<Byte> {
    val files = library.snapshot()
    assertEquals("$context: files present", setOf(TARGET, SIBLING, IGNORED), files.keys)
    assertTrue("$context: sibling intact", files[SIBLING].isBytes(SIBLING_BYTES))
    assertTrue("$context: ignored file intact", files[IGNORED].isBytes(IGNORED_BYTES))
    val target = files.getValue(TARGET)
    assertTrue("$context: target is complete", allowedTarget.any { target.isBytes(it) })
    assertEquals("$context: journal folder empty", emptyList<String>(), library.journalDir.allFiles())
    return target
  }

  /** Whether the recovery fault in the last [runReplace] was reached. */
  private var recoveryWasKilled = false

  /** Runs one faulted save and its recovery, with [recoveryFault] in a first recovery if given. */
  private fun runReplace(
    library: TestLibrary,
    failAt: Int,
    kind: FaultKind,
    recoveryFault: Pair<Int, FaultKind>? = null,
  ) {
    val context = "failAt=$failAt kind=$kind recoveryFault=$recoveryFault"
    library.plan.arm(failAt, kind)
    val outcome = try {
      library.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES))
    } catch (_: SimulatedKill) {
      null
    }
    val trace = library.plan.trace.toList()
    if (outcome is ReplaceOutcome.Replaced) {
      assertTrue("$context: reported saved", library.snapshot()[TARGET].isBytes(NEW_BYTES))
    }
    recoveryWasKilled = false
    if (recoveryFault != null) {
      library.plan.arm(recoveryFault.first, recoveryFault.second)
      try {
        library.open().recover()
      } catch (_: SimulatedKill) {
        recoveryWasKilled = true
      }
    }
    library.plan.disarm()
    assertEquals("$context trace=$trace", RecoverOutcome.Ok, library.open().recover())
    val ending = assertWhole(library, "$context trace=$trace", listOf(OLD_BYTES, NEW_BYTES))
    if (outcome is ReplaceOutcome.Replaced) {
      assertTrue("$context: a reported save survives recovery", ending.isBytes(NEW_BYTES))
    }
  }

  private fun cleanRunLength(variant: Variant, run: (TestLibrary) -> Unit): Int {
    val library = seeded(variant)
    try {
      library.plan.disarm()
      run(library)
      return library.plan.trace.size
    } finally {
      library.close()
    }
  }

  @Test
  fun replaceRecoversFromEveryFailureAtEveryStep() {
    for (variant in REPLACE_VARIANTS) {
      val steps = cleanRunLength(variant) { library ->
        val outcome = library.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES))
        assertEquals(variant.label, ReplaceOutcome.Replaced(sha256(NEW_BYTES)), outcome)
        assertArrayEquals(variant.label, NEW_BYTES, library.snapshot().getValue(TARGET).toByteArray())
      }
      assertTrue("${variant.label}: the protocol has steps ($steps)", steps >= 10)
      var ended = 0
      var old = 0
      var new = 0
      for (kind in FaultKind.values()) {
        for (failAt in 0 until steps) {
          val library = seeded(variant)
          try {
            runReplace(library, failAt, kind)
            ended += 1
            if (library.snapshot()[TARGET].isBytes(OLD_BYTES)) old += 1 else new += 1
          } catch (e: AssertionError) {
            throw AssertionError("${variant.label}: ${e.message}", e)
          } finally {
            library.close()
          }
        }
      }
      assertEquals(variant.label, steps * FaultKind.values().size, ended)
      println("replace, ${variant.label}: $steps steps, $ended faulted saves, $old kept old, $new took new")
      // If one side never happens, the faults aren't reaching the interesting states.
      assertTrue("${variant.label}: some saves rolled back ($old)", old > 0)
      assertTrue("${variant.label}: some saves went forward ($new)", new > 0)
    }
  }

  @Test
  fun recoveryItselfSurvivesAKillAtEveryStep() {
    for (variant in REPLACE_VARIANTS) {
      val steps = cleanRunLength(variant) { it.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES)) }
      for (failAt in 0 until steps) {
        for (recoveryKind in listOf(FaultKind.KILL_BEFORE, FaultKind.KILL_AFTER)) {
          var recoveryFailAt = 0
          do {
            val library = seeded(variant)
            try {
              runReplace(library, failAt, FaultKind.KILL_AFTER, recoveryFailAt to recoveryKind)
            } catch (e: AssertionError) {
              throw AssertionError("${variant.label}: ${e.message}", e)
            } finally {
              library.close()
            }
            recoveryFailAt += 1
          } while (recoveryWasKilled)
        }
      }
    }
  }

  @Test
  fun tornWritesReachTheFilesAndNeverSurvive() {
    for (variant in REPLACE_VARIANTS) {
      val steps = cleanRunLength(variant) { it.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES)) }
      var torn = 0
      var tornTargets = 0
      for (failAt in 0 until steps) {
        val library = seeded(variant)
        try {
          library.plan.arm(failAt, FaultKind.TORN_WRITE)
          try {
            library.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES))
          } catch (_: SimulatedKill) {
            torn += 1
            val target = library.snapshot()[TARGET]
            if (!target.isBytes(OLD_BYTES) && !target.isBytes(NEW_BYTES)) tornTargets += 1
          }
          library.plan.disarm()
          assertEquals(variant.label, RecoverOutcome.Ok, library.open().recover())
          assertWhole(library, "${variant.label} failAt=$failAt", listOf(OLD_BYTES, NEW_BYTES))
        } finally {
          library.close()
        }
      }
      assertTrue("${variant.label}: a torn write happened", torn > 0)
      if (variant.label == "no rename" || variant.label == "alters every rename") {
        assertTrue("${variant.label}: the in-place path tore the note itself", tornTargets > 0)
      } else {
        assertEquals("${variant.label}: the swap path never tears the note", 0, tornTargets)
      }
    }
  }

  @Test
  fun aSurvivingFailureLeavesTheFileCompleteWithoutARestart() {
    for (variant in REPLACE_VARIANTS) {
      val steps = cleanRunLength(variant) { it.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES)) }
      for (kind in listOf(FaultKind.ERROR_BEFORE, FaultKind.ERROR_AFTER)) {
        for (failAt in 0 until steps) {
          val library = seeded(variant)
          try {
            library.plan.arm(failAt, kind)
            val outcome = library.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES))
            val context = "${variant.label} failAt=$failAt kind=$kind trace=${library.plan.trace}"
            val target = library.snapshot()[TARGET]
            when (outcome) {
              is ReplaceOutcome.Replaced -> assertTrue(context, target.isBytes(NEW_BYTES))
              is ReplaceOutcome.Failed ->
                assertTrue(context, target.isBytes(OLD_BYTES) || target.isBytes(NEW_BYTES))
              is ReplaceOutcome.Stale -> fail("$context: reported stale")
            }
          } finally {
            library.close()
          }
        }
      }
    }
  }

  @Test
  fun recoveryWaitsWhileTheFolderIsUnavailableAndKeepsItsData() {
    for (variant in REPLACE_VARIANTS) {
      val steps = cleanRunLength(variant) { it.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES)) }
      for (failAt in 0 until steps) {
        val library = seeded(variant)
        try {
          library.plan.arm(failAt, FaultKind.KILL_AFTER)
          try {
            library.open().replaceFile(TARGET, NEW_BYTES, sha256(OLD_BYTES))
          } catch (_: SimulatedKill) {
            // The app died mid-save.
          }
          val journalsLeft = library.journals.all()
          val context = "${variant.label} failAt=$failAt"
          if (journalsLeft.isNotEmpty()) {
            // The folder is gone at relaunch: the first thing recovery asks the folder fails.
            library.plan.arm(1, FaultKind.OUTAGE)
            val outcome = library.open().recover()
            assertTrue("$context: $outcome", outcome is RecoverOutcome.Failed)
            assertEquals(context, journalsLeft, library.journals.all())
            journalsLeft.filter { it.mode == SaveMode.IN_PLACE }.forEach {
              assertArrayEquals(context, OLD_BYTES, library.journals.readBackup(it.id))
            }
          }
          library.plan.disarm()
          assertEquals(context, RecoverOutcome.Ok, library.open().recover())
          assertWhole(library, context, listOf(OLD_BYTES, NEW_BYTES))
        } finally {
          library.close()
        }
      }
    }
  }

  @Test
  fun createLeavesNothingOrTheCompleteNoteAfterEveryFailure() {
    for (variant in CREATE_VARIANTS) {
      val steps = cleanRunLength(variant) { it.open().createExclusive(NEW_NOTE, NEW_BYTES) }
      assertTrue("${variant.label}: the protocol has steps ($steps)", steps >= 5)
      println("create, ${variant.label}: $steps steps, ${steps * FaultKind.values().size} faulted saves")
      for (kind in FaultKind.values()) {
        for (failAt in 0 until steps) {
          val library = seeded(variant)
          val context = "${variant.label} failAt=$failAt kind=$kind"
          try {
            library.plan.arm(failAt, kind)
            val outcome = try {
              library.open().createExclusive(NEW_NOTE, NEW_BYTES)
            } catch (_: SimulatedKill) {
              null
            }
            library.plan.disarm()
            assertEquals(context, RecoverOutcome.Ok, library.open().recover())
            val files = library.snapshot()
            assertEquals(
              "$context: files present",
              setOf(TARGET, SIBLING, IGNORED, NEW_NOTE) - (if (NEW_NOTE in files) emptySet() else setOf(NEW_NOTE)),
              files.keys,
            )
            if (NEW_NOTE in files) {
              assertTrue("$context: note is complete", files[NEW_NOTE].isBytes(NEW_BYTES))
            }
            if (outcome is CreateOutcome.Created) {
              assertTrue("$context: a reported note exists", NEW_NOTE in files)
            }
            assertTrue("$context: original intact", files[TARGET].isBytes(OLD_BYTES))
            assertEquals("$context: journals", emptyList<String>(), library.journalDir.allFiles())
          } catch (e: AssertionError) {
            throw AssertionError(e.message + " trace=" + library.plan.trace, e)
          } finally {
            library.close()
          }
        }
      }
    }
  }
}
