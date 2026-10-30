import CryptoKit
import Foundation

// File access inside one library root (design.md, Decisions 3 and 4). Foundation only, so the save
// protocol can be tested on a plain directory without Expo. Every operation blocks its thread while
// it waits for coordination, so callers must stay off the main thread.

enum FileFailureKind: String {
  case notFound = "not_found"
  case accessDenied = "access_denied"
  case notDownloaded = "not_downloaded"
  case providerError = "provider_error"
  case nameChanged = "name_changed"
}

struct FileFailure: Error, Equatable {
  let kind: FileFailureKind
  let message: String

  init(_ kind: FileFailureKind, _ message: String) {
    self.kind = kind
    self.message = message
  }

  init(_ error: Error) {
    if let failure = error as? FileFailure {
      self = failure
      return
    }
    let nsError = error as NSError
    self = FileFailure(FileFailure.kind(of: nsError), "\(nsError.domain) \(nsError.code): \(nsError.localizedDescription)")
  }

  static func kind(of error: NSError) -> FileFailureKind {
    if error.domain == NSCocoaErrorDomain {
      switch error.code {
      case NSFileNoSuchFileError, NSFileReadNoSuchFileError:
        return .notFound
      case NSFileReadNoPermissionError, NSFileWriteNoPermissionError, NSFileWriteVolumeReadOnlyError:
        return .accessDenied
      case NSUbiquitousFileUnavailableError, NSUbiquitousFileNotUploadedDueToQuotaError:
        return .providerError
      default:
        break
      }
    }
    if error.domain == NSPOSIXErrorDomain {
      switch Int32(error.code) {
      case ENOENT, ENOTDIR:
        return .notFound
      case EACCES, EPERM, EROFS:
        return .accessDenied
      default:
        break
      }
    }
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
      return kind(of: underlying)
    }
    return .providerError
  }
}

struct FileEntry: Equatable {
  let name: String
  let path: String
  let size: Int64
  /// Milliseconds since the Unix epoch.
  let mtime: Double
  let isDir: Bool
  let downloaded: Bool
  let writable: Bool
}

struct PathFailure: Equatable {
  let path: String
  let failure: FileFailure
}

struct ListOutcome {
  var entries: [FileEntry] = []
  var failures: [PathFailure] = []
}

enum CreateOutcome: Equatable {
  case created(path: String)
  case exists
  case failed(FileFailure)
}

enum ReplaceOutcome: Equatable {
  case replaced(hash: String)
  case stale(currentHash: String)
  case failed(FileFailure)
}

/// The points in a save that a test can interrupt. Throwing from one models any failure there.
enum SaveStep {
  case checkedCurrent
  case wroteTemp
  case verifiedTemp
  case swapped
}

struct LibraryFiles {
  /// How long to wait for another process to give up a file before reporting a provider error. Only
  /// the wait is bounded. Work inside a coordinated block runs to completion.
  static let defaultCoordinationTimeout: TimeInterval = 60

  let root: URL
  var coordinationTimeout = LibraryFiles.defaultCoordinationTimeout
  /// Test seam, called as each save step finishes.
  var onStep: (SaveStep, URL) throws -> Void = { _, _ in }
  /// Test seam for providers that move or rename during the swap. Returns where the file ended up.
  var swapItem: (URL, URL) throws -> URL? = { target, temp in
    try FileManager.default.replaceItemAt(target, withItemAt: temp, backupItemName: nil, options: [])
  }

  init(root: URL) {
    self.root = root
  }

  // MARK: - Listing

