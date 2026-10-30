import Foundation

struct ExternalRoot: Equatable {
  let id: String
  let name: String
  let reference: String
}

enum RestoreOutcome: Equatable {
  case ok(writable: Bool)
  case stale(root: ExternalRoot, writable: Bool)
  case revoked
  case missing
}

/// Lasting access to folders the user picked: saved bookmarks and the security scopes they open.
/// Scopes stay open for as long as the library is in use, not per call, because a scope opened and
/// closed around each file operation would cost a provider round trip each time.
final class FolderAccess {
  private struct Hold {
    let url: URL
    let scoped: Bool
  }

  /// Test seam for what only a device can produce: out-of-date bookmarks and revoked access.
  var resolveBookmark: (Data) throws -> (url: URL, isStale: Bool) = { data in
    var isStale = false
    let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &isStale)
    return (url, isStale)
  }

  private let lock = NSLock()
  private var holds: [String: Hold] = [:]

  /// Takes a folder from the picker: opens its scope and saves a bookmark while the scope is open.
  /// Nil when the folder can't be read or bookmarked, as with a provider that refuses folder access.
  /// A picked folder doesn't become active here, so the active library's scope is left alone.
  func adopt(_ url: URL) -> (root: ExternalRoot, writable: Bool)? {
    let scoped = url.startAccessingSecurityScopedResource()
    guard
      FolderAccess.probe(url) == nil,
      let bookmark = try? FolderAccess.bookmark(for: url)
    else {
      if scoped {
        url.stopAccessingSecurityScopedResource()
      }
      return nil
    }
    let root = ExternalRoot(id: FolderAccess.id(of: url), name: url.lastPathComponent, reference: bookmark)
    hold(Hold(url: url, scoped: scoped), for: root.id)
    return (root, FolderAccess.isWritable(url))
  }

  /// Resolves a saved root and makes it the one active scope, closing any others. Refreshes an
  /// out-of-date bookmark. If the refresh fails the old bookmark still works, so that stays `ok`, and
  /// the next launch tries again.
  func restore(_ root: ExternalRoot) -> RestoreOutcome {
    guard let bookmark = Data(base64Encoded: root.reference) else {
      return .revoked
    }
    let resolved: (url: URL, isStale: Bool)
    do {
      resolved = try resolveBookmark(bookmark)
    } catch {
      return FolderAccess.unavailable(error)
    }
    let url = resolved.url
    let scoped = url.startAccessingSecurityScopedResource()
    if let error = FolderAccess.probe(url) {
      if scoped {
        url.stopAccessingSecurityScopedResource()
      }
      return FolderAccess.unavailable(error)
    }
    makeOnlyHold(Hold(url: url, scoped: scoped), for: root.id)
    let writable = FolderAccess.isWritable(url)
    if resolved.isStale, let refreshed = try? FolderAccess.bookmark(for: url) {
      let refreshedRoot = ExternalRoot(id: root.id, name: url.lastPathComponent, reference: refreshed)
      return .stale(root: refreshedRoot, writable: writable)
    }
    return .ok(writable: writable)
  }

  /// Closes every scope, for when the app-owned folder becomes the active library.
  func releaseAll() {
    let released = takeHolds()
    released.forEach(FolderAccess.close)
  }

  /// The folder behind a root that `adopt` or `restore` opened.
  func url(forRootId id: String) -> URL? {
    lock.lock()
    defer { lock.unlock() }
    return holds[id]?.url
  }

  private func hold(_ hold: Hold, for id: String) {
    lock.lock()
    let previous = holds.updateValue(hold, forKey: id)
    lock.unlock()
    if let previous {
      FolderAccess.close(previous)
    }
  }

  /// The new scope opens before the old ones close, so a call in flight on this root keeps access.
  private func makeOnlyHold(_ hold: Hold, for id: String) {
    let released = takeHolds()
    self.hold(hold, for: id)
    released.forEach(FolderAccess.close)
  }

  private func takeHolds() -> [Hold] {
    lock.lock()
    defer { lock.unlock() }
    let released = Array(holds.values)
    holds.removeAll()
    return released
  }

  private static func close(_ hold: Hold) {
    if hold.scoped {
      hold.url.stopAccessingSecurityScopedResource()
    }
  }

  private static func bookmark(for url: URL) throws -> String {
    return try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
      .base64EncodedString()
  }

  /// Hashed so it's safe as a path segment, and resolved so one folder has only one id.
  private static func id(of url: URL) -> String {
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    return String(LibraryFiles.sha256(of: Data(path.utf8)).prefix(32))
  }

  private static func isWritable(_ url: URL) -> Bool {
    return (try? url.resourceValues(forKeys: [.isWritableKey]).isWritable) == true
  }

  /// Why the folder can't be listed, or nil if it can. Deliberately uncoordinated: a provider that's
  /// slow to coordinate shouldn't hold up launch, and the first real listing coordinates anyway.
  private static func probe(_ url: URL) -> Error? {
    do {
      _ = try FileManager.default.contentsOfDirectory(atPath: url.path)
      return nil
    } catch {
      return error
    }
  }

  private static func unavailable(_ error: Error) -> RestoreOutcome {
    return FileFailure.kind(of: error as NSError) == .notFound ? .missing : .revoked
  }
}
