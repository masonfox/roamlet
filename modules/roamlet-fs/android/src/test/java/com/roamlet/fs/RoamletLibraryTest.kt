package com.roamlet.fs

import android.content.Intent
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Behavior with no faults injected: listing, reads, name verification, and folder access. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoamletLibraryTest {
  private val resolver get() = RuntimeEnvironment.getApplication().contentResolver

  private fun saf(quirks: Quirks = Quirks()) = SafTestLibrary(quirks)

  private fun bothKinds(check: (TestLibrary) -> Unit) {
    for (library in listOf(saf(), PlainTestLibrary())) {
      try {
        check(library)
      } finally {
        library.close()
      }
    }
  }

  @Test
  fun listWalksEverythingButHiddenEntries() = bothKinds { library ->
    library.seed("a.org", OLD_BYTES)
    library.seed("daily/b.org", NEW_BYTES)
    library.seed("daily/deep/c.org", NEW_BYTES)
    library.seed("image.png", NEW_BYTES)
    library.seed(".git/config", NEW_BYTES)
    library.seed(".stfolder/x.org", NEW_BYTES)
    library.seed("daily/.#lock.org", NEW_BYTES)

    val listing = library.open().list()

    assertEquals(emptyList<PathFailure>(), listing.failures)
    assertEquals(
      listOf("a.org", "daily", "daily/b.org", "daily/deep", "daily/deep/c.org", "image.png"),
      listing.entries.map { it.path }.sorted(),
    )
    val file = listing.entries.first { it.path == "a.org" }.doc
    assertEquals("a.org", file.name)
    assertEquals(OLD_BYTES.size.toLong(), file.size)
    assertTrue(listing.entries.first { it.path == "daily" }.doc.isDir)
  }

  @Test
  fun listMakesOneQueryPerDirectoryAndNonePerFile() {
    val library = saf()
    try {
      repeat(50) { library.seed("many/$it.org", OLD_BYTES) }
      library.seed("many/sub/x.org", OLD_BYTES)
      library.provider.childQueries = 0
      library.provider.documentQueries = 0

      assertEquals(53, library.open().list().entries.size)

      assertEquals(3, library.provider.childQueries)
      assertEquals(1, library.provider.documentQueries)
    } finally {
      library.close()
    }
  }

  @Test
  fun aFailedDirectoryIsReportedAndTheWalkContinues() {
    val library = saf()
    try {
      library.seed("good/a.org", OLD_BYTES)
      library.seed("bad/b.org", OLD_BYTES)
      val open = library.open()
      val badId = open.list().entries.first { it.path == "bad" }.doc.ref
      library.provider.refuseChildQueriesOf = badId

      val listing = open.list()

      assertEquals(listOf("bad", "good", "good/a.org"), listing.entries.map { it.path }.sorted())
      assertEquals("bad", listing.failures.single().path)
      assertEquals("access_denied", listing.failures.single().failure.kind)
    } finally {
      library.close()
    }
  }

  @Test
  fun aRootThatCantBeReachedIsAFailureAtTheEmptyPath() {
    val library = saf()
    try {
      library.seed("a.org", OLD_BYTES)
      library.provider.removeRootForTest()

      val listing = library.open().list()

      assertEquals(emptyList<Entry>(), listing.entries)
      assertEquals("", listing.failures.single().path)
    } finally {
      library.close()
    }
  }

  @Test
  fun aListingThatStaysLoadingIsAFailureNotAnEmptyFolder() {
    val library = saf()
    try {
      library.seed("a.org", OLD_BYTES)
      library.provider.loadingQueriesLeft = 3
      assertEquals(listOf("a.org"), library.open().list().entries.map { it.path })

      library.provider.loadingQueriesLeft = 1000
      val listing = library.open().list()
      assertEquals(emptyList<Entry>(), listing.entries)
      assertEquals("provider_error", listing.failures.single().failure.kind)
    } finally {
      library.close()
    }
  }

  @Test
  fun readsReturnExactBytesAndDigests() = bothKinds { library ->
    library.seed("daily/a.org", OLD_BYTES)
    val open = library.open()

    val read = open.readBytes("daily/a.org") as ReadOutcome.Ok
    assertArrayEquals(OLD_BYTES, read.bytes)
    assertEquals(DigestOutcome.Ok(sha256(OLD_BYTES)), open.digest("daily/a.org"))
    assertEquals("not_found", (open.readBytes("nope.org") as ReadOutcome.Failed).failure.kind)
    assertEquals("not_found", (open.digest("nope/a.org") as DigestOutcome.Failed).failure.kind)
    assertEquals("not_found", (open.readBytes("../a.org") as ReadOutcome.Failed).failure.kind)
  }

  @Test
  fun replaceWritesExactBytesUnderTheExactName() = bothKinds { library ->
    library.seed("daily/a.org", OLD_BYTES)

    val outcome = library.open().replaceFile("daily/a.org", NEW_BYTES, sha256(OLD_BYTES))

    assertEquals(ReplaceOutcome.Replaced(sha256(NEW_BYTES)), outcome)
    assertEquals(setOf("daily/a.org"), library.snapshot().keys)
    assertEquals(NEW_BYTES.toList(), library.snapshot()["daily/a.org"])
    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun aSmallerReplacementLeavesNoOldTail() {
    for (quirks in listOf(Quirks(), Quirks(supportsRename = false))) {
      val library = saf(quirks)
      try {
        library.seed("a.org", NEW_BYTES)
        val shorter = "short\n".toByteArray()
        library.open().replaceFile("a.org", shorter, sha256(NEW_BYTES))
        assertEquals(shorter.toList(), library.snapshot()["a.org"])
      } finally {
        library.close()
      }
    }
  }

  @Test
  fun aStaleSaveChangesNothing() = bothKinds { library ->
    library.seed("a.org", OLD_BYTES)

    val outcome = library.open().replaceFile("a.org", NEW_BYTES, sha256("something else".toByteArray()))

    assertEquals(ReplaceOutcome.Stale(sha256(OLD_BYTES)), outcome)
    assertEquals(OLD_BYTES.toList(), library.snapshot()["a.org"])
    assertEquals(setOf("a.org"), library.snapshot().keys)
    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun replacingAMissingFileFails() = bothKinds { library ->
    val outcome = library.open().replaceFile("a.org", NEW_BYTES, sha256(OLD_BYTES))
    assertEquals("not_found", (outcome as ReplaceOutcome.Failed).failure.kind)
  }

  @Test
  fun createNeverReplacesAndIgnoresCaseAndNormalization() = bothKinds { library ->
    library.seed("Café.org", OLD_BYTES)
    val open = library.open()

    assertEquals(CreateOutcome.Exists, open.createExclusive("Café.org", NEW_BYTES))
    assertEquals(CreateOutcome.Exists, open.createExclusive("café.ORG", NEW_BYTES))
    assertEquals(CreateOutcome.Exists, open.createExclusive("Café.org", NEW_BYTES))
    assertEquals(OLD_BYTES.toList(), library.snapshot()["Café.org"])
    assertEquals(setOf("Café.org"), library.snapshot().keys)
  }

  @Test
  fun createWritesExactBytesUnderTheExactName() = bothKinds { library ->
    library.seed("daily/keep.org", OLD_BYTES)

    assertEquals(CreateOutcome.Created("daily/a.org"), library.open().createExclusive("daily/a.org", NEW_BYTES))

    assertEquals(setOf("daily/keep.org", "daily/a.org"), library.snapshot().keys)
    assertEquals(NEW_BYTES.toList(), library.snapshot()["daily/a.org"])
    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun createNeedsAnExistingFolder() = bothKinds { library ->
    val outcome = library.open().createExclusive("nope/a.org", NEW_BYTES)
    assertEquals("not_found", (outcome as CreateOutcome.Failed).failure.kind)
    assertEquals(emptySet<String>(), library.snapshot().keys)
  }

  @Test
  fun anAddedExtensionIsCorrected() {
    val library = saf(Quirks(alterOnCreate = true))
    try {
      assertEquals(CreateOutcome.Created("a.org"), library.open().createExclusive("a.org", NEW_BYTES))
      assertEquals(setOf("a.org"), library.snapshot().keys)
    } finally {
      library.close()
    }
  }

  @Test
  fun anAddedExtensionThatCantBeCorrectedIsAFailureAndLeavesNothing() {
    val library = saf(Quirks(supportsRename = false, alterOnCreate = true))
    try {
      val outcome = library.open().createExclusive("a.org", NEW_BYTES)
      assertEquals("name_changed", (outcome as CreateOutcome.Failed).failure.kind)
      assertEquals(emptySet<String>(), library.snapshot().keys)
    } finally {
      library.close()
    }
  }

  @Test
  fun aProviderThatAltersEveryRenameIsSavedInPlace() {
    val library = saf(Quirks(alterEveryRename = true))
    try {
      library.seed("a.org", OLD_BYTES)
      val outcome = library.open().replaceFile("a.org", NEW_BYTES, sha256(OLD_BYTES))
      assertEquals(ReplaceOutcome.Replaced(sha256(NEW_BYTES)), outcome)
      assertEquals(setOf("a.org"), library.snapshot().keys)
      assertEquals(NEW_BYTES.toList(), library.snapshot()["a.org"])
    } finally {
      library.close()
    }
  }

  @Test
  fun recoveryForAFolderThatWasDeletedLetsTheLibraryOpen() = bothKinds { library ->
    library.journals.write(Journal("gone", SaveMode.SWAP, "deleted/a.org", sha256(NEW_BYTES)))

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun recoveryLeavesAFileOtherToolsPutAtTheTarget() = bothKinds { library ->
    val other = "written by a sync tool during the gap\n".toByteArray()
    library.seed("a.org", other)
    library.journals.write(Journal("id", SaveMode.SWAP, "a.org", sha256(NEW_BYTES)))
    library.seed(".roamlet-id.old", OLD_BYTES)
    library.seed(".roamlet-id.tmp", NEW_BYTES)

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(setOf("a.org"), library.snapshot().keys)
    assertEquals(other.toList(), library.snapshot()["a.org"])
  }

  @Test
  fun recoveryPutsTheOriginalBackWhenTheTempIsIncomplete() = bothKinds { library ->
    library.journals.write(Journal("id", SaveMode.SWAP, "a.org", sha256(NEW_BYTES)))
    library.seed(".roamlet-id.old", OLD_BYTES)
    library.seed(".roamlet-id.tmp", NEW_BYTES.copyOf(5))

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(setOf("a.org"), library.snapshot().keys)
    assertEquals(OLD_BYTES.toList(), library.snapshot()["a.org"])
  }

  @Test
  fun recoveryPutsTheOriginalBackWhenTheTempIsGone() = bothKinds { library ->
    library.journals.write(Journal("id", SaveMode.SWAP, "a.org", sha256(NEW_BYTES)))
    library.seed(".roamlet-id.old", OLD_BYTES)

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(setOf("a.org"), library.snapshot().keys)
    assertEquals(OLD_BYTES.toList(), library.snapshot()["a.org"])
  }

  @Test
  fun recoveryFinishesASwapFromACompleteTemp() = bothKinds { library ->
    library.journals.write(Journal("id", SaveMode.SWAP, "a.org", sha256(NEW_BYTES)))
    library.seed(".roamlet-id.old", OLD_BYTES)
    library.seed(".roamlet-id.tmp", NEW_BYTES)

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(setOf("a.org"), library.snapshot().keys)
    assertEquals(NEW_BYTES.toList(), library.snapshot()["a.org"])
  }

  @Test
  fun recoveryRestoresABackupOverAPartialFile() = bothKinds { library ->
    library.seed("a.org", NEW_BYTES.copyOf(5))
    library.journals.writeBackup("id", OLD_BYTES)
    library.journals.write(Journal("id", SaveMode.IN_PLACE, "a.org", sha256(NEW_BYTES), sha256(OLD_BYTES)))

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(OLD_BYTES.toList(), library.snapshot()["a.org"])
    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun aFileTheProviderRefusesToWriteIsLeftAlone() {
    val library = saf(Quirks(readOnlyFiles = true))
    try {
      library.seed("a.org", OLD_BYTES)
      val outcome = library.open().replaceFile("a.org", NEW_BYTES, sha256(OLD_BYTES))
      assertEquals("access_denied", (outcome as ReplaceOutcome.Failed).failure.kind)
      assertEquals(OLD_BYTES.toList(), library.snapshot()["a.org"])
      assertEquals(setOf("a.org"), library.snapshot().keys)
    } finally {
      library.close()
    }
  }

  @Test
  fun recoverySweepsStrandedBackups() = bothKinds { library ->
    library.journals.writeBackup("stranded", OLD_BYTES)

    assertEquals(RecoverOutcome.Ok, library.open().recover())

    assertEquals(emptyList<String>(), library.journalDir.allFiles())
  }

  @Test
  fun requestDownloadFetchesFoundFilesAndReportsTheRest() = bothKinds { library ->
    library.seed("a.org", OLD_BYTES)
    val open = library.open()
    val fetched = mutableListOf<String>()

    val failures = open.requestDownload(listOf("a.org", "nope.org")) { doc ->
      open.touch(doc)
      fetched.add(doc.name)
    }

    assertEquals(listOf("a.org"), fetched)
    assertEquals("nope.org", failures.single().path)
    assertEquals("not_found", failures.single().failure.kind)
  }

  @Test
  fun adoptingATreeTakesTheGrantAndGivesAStableId() {
    val library = saf()
    try {
      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      val first = adoptPickedTree(resolver, library.treeUri, flags) as PickOutcome.Picked
      val second = adoptPickedTree(resolver, library.treeUri, flags) as PickOutcome.Picked

      assertEquals("Notes", first.root.name)
      assertEquals(library.treeUri.toString(), first.root.reference)
      assertEquals(first.root.id, second.root.id)
      assertTrue(first.root.id.matches(Regex("[0-9a-f]+")))
      assertTrue(first.writable)
      assertEquals(emptySet<String>(), library.snapshot().keys)
    } finally {
      library.close()
    }
  }

  @Test
  fun aReadOnlyGrantIsNotWritable() {
    val library = saf()
    try {
      val outcome = adoptPickedTree(resolver, library.treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      assertEquals(false, (outcome as PickOutcome.Picked).writable)
      assertEquals(RestoreOutcome.Usable(false), restoreExternal(resolver, library.treeUri.toString()))
    } finally {
      library.close()
    }
  }

  @Test
  fun restoreTellsRevokedFromMissing() {
    val library = saf()
    try {
      val reference = library.treeUri.toString()
      assertEquals(RestoreOutcome.Revoked, restoreExternal(resolver, reference))

      val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      adoptPickedTree(resolver, library.treeUri, flags)
      assertEquals(RestoreOutcome.Usable(true), restoreExternal(resolver, reference))

      library.provider.removeRootForTest()
      assertEquals(RestoreOutcome.Missing, restoreExternal(resolver, reference))
    } finally {
      library.close()
    }
  }
}
