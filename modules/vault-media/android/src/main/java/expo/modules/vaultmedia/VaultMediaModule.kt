package expo.modules.vaultmedia

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.Serializable
import java.security.SecureRandom

/**
 * Picking that keeps a handle the app is allowed to delete with.
 *
 * The system photo picker returns a URI that cannot be resolved back to a MediaStore row, so an
 * import has nothing to delete the original by -- and `ACTION_GET_CONTENT` is no help either,
 * because Android 13+ substitutes the photo picker for it whenever the MIME filter is image or
 * video ("GET_CONTENT takeover"). `ACTION_OPEN_DOCUMENT` is not substituted, and the URI it
 * returns is a Storage Access Framework document: the exact item the user chose, carrying a
 * permission grant that authorises deleting it.
 *
 * Nothing here asks for a permission. `DocumentsContract.deleteDocument` is served by the document
 * provider, which performs the delete under its own identity after checking the grant -- which is
 * why this app can remove an imported original while still declaring no media-read permission at
 * all.
 */
class VaultMediaModule : Module() {
  private lateinit var pickLauncher:
    AppContextActivityResultLauncher<OpenDocumentOptions, OpenDocumentResult>

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("VaultMedia")

    /**
     * Opens the document picker and copies each chosen item into app-private cache.
     *
     * The copy exists because the rest of the import reads and wipes a plain file; the document
     * URI is returned alongside it, unchanged, so the original can be deleted later by identity
     * rather than by matching on a name or a timestamp.
     */
    AsyncFunction("pickAsync") Coroutine { options: PickOptions ->
      val picked = pickLauncher.launch(
        OpenDocumentOptions(
          mimeTypes = options.mimeTypes,
          allowsMultipleSelection = options.allowsMultipleSelection
        )
      )
      withContext(Dispatchers.IO) {
        picked.uris.mapNotNull { raw -> copyToCache(Uri.parse(raw)) }
      }
    }

    /**
     * Deletes the originals, by document URI.
     *
     * A document whose provider does not advertise `FLAG_SUPPORTS_DELETE` is left alone rather
     * than attempted: the caller is told how many went, and anything that did not is still in the
     * user's gallery. Nothing here throws for a refusal -- by the time it runs the vault already
     * holds encrypted copies, so a failure is a kept original, not a failed import.
     */
    AsyncFunction("deleteAsync") Coroutine { documentUris: List<String> ->
      withContext(Dispatchers.IO) {
        documentUris.count { raw ->
          runCatching { deleteDocument(Uri.parse(raw)) }.getOrDefault(false)
        }
      }
    }

    /** Whether each document could be deleted, without attempting it. Used by specs and triage. */
    AsyncFunction("canDeleteAsync") Coroutine { documentUris: List<String> ->
      withContext(Dispatchers.IO) {
        documentUris.map { raw -> runCatching { supportsDelete(Uri.parse(raw)) }.getOrDefault(false) }
      }
    }