  /// Walks the library, coordinating one directory at a time so a failure stays local to that
  /// directory: the entries under it are unknown, not gone (Decision 5).
  func list() -> ListOutcome {
    var outcome = ListOutcome()
    var pending = [""]
    while let directory = pending.popLast() {
      do {
        let url = directory.isEmpty ? root : try resolve(directory)
        try coordinatedRead(url) { readable in
          let children = try FileManager.default.contentsOfDirectory(
            at: readable,
            includingPropertiesForKeys: Array(LibraryFiles.entryKeys),
            options: []
          )
          let names = Set(children.map(\.lastPathComponent))
          for child in children {
            let found = LibraryFiles.visibleName(of: child.lastPathComponent, among: names)
            guard let name = found else { continue }
            let path = directory.isEmpty ? name : "\(directory)/\(name)"
            do {
              guard let entry = try LibraryFiles.entry(at: child, name: name, path: path) else { continue }
              outcome.entries.append(entry)
              if entry.isDir {
                pending.append(path)
              }
            } catch {
              outcome.failures.append(PathFailure(path: path, failure: FileFailure(error)))
            }
          }
        }
      } catch {
        outcome.failures.append(PathFailure(path: directory, failure: FileFailure(error)))
      }
    }
    return outcome
  }

  private static let entryKeys: Set<URLResourceKey> = [
    .isDirectoryKey,
    .isSymbolicLinkKey,
    .fileSizeKey,
    .contentModificationDateKey,
    .isWritableKey,
    .isUbiquitousItemKey,
    .ubiquitousItemDownloadingStatusKey,
  ]

  /// The name to list a directory child under, or nil if it stays out of the listing. Hidden files
  /// are skipped except iCloud placeholders (`.name.org.icloud`), which stand for `name.org`.
  private static func visibleName(of name: String, among names: Set<String>) -> String? {
    guard name.hasPrefix(".") else { return name }
    guard let logical = logicalName(ofPlaceholder: name), !logical.hasPrefix("."), !names.contains(logical) else {
      return nil
    }
    return logical
  }

  private static func logicalName(ofPlaceholder name: String) -> String? {
    guard name.hasPrefix("."), name.hasSuffix(".icloud"), name.count > ".".count + ".icloud".count else {
      return nil
    }
    return String(name.dropFirst().dropLast(".icloud".count))
  }

