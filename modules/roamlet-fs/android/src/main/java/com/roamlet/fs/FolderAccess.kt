package com.roamlet.fs

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.providers.AppContextProvider
import java.io.FileNotFoundException
import java.io.IOException
import java.io.Serializable

internal data class ExternalRoot(val id: String, val name: String, val reference: String)

internal sealed class RestoreOutcome {
  data class Usable(val writable: Boolean) : RestoreOutcome()
  object Revoked : RestoreOutcome()
  object Missing : RestoreOutcome()
}

internal sealed class PickOutcome {
  data class Picked(val root: ExternalRoot, val writable: Boolean) : PickOutcome()
  object Cancelled : PickOutcome()
  object UnsupportedProvider : PickOutcome()
  data class PickerFailed(val message: String) : PickOutcome()
}

/** Checks the persisted grant and that the tree still exists. */
internal fun restoreExternal(resolver: ContentResolver, reference: String): RestoreOutcome {
  val treeUri = Uri.parse(reference)
  val grant = resolver.persistedUriPermissions.firstOrNull { it.uri == treeUri && it.isReadPermission }
    ?: return RestoreOutcome.Revoked
  return try {
    val root = SafBackend(resolver, treeUri).root()
    RestoreOutcome.Usable(grant.isWritePermission && root.canCreate)
  } catch (_: SecurityException) {
    RestoreOutcome.Revoked
  } catch (_: FileNotFoundException) {
    RestoreOutcome.Missing
  } catch (_: IllegalArgumentException) {
    // What several providers throw for a document id that no longer resolves.
    RestoreOutcome.Missing
  } catch (_: IOException) {
    RestoreOutcome.Missing
  }
}

/** Takes the lasting grant on a tree the picker returned, and writes nothing to the folder. */
@SuppressLint("WrongConstant")
internal fun adoptPickedTree(resolver: ContentResolver, treeUri: Uri, grantFlags: Int): PickOutcome {
  val flags = grantFlags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
  return try {
    resolver.takePersistableUriPermission(treeUri, flags)
    val root = SafBackend(resolver, treeUri).root()
    val reference = treeUri.toString()
    PickOutcome.Picked(
      // Stable for the folder, and safe as a path segment for libraries/<libraryId>/.
      ExternalRoot(sha256(reference.toByteArray()).take(32), root.name, reference),
      flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0 && root.canCreate,
    )
  } catch (_: SecurityException) {
    PickOutcome.UnsupportedProvider
  } catch (e: Exception) {
    PickOutcome.PickerFailed(e.message ?: e.javaClass.simpleName)
  }
}

internal class PickFolderInput : Serializable

internal class FolderPickerContract(
  private val appContextProvider: AppContextProvider,
) : AppContextActivityResultContract<PickFolderInput, PickOutcome> {
  override fun createIntent(context: Context, input: PickFolderInput): Intent =
    Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)

  override fun parseResult(input: PickFolderInput, resultCode: Int, intent: Intent?): PickOutcome {
    if (resultCode == Activity.RESULT_CANCELED || intent == null) return PickOutcome.Cancelled
    val treeUri = intent.data ?: return PickOutcome.Cancelled
    val context = appContextProvider.appContext.reactContext
      ?: return PickOutcome.PickerFailed("React context is gone")
    return adoptPickedTree(context.contentResolver, treeUri, intent.flags)
  }
}
