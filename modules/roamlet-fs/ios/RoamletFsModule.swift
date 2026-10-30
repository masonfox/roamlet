import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

struct LibraryRootRecord: Record {
  @Field var kind: String = ""
  @Field var id: String?
  @Field var name: String?
  @Field var reference: String?

  var external: ExternalRoot? {
    guard kind == "external", let id, let name, let reference else { return nil }
    return ExternalRoot(id: id, name: name, reference: reference)
  }
}

public final class RoamletFsModule: Module {
  private let access = FolderAccess()
  private var picking: FolderPicking?

  // Concurrent, because a read waiting on coordination must not hold up every other call. Writes to
  // one file still run one at a time, since coordination serializes them.
  private let fileQueue = DispatchQueue(label: "com.roamlet.fs.files", qos: .userInitiated, attributes: .concurrent)

  public func definition() -> ModuleDefinition {
    Name("RoamletFs")

    AsyncFunction("pickFolder") { (promise: Promise) in
      self.pickFolder(promise)
    }.runOnQueue(.main)

    AsyncFunction("restore") { (root: LibraryRootRecord) -> [String: Any] in
      return self.restore(root)
    }.runOnQueue(fileQueue)

    AsyncFunction("recover") { (root: LibraryRootRecord) -> [String: Any] in
      return self.recover(root)
    }.runOnQueue(fileQueue)

    AsyncFunction("list") { (root: LibraryRootRecord) -> [String: Any] in
      do {
        return Self.dictionary(try self.files(for: root).list())
      } catch {
        return [
          "entries": [[String: Any]](),
          "failures": [Self.dictionary(PathFailure(path: "", failure: FileFailure(error)))],
        ]
      }
    }.runOnQueue(fileQueue)

    AsyncFunction("readBytes") { (root: LibraryRootRecord, path: String) -> [String: Any] in
      do {
        return ["ok": true, "bytes": try self.files(for: root).readBytes(path)]
      } catch {
        return ["ok": false, "failure": Self.dictionary(FileFailure(error))]
      }
    }.runOnQueue(fileQueue)

    AsyncFunction("digest") { (root: LibraryRootRecord, path: String) -> [String: Any] in
      do {
        return ["ok": true, "hash": try self.files(for: root).digest(path)]
      } catch {
        return ["ok": false, "failure": Self.dictionary(FileFailure(error))]
      }
    }.runOnQueue(fileQueue)

    AsyncFunction("createExclusive") { (root: LibraryRootRecord, path: String, bytes: Data) -> [String: Any] in
      do {
        return Self.dictionary(try self.files(for: root).createExclusive(path, bytes: bytes))
      } catch {
        return Self.dictionary(CreateOutcome.failed(FileFailure(error)))
      }
    }.runOnQueue(fileQueue)

    AsyncFunction("replaceFile") { (root: LibraryRootRecord, path: String, bytes: Data, expectedHash: String) -> [String: Any] in
      do {
        return Self.dictionary(try self.files(for: root).replaceFile(path, bytes: bytes, expectedHash: expectedHash))
      } catch {
        return Self.dictionary(ReplaceOutcome.failed(FileFailure(error)))
      }
    }.runOnQueue(fileQueue)

    AsyncFunction("requestDownload") { (root: LibraryRootRecord, paths: [String]) -> [String: Any] in
      do {
        return ["failures": try self.files(for: root).requestDownload(paths).map(Self.dictionary)]
      } catch {
        return ["failures": paths.map { Self.dictionary(PathFailure(path: $0, failure: FileFailure(error))) }]
      }
    }.runOnQueue(fileQueue)

    Function("internalDirectory") { () -> String in
      return try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      ).path
    }
  }

  // MARK: - Roots

  private func appOwnedFolder() throws -> URL {
    return try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    ).appendingPathComponent("org-roam", isDirectory: true)
  }

  private func files(for root: LibraryRootRecord) throws -> LibraryFiles {
    if root.kind == "app_owned" {
      return LibraryFiles(root: try appOwnedFolder())
    }
    guard let id = root.id, let url = access.url(forRootId: id) else {
      throw FileFailure(.accessDenied, "root was not restored")
    }
    return LibraryFiles(root: url)
  }

  private func restore(_ root: LibraryRootRecord) -> [String: Any] {
    guard let external = root.external else {
      access.releaseAll()
      do {
        try FileManager.default.createDirectory(at: try appOwnedFolder(), withIntermediateDirectories: true)
        return ["status": "ok", "writable": true]
      } catch {
        return ["status": "missing"]
      }
    }
    switch access.restore(external) {
    case let .ok(writable):
      return ["status": "ok", "writable": writable]
    case let .stale(refreshed, writable):
      return ["status": "stale", "root": Self.dictionary(refreshed), "writable": writable]
    case .revoked:
      return ["status": "revoked"]
    case .missing:
      return ["status": "missing"]
    }
  }

  /// iOS saves leave nothing to finish (Decision 4): a crash before the swap leaves the original, and
  /// the OS cleans up the temp file. This only reports whether the folder can be reached.
  private func recover(_ root: LibraryRootRecord) -> [String: Any] {
    do {
      let url = try files(for: root).root
      _ = try FileManager.default.contentsOfDirectory(atPath: url.path)
      return ["ok": true]
    } catch {
      return ["ok": false, "failure": Self.dictionary(FileFailure(error))]
    }
  }

  // MARK: - Picker

  private func pickFolder(_ promise: Promise) {
    guard picking == nil else {
      promise.resolve(["status": "picker_failed", "message": "a folder picker is already open"])
      return
    }
    guard let presenter = appContext?.utilities?.currentViewController() else {
      promise.resolve(["status": "picker_failed", "message": "no view controller to present from"])
      return
    }
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    let session = FolderPicking { [weak self] url in
      self?.finishPicking(url, promise)
    }
    picking = session
    picker.delegate = session
    picker.presentationController?.delegate = session
    picker.modalPresentationStyle = .pageSheet
    presenter.present(picker, animated: true)
  }

  private func finishPicking(_ url: URL?, _ promise: Promise) {
    picking = nil
    guard let url else {
      promise.resolve(["status": "cancelled"])
      return
    }
    fileQueue.async {
      guard let adopted = self.access.adopt(url) else {
        promise.resolve(["status": "unsupported_provider"])
        return
      }
      let result: [String: Any] = ["status": "picked", "root": Self.dictionary(adopted.root), "writable": adopted.writable]
      promise.resolve(result)
    }
  }

  // MARK: - Results

  private static func dictionary(_ root: ExternalRoot) -> [String: Any] {
    return ["kind": "external", "id": root.id, "name": root.name, "reference": root.reference]
  }

  private static func dictionary(_ failure: FileFailure) -> [String: Any] {
    return ["kind": failure.kind.rawValue, "message": failure.message]
  }

  private static func dictionary(_ failure: PathFailure) -> [String: Any] {
    return ["path": failure.path, "failure": dictionary(failure.failure)]
  }

  private static func dictionary(_ outcome: ListOutcome) -> [String: Any] {
    return [
      "entries": outcome.entries.map { entry -> [String: Any] in
        return [
          "name": entry.name,
          "path": entry.path,
          "size": entry.size,
          "mtime": entry.mtime,
          "isDir": entry.isDir,
          "downloaded": entry.downloaded,
          "writable": entry.writable,
        ]
      },
      "failures": outcome.failures.map(dictionary),
    ]
  }

  private static func dictionary(_ outcome: CreateOutcome) -> [String: Any] {
    switch outcome {
    case let .created(path):
      return ["status": "created", "path": path]
    case .exists:
      return ["status": "exists"]
    case let .failed(failure):
      return ["status": "failed", "failure": dictionary(failure)]
    }
  }

  private static func dictionary(_ outcome: ReplaceOutcome) -> [String: Any] {
    switch outcome {
    case let .replaced(hash):
      return ["status": "replaced", "hash": hash]
    case let .stale(currentHash):
      return ["status": "stale", "currentHash": currentHash]
    case let .failed(failure):
      return ["status": "failed", "failure": dictionary(failure)]
    }
  }
}

/// One open picker. UIKit holds its delegates weakly, so the module keeps this alive until it ends.
private final class FolderPicking: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private let onFinish: (URL?) -> Void
  private var finished = false

  init(onFinish: @escaping (URL?) -> Void) {
    self.onFinish = onFinish
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    finish(urls.first)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(nil)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(nil)
  }

  private func finish(_ url: URL?) {
    guard !finished else { return }
    finished = true
    onFinish(url)
  }
}