  /// Nil for symbolic links, which aren't followed: a link back up the tree would never finish.
  private static func entry(at url: URL, name: String, path: String) throws -> FileEntry? {
    let values = try url.resourceValues(forKeys: entryKeys)
    if values.isSymbolicLink == true {
      return nil
    }
    let isDir = values.isDirectory == true
    let isPlaceholder = url.lastPathComponent != name
    return FileEntry(
      name: name,
      path: path,
      size: isDir || isPlaceholder ? 0 : Int64(values.fileSize ?? 0),
      mtime: ((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded(),
      isDir: isDir,
      downloaded: !isPlaceholder && !isNotDownloaded(values),
      writable: values.isWritable == true
    )
  }

  private static func isNotDownloaded(_ values: URLResourceValues) -> Bool {
    return values.isUbiquitousItem == true && values.ubiquitousItemDownloadingStatus == .notDownloaded
  }

  // MARK: - Reading

  func readBytes(_ path: String) throws -> Data {
    let url = try resolve(path)
    try requireOnDevice(url)
    return try coordinatedRead(url) { readable in
      try Data(contentsOf: readable)
    }
  }

  func digest(_ path: String) throws -> String {
    let url = try resolve(path)
    try requireOnDevice(url)
    return try coordinatedRead(url) { readable in
      try LibraryFiles.sha256(of: readable)
    }
  }

  // MARK: - Writing

  /// Never replaces anything. The bytes are verified in a temp file and then moved in, so the note's
  /// name never holds partial content, and a crash leaves only a temp file the OS cleans up.
  func createExclusive(_ path: String, bytes: Data) -> CreateOutcome {
    do {
      let target = try resolve(path)
      let name = target.lastPathComponent
      let parent = target.deletingLastPathComponent()
      return try coordinatedWrite(target, options: []) { writable in
        if try LibraryFiles.nameIsTaken(name, in: parent) {
          return .exists
        }
        let tempDirectory = try LibraryFiles.replacementDirectory(for: parent)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }
        let temp = LibraryFiles.tempFile(in: tempDirectory)
        try LibraryFiles.writeDurably(bytes, to: temp)
        try onStep(.wroteTemp, temp)
        guard try LibraryFiles.sha256(of: temp) == LibraryFiles.sha256(of: bytes) else {
          throw FileFailure(.providerError, "temp file did not read back as written")
        }
        try onStep(.verifiedTemp, temp)
        do {
          try FileManager.default.moveItem(at: temp, to: writable)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileWriteFileExistsError {
          return .exists
        }
        try onStep(.swapped, writable)
        try LibraryFiles.verifyName(of: writable, expected: name)
        return .created(path: path)
      }
    } catch {
      return .failed(FileFailure(error))
    }
  }

  /// Decision 4, iOS: all three steps run inside one coordinated write. The target isn't touched
  /// before `replaceItemAt`, so a crash or failure up to there leaves the old content in place.
  func replaceFile(_ path: String, bytes: Data, expectedHash: String) -> ReplaceOutcome {
    do {
      let target = try resolve(path)
      try requireOnDevice(target)
      return try coordinatedWrite(target, options: .forReplacing) { writable in
        // 1. Stale check, as close to the write as coordination allows.
        let currentHash = try LibraryFiles.sha256(of: writable)
        guard currentHash == expectedHash else {
          return .stale(currentHash: currentHash)
        }
        try onStep(.checkedCurrent, writable)

        // 2. New bytes in a temp file, read back and verified.
        let newHash = LibraryFiles.sha256(of: bytes)
        let tempDirectory = try LibraryFiles.replacementDirectory(for: writable)
        defer { try? FileManager.default.removeItem(at: tempDirectory) }
        let temp = LibraryFiles.tempFile(in: tempDirectory)
        try LibraryFiles.writeDurably(bytes, to: temp)
        try onStep(.wroteTemp, temp)
        guard try LibraryFiles.sha256(of: temp) == newHash else {
          throw FileFailure(.providerError, "temp file did not read back as written")
        }
        try onStep(.verifiedTemp, temp)

        // 3. Swap, then check the name and content that ended up there.
        let swapped = try swapItem(writable, temp) ?? writable
        try onStep(.swapped, swapped)
        if swapped.lastPathComponent != writable.lastPathComponent {
          do {
            try FileManager.default.moveItem(at: swapped, to: writable)
          } catch {
            throw FileFailure(.nameChanged, "stored as \(swapped.lastPathComponent)")
          }
        }
        try LibraryFiles.verifyName(of: writable, expected: writable.lastPathComponent)
        guard try LibraryFiles.sha256(of: writable) == newHash else {
          throw FileFailure(.providerError, "replaced file did not read back as written")
        }
        return .replaced(hash: newHash)
      }
    } catch {
      return .failed(FileFailure(error))
    }
  }

  // MARK: - Downloads

  /// Asks the provider for each file without waiting. Files already local need nothing.
  func requestDownload(_ paths: [String]) -> [PathFailure] {
    var failures: [PathFailure] = []
    for path in paths {
      do {
        let url = try resolve(path)
        if LibraryFiles.placeholder(for: url) == nil {
          let values = try url.resourceValues(forKeys: [.isUbiquitousItemKey])
          if values.isUbiquitousItem != true {
            continue
          }
        }
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
      } catch {
        failures.append(PathFailure(path: path, failure: FileFailure(error)))
      }
    }
    return failures
  }

  // MARK: - Helpers

  /// Library-relative paths come across the bridge, so they're refused if they could leave the root.
  private func resolve(_ path: String) throws -> URL {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
      throw FileFailure(.notFound, "not a library path: \(path)")
    }
    return segments.reduce(root) { $0.appendingPathComponent(String($1)) }
  }

  /// Checked before coordinating, because a coordinated read of an evicted file waits for the
  /// download, which never finishes offline. Asking for the download is the caller's choice.
  private func requireOnDevice(_ url: URL) throws {
    if LibraryFiles.placeholder(for: url) != nil {
      throw FileFailure(.notDownloaded, url.lastPathComponent)
    }
    let values = try url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
    if LibraryFiles.isNotDownloaded(values) {
      throw FileFailure(.notDownloaded, url.lastPathComponent)
    }
  }

  /// The placeholder standing in for a missing file, if there is one.
  private static func placeholder(for url: URL) -> URL? {
    if FileManager.default.fileExists(atPath: url.path) {
      return nil
    }
    let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    return FileManager.default.fileExists(atPath: placeholder.path) ? placeholder : nil
  }

  /// Compares normalized, case-folded names (design.md, Risks), and counts iCloud placeholders, so a
  /// note can't be created beside one that differs only in form or is only in the cloud.
  private static func nameIsTaken(_ name: String, in directory: URL) throws -> Bool {
    let wanted = collisionKey(name)
    return try FileManager.default.contentsOfDirectory(atPath: directory.path).contains { sibling in
      collisionKey(logicalName(ofPlaceholder: sibling) ?? sibling) == wanted
    }
  }

  private static func collisionKey(_ name: String) -> String {
    return name.precomposedStringWithCanonicalMapping.folding(options: .caseInsensitive, locale: nil)
  }

  private static func replacementDirectory(for url: URL) throws -> URL {
    return try FileManager.default.url(
      for: .itemReplacementDirectory,
      in: .userDomainMask,
      appropriateFor: url,
      create: true
    )
  }

  /// Hidden and not `.org`, because some providers put the replacement directory beside the target,
  /// and a leftover there must never look like a note.
  private static func tempFile(in directory: URL) -> URL {
    return directory.appendingPathComponent(".roamlet-\(UUID().uuidString.lowercased()).tmp")
  }

  private static func writeDurably(_ bytes: Data, to url: URL) throws {
    try bytes.write(to: url)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
  }

  /// Compares the name on disk, since a URL only repeats what it was built from.
  private static func verifyName(of url: URL, expected: String) throws {
    let values = try url.resourceValues(forKeys: [.nameKey])
    guard values.name == expected else {
      throw FileFailure(.nameChanged, "stored as \(values.name ?? "an unknown name")")
    }
  }

  static func sha256(of data: Data) -> String {
    return hex(SHA256.hash(data: data))
  }

  /// Streams, so hashing a large file during reconcile doesn't hold it all in memory.
  static func sha256(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hex(hasher.finalize())
  }

  private static func hex(_ digest: SHA256.Digest) -> String {
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - Coordination

  private func coordinatedRead<T>(_ url: URL, _ work: (URL) throws -> T) throws -> T {
    return try coordinate(work) { coordinator, error, accessor in
      coordinator.coordinate(readingItemAt: url, options: [], error: error, byAccessor: accessor)
    }
  }

  private func coordinatedWrite<T>(
    _ url: URL,
    options: NSFileCoordinator.WritingOptions,
    _ work: (URL) throws -> T
  ) throws -> T {
    return try coordinate(work) { coordinator, error, accessor in
      coordinator.coordinate(writingItemAt: url, options: options, error: error, byAccessor: accessor)
    }
  }

  /// Work inside the accessor must not coordinate again on the same item: that can deadlock.
  private func coordinate<T>(
    _ work: (URL) throws -> T,
    start: (NSFileCoordinator, NSErrorPointer, (URL) -> Void) -> Void
  ) throws -> T {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    let timeout = DispatchWorkItem { coordinator.cancel() }
    DispatchQueue.global().asyncAfter(deadline: .now() + coordinationTimeout, execute: timeout)
    defer { timeout.cancel() }

    var coordinationError: NSError?
    var result: Result<T, Error>?
    start(coordinator, &coordinationError) { url in
      result = Result { try work(url) }
    }
    if let result {
      return try result.get()
    }
    if let coordinationError {
      throw coordinationError
    }
    throw FileFailure(.providerError, "file coordination ended without access")
  }
}
