package com.roamlet.fs

import android.content.Context
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

private const val APP_OWNED_KIND = "app_owned"
private const val APP_OWNED_ID = "app-owned"
private const val APP_OWNED_FOLDER = "org-roam"

internal class RootArg : Record {
  @Field var kind: String = ""
  @Field var id: String? = null
  @Field var name: String? = null
  @Field var reference: String? = null
}

class RoamletFsModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val libraries = ConcurrentHashMap<String, RoamletLibrary>()

  // Reads wait for the provider's fetch, and `requestDownload` must not.
  private val fetches = Executors.newFixedThreadPool(4)

  override fun definition() = ModuleDefinition {
    Name("RoamletFs")

    lateinit var pickerLauncher: AppContextActivityResultLauncher<PickFolderInput, PickOutcome>

    RegisterActivityContracts {
      pickerLauncher = registerForActivityResult(FolderPickerContract(this@RoamletFsModule))
    }

    AsyncFunction("pickFolder") Coroutine { ->
      // A launch can reject after a configuration-change relaunch (design.md, issue #50386).
      val outcome = try {
        pickerLauncher.launch(PickFolderInput())
      } catch (e: Exception) {
        PickOutcome.PickerFailed(e.message ?: e.javaClass.simpleName)
      }
      outcome.toJs()
    }

    AsyncFunction("restore") { root: RootArg ->
      if (root.kind == APP_OWNED_KIND) {
        appOwnedDir().mkdirs()
        mapOf("status" to "ok", "writable" to true)
      } else {
        when (val outcome = restoreExternal(context.contentResolver, requireReference(root))) {
          is RestoreOutcome.Usable -> mapOf("status" to "ok", "writable" to outcome.writable)
          RestoreOutcome.Revoked -> mapOf("status" to "revoked")
          RestoreOutcome.Missing -> mapOf("status" to "missing")
        }
      }
    }

    AsyncFunction("recover") { root: RootArg ->
      when (val outcome = library(root).recover()) {
        RecoverOutcome.Ok -> mapOf("ok" to true)
        is RecoverOutcome.Failed -> mapOf("ok" to false, "failure" to outcome.failure.toJs())
      }
    }

    AsyncFunction("list") { root: RootArg ->
      val listing = library(root).list()
      mapOf(
        "entries" to listing.entries.map { it.toJs() },
        "failures" to listing.failures.map { it.toJs() },
      )
    }

    AsyncFunction("readBytes") { root: RootArg, path: String ->
      when (val outcome = library(root).readBytes(path)) {
        is ReadOutcome.Ok -> mapOf("ok" to true, "bytes" to outcome.bytes)
        is ReadOutcome.Failed -> mapOf("ok" to false, "failure" to outcome.failure.toJs())
      }
    }

    AsyncFunction("digest") { root: RootArg, path: String ->
      when (val outcome = library(root).digest(path)) {
        is DigestOutcome.Ok -> mapOf("ok" to true, "hash" to outcome.hash)
        is DigestOutcome.Failed -> mapOf("ok" to false, "failure" to outcome.failure.toJs())
      }
    }

    AsyncFunction("createExclusive") { root: RootArg, path: String, bytes: ByteArray ->
      when (val outcome = library(root).createExclusive(path, bytes)) {
        is CreateOutcome.Created -> mapOf("status" to "created", "path" to outcome.path)
        CreateOutcome.Exists -> mapOf("status" to "exists")
        is CreateOutcome.Failed -> mapOf("status" to "failed", "failure" to outcome.failure.toJs())
      }
    }

    AsyncFunction("replaceFile") { root: RootArg, path: String, bytes: ByteArray, expectedHash: String ->
      when (val outcome = library(root).replaceFile(path, bytes, expectedHash)) {
        is ReplaceOutcome.Replaced -> mapOf("status" to "replaced", "hash" to outcome.hash)
        is ReplaceOutcome.Stale -> mapOf("status" to "stale", "currentHash" to outcome.currentHash)
        is ReplaceOutcome.Failed -> mapOf("status" to "failed", "failure" to outcome.failure.toJs())
      }
    }

    AsyncFunction("requestDownload") { root: RootArg, paths: List<String> ->
      val library = library(root)
      val failures = library.requestDownload(paths) { doc ->
        fetches.execute {
          try {
            library.touch(doc)
          } catch (e: Exception) {
            Log.w("RoamletFs", "couldn't fetch ${doc.name}", e)
          }
        }
      }
      mapOf("failures" to failures.map { it.toJs() })
    }

    Function("internalDirectory") {
      context.filesDir.also { it.mkdirs() }.absolutePath
    }
  }

  private fun appOwnedDir() = File(context.filesDir, APP_OWNED_FOLDER)

  private fun requireReference(root: RootArg): String =
    requireNotNull(root.reference) { "an external root needs a reference" }

  private fun library(root: RootArg): RoamletLibrary {
    val id = if (root.kind == APP_OWNED_KIND) {
      APP_OWNED_ID
    } else {
      requireNotNull(root.id) { "an external root needs an id" }
    }
    require(!id.contains('/')) { "a library id must be one path segment" }
    return libraries.getOrPut(id) {
      val backend = if (root.kind == APP_OWNED_KIND) {
        PlainFileBackend(appOwnedDir().also { it.mkdirs() })
      } else {
        SafBackend(context.contentResolver, Uri.parse(requireReference(root)))
      }
      RoamletLibrary(backend, FileJournalStore(File(context.filesDir, "libraries/$id/txn")))
    }
  }
}

private fun PickOutcome.toJs(): Map<String, Any?> = when (this) {
  is PickOutcome.Picked -> mapOf(
    "status" to "picked",
    "root" to mapOf(
      "kind" to "external",
      "id" to root.id,
      "name" to root.name,
      "reference" to root.reference,
    ),
    "writable" to writable,
  )
  PickOutcome.Cancelled -> mapOf("status" to "cancelled")
  PickOutcome.UnsupportedProvider -> mapOf("status" to "unsupported_provider")
  is PickOutcome.PickerFailed -> mapOf("status" to "picker_failed", "message" to message)
}

private fun Failure.toJs() = mapOf("kind" to kind, "message" to message)

private fun PathFailure.toJs() = mapOf("path" to path, "failure" to failure.toJs())

private fun Entry.toJs() = mapOf(
  "name" to doc.name,
  "path" to path,
  "size" to if (doc.isDir) 0 else doc.size,
  "mtime" to doc.mtime,
  "isDir" to doc.isDir,
  // Android has no standard way to ask. Reading fetches the content, which is the same to a caller.
  "downloaded" to true,
  "writable" to if (doc.isDir) doc.canCreate else doc.canWrite,
)