    RegisterActivityContracts {
      pickLauncher = registerForActivityResult(OpenDocumentContract()) { _, _ -> }
    }
  }

  /** `FLAG_SUPPORTS_DELETE` on the document row. Absent for providers that serve read-only items. */
  private fun supportsDelete(uri: Uri): Boolean {
    context.contentResolver
      .query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)
      ?.use { cursor ->
        if (!cursor.moveToFirst()) return false
        val flags = cursor.getLong(0)
        return (flags and DocumentsContract.Document.FLAG_SUPPORTS_DELETE.toLong()) != 0L
      }
    return false
  }

  private fun deleteDocument(uri: Uri): Boolean {
    if (!DocumentsContract.isDocumentUri(context, uri)) return false
    if (!supportsDelete(uri)) return false
    return DocumentsContract.deleteDocument(context.contentResolver, uri)
  }

  /**
   * Copies one document into a private cache file.
   *
   * The name is random: this file is never shown to anyone, and a listing of the cache directory
   * should not say which of the user's photos is being imported.
   */
  private fun copyToCache(documentUri: Uri): PickedItem? {
    val resolver = context.contentResolver
    val mimeType = resolver.getType(documentUri)
    val (displayName, size) = queryOpenableColumns(documentUri)

    val directory = File(context.cacheDir, IMPORT_DIRECTORY).apply { mkdirs() }
    val target = File(directory, "${randomName()}${extensionFor(displayName, mimeType)}")

    return try {
      resolver.openInputStream(documentUri).use { input ->
        if (input == null) return null
        target.outputStream().use { output -> input.copyTo(output) }
      }
      PickedItem().apply {
        uri = Uri.fromFile(target).toString()
        this.documentUri = documentUri.toString()
        fileName = displayName
        fileSize = if (size >= 0) size.toDouble() else null
        this.mimeType = mimeType
        deletable = runCatching { supportsDelete(documentUri) }.getOrDefault(false)
      }
    } catch (_: Throwable) {
      target.delete()
      null
    }
  }

  private fun queryOpenableColumns(uri: Uri): Pair<String?, Long> {
    val projection = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    context.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        val name = if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null
        val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else -1L
        return name to size
      }
    }
    return null to -1L
  }

  private fun extensionFor(displayName: String?, mimeType: String?): String {
    val fromName = displayName?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() }
    if (fromName != null) return ".$fromName"
    val subtype = mimeType?.substringAfterLast('/', "")?.takeIf { it.isNotEmpty() } ?: return ".bin"
    return if (subtype == "jpeg") ".jpg" else ".$subtype"
  }

  private fun randomName(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
  }

  companion object {
    const val IMPORT_DIRECTORY = "vault-import"
  }
}

class PickOptions : Record {
  @Field val mimeTypes: List<String> = listOf("image/*", "video/*")
  @Field val allowsMultipleSelection: Boolean = true
}

class PickedItem : Record {
  /** A `file://` copy in app-private cache. The caller reads this and then wipes it. */
  @Field var uri: String = ""
  /** The Storage Access Framework document. The only thing that can delete the original. */
  @Field var documentUri: String = ""
  @Field var fileName: String? = null
  @Field var fileSize: Double? = null
  @Field var mimeType: String? = null
  /** Whether the provider will allow this document to be deleted at all. */
  @Field var deletable: Boolean = false
}

data class OpenDocumentOptions(
  val mimeTypes: List<String>,
  val allowsMultipleSelection: Boolean,
) : Serializable

data class OpenDocumentResult(val uris: List<String>) : Serializable

/**
 * `ACTION_OPEN_DOCUMENT`, deliberately not `ACTION_GET_CONTENT`.
 *
 * The intent type is left wide open and the real filter goes in `EXTRA_MIME_TYPES`, which is how
 * the picker wants a multi-type filter expressed.
 */
class OpenDocumentContract :
  AppContextActivityResultContract<OpenDocumentOptions, OpenDocumentResult> {
  override fun createIntent(context: Context, input: OpenDocumentOptions): Intent =
    Intent(Intent.ACTION_OPEN_DOCUMENT)
      .addCategory(Intent.CATEGORY_OPENABLE)
      .setType("*/*")
      .putExtra(Intent.EXTRA_MIME_TYPES, input.mimeTypes.toTypedArray())
      .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, input.allowsMultipleSelection)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

  override fun parseResult(
    input: OpenDocumentOptions,
    resultCode: Int,
    intent: Intent?,
  ): OpenDocumentResult {
    if (resultCode != Activity.RESULT_OK || intent == null) return OpenDocumentResult(emptyList())
    val uris = mutableListOf<String>()
    val clip = intent.clipData
    if (clip != null) {
      for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri.toString())
    } else {
      intent.data?.let { uris.add(it.toString()) }
    }
    return OpenDocumentResult(uris)
  }
}
