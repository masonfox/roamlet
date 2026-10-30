package com.roamlet.fs

import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream

/** The app-owned folder, through ordinary file paths. */
internal class PlainFileBackend(private val rootDir: File) : LibraryBackend {
  override fun root(): Doc = rootDir.toDoc()

  override fun children(dir: Doc): List<Doc> =
    File(dir.ref).listFiles()?.map { it.toDoc() } ?: throw IOException("can't list ${dir.name}")

  override fun create(dir: Doc, name: String): Doc {
    val file = File(dir.ref, name)
    if (!file.createNewFile()) throw IOException("$name already exists")
    return file.toDoc()
  }

  override fun rename(doc: Doc, name: String): Doc {
    val source = File(doc.ref)
    val destination = File(source.parentFile, name)
    // File.renameTo silently replaces an existing file.
    if (destination.exists()) throw IOException("$name already exists")
    if (!source.renameTo(destination)) throw IOException("can't rename ${doc.name}")
    return destination.toDoc()
  }

  override fun delete(doc: Doc) {
    if (!File(doc.ref).delete()) throw IOException("can't delete ${doc.name}")
  }

  override fun openRead(doc: Doc): InputStream = FileInputStream(doc.ref)

  override fun write(doc: Doc, bytes: ByteArray) {
    FileOutputStream(doc.ref).use {
      it.write(bytes)
      it.flush()
      it.fd.sync()
    }
  }
}

private fun File.toDoc(): Doc {
  if (!exists()) throw FileNotFoundException(path)
  return Doc(
    ref = path,
    name = name,
    isDir = isDirectory,
    size = if (isDirectory) 0 else length(),
    mtime = lastModified(),
    canWrite = canWrite(),
    canRename = true,
    canDelete = true,
    canCreate = isDirectory && canWrite(),
  )
}
