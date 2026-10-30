import XCTest

@testable import RoamletFsCore

private struct InjectedFault: Error {}

final class LibraryFilesTests: XCTestCase {
  private var root: URL!
  private var files: LibraryFiles!

  private let oldBytes = Data("old content\r\n".utf8)
  // A BOM, invalid UTF-8, and a NUL: bytes must survive without any decoding.
  private let newBytes = Data([0xEF, 0xBB, 0xBF, 0x6E, 0x65, 0x77, 0xFF, 0x00, 0x0D, 0x0A])

  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("roamlet-fs-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    files = LibraryFiles(root: root)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: root)
  }

  @discardableResult
  private func put(_ path: String, _ bytes: Data) throws -> URL {
    let url = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try bytes.write(to: url)
    return url
  }

  private func contents(_ path: String) throws -> Data {
    return try Data(contentsOf: root.appendingPathComponent(path))
  }

  private func allNames() throws -> [String] {
    return try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
  }

  private func hash(_ bytes: Data) -> String {
    return LibraryFiles.sha256(of: bytes)
  }

  // MARK: - replaceFile

  func testReplaceSwapsInNewBytesExactly() throws {
    try put("note.org", oldBytes)
    let outcome = files.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes))
    XCTAssertEqual(outcome, .replaced(hash: hash(newBytes)))
    XCTAssertEqual(try contents("note.org"), newBytes)
    XCTAssertEqual(try allNames(), ["note.org"])
  }

  func testReplaceInSubfolderKeepsTheFileThere() throws {
    try put("daily/2026-01-02.org", oldBytes)
    let outcome = files.replaceFile("daily/2026-01-02.org", bytes: newBytes, expectedHash: hash(oldBytes))
    XCTAssertEqual(outcome, .replaced(hash: hash(newBytes)))
    XCTAssertEqual(try contents("daily/2026-01-02.org"), newBytes)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("daily").path), ["2026-01-02.org"])
  }

  func testReplaceAdvancesModificationTime() throws {
    // Reconcile finds changes by size and mtime, so a kept old mtime would hide a same-size edit.
    let url = try put("note.org", oldBytes)
    let old = Date(timeIntervalSince1970: 1_000_000)
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: url.path)
    _ = files.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes))
    let values = try root.appendingPathComponent("note.org").resourceValues(forKeys: [.contentModificationDateKey])
    XCTAssertGreaterThan(try XCTUnwrap(values.contentModificationDate), old)
  }

  func testStaleHashLeavesTheFileUntouched() throws {
    let external = Data("changed by a sync tool".utf8)
    try put("note.org", external)
    let outcome = files.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes))
    XCTAssertEqual(outcome, .stale(currentHash: hash(external)))
    XCTAssertEqual(try contents("note.org"), external)
  }

  func testReplaceOfMissingFileIsNotFoundAndCreatesNothing() throws {
    guard case let .failed(failure) = files.replaceFile("gone.org", bytes: newBytes, expectedHash: hash(oldBytes)) else {
      return XCTFail("expected a failure")
    }
    XCTAssertEqual(failure.kind, .notFound)
    XCTAssertEqual(try allNames(), [])
  }

  func testFailureBeforeTheSwapLeavesTheOldContentAtEveryStep() throws {
    for step in [SaveStep.checkedCurrent, .wroteTemp, .verifiedTemp] {
      try put("note.org", oldBytes)
      var faulty = LibraryFiles(root: root)
      faulty.onStep = { current, _ in
        if current == step { throw InjectedFault() }
      }
      guard case .failed = faulty.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes)) else {
        return XCTFail("expected a failure at \(step)")
      }
      XCTAssertEqual(try contents("note.org"), oldBytes, "at \(step)")
      XCTAssertEqual(try allNames(), ["note.org"], "at \(step)")
    }
  }

  func testCorruptTempIsCaughtBeforeTheSwap() throws {
    try put("note.org", oldBytes)
    var faulty = LibraryFiles(root: root)
    faulty.onStep = { step, url in
      if step == .wroteTemp { try Data("torn".utf8).write(to: url) }
    }
    let outcome = faulty.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes))
    XCTAssertEqual(outcome, .failed(FileFailure(.providerError, "temp file did not read back as written")))
    XCTAssertEqual(try contents("note.org"), oldBytes)
  }

  func testFailedSwapLeavesTheOldContent() throws {
    try put("note.org", oldBytes)
    var faulty = LibraryFiles(root: root)
    faulty.swapItem = { _, _ in
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)
    }
    guard case let .failed(failure) = faulty.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes)) else {
      return XCTFail("expected a failure")
    }
    XCTAssertEqual(failure.kind, .providerError)
    XCTAssertEqual(try contents("note.org"), oldBytes)
  }

  func testAlteredNameFromTheSwapIsCorrected() throws {
    try put("note.org", oldBytes)
    var renaming = LibraryFiles(root: root)
    renaming.swapItem = { target, temp in
      let altered = target.deletingLastPathComponent().appendingPathComponent("note (1).org")
      try FileManager.default.moveItem(at: temp, to: altered)
      try FileManager.default.removeItem(at: target)
      return altered
    }
    let outcome = renaming.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes))
    XCTAssertEqual(outcome, .replaced(hash: hash(newBytes)))
    XCTAssertEqual(try contents("note.org"), newBytes)
    XCTAssertEqual(try allNames(), ["note.org"])
  }

  func testAlteredNameThatCannotBeCorrectedIsReported() throws {
    try put("note.org", oldBytes)
    var renaming = LibraryFiles(root: root)
    renaming.swapItem = { target, temp in
      // The original stays, so moving the altered file onto its name must fail.
      let altered = target.deletingLastPathComponent().appendingPathComponent("note (1).org")
      try FileManager.default.moveItem(at: temp, to: altered)
      return altered
    }
    guard case let .failed(failure) = renaming.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes)) else {
      return XCTFail("expected a failure")
    }
    XCTAssertEqual(failure.kind, .nameChanged)
    XCTAssertEqual(try contents("note.org"), oldBytes)
  }

  func testReplaceRunsInsideOneCoordinatedWrite() throws {
    try put("note.org", oldBytes)
    let target = root.appendingPathComponent("note.org")
    var observed = LibraryFiles(root: root)
    var competingReadFinished = false
    let competingRead = expectation(description: "competing read ran")
    let finished = NSLock()
    observed.onStep = { step, _ in
      guard step == .verifiedTemp else { return }
      DispatchQueue.global().async {
        var error: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: target, options: [], error: &error) { _ in
          finished.lock()
          competingReadFinished = true
          finished.unlock()
          competingRead.fulfill()
        }
      }
      // Long enough that a read not blocked by the coordinated write would have finished.
      Thread.sleep(forTimeInterval: 0.3)
      finished.lock()
      defer { finished.unlock() }
      XCTAssertFalse(competingReadFinished, "a coordinated read got in during the write")
    }
    XCTAssertEqual(observed.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes)), .replaced(hash: hash(newBytes)))
    wait(for: [competingRead], timeout: 60)
  }

  func testCoordinationWaitIsBoundedWhenAnotherWriterHoldsTheFile() throws {
    try put("note.org", oldBytes)
    let target = root.appendingPathComponent("note.org")
    let holding = expectation(description: "writer holds the file")
    let release = DispatchSemaphore(value: 0)
    let released = expectation(description: "writer let go")
    DispatchQueue.global().async {
      var error: NSError?
      NSFileCoordinator(filePresenter: nil).coordinate(writingItemAt: target, options: [], error: &error) { _ in
        holding.fulfill()
        release.wait()
      }
      released.fulfill()
    }
    // Generous: on a CI simulator, a first coordination has taken over 5 seconds to get access.
    wait(for: [holding], timeout: 60)

    var impatient = LibraryFiles(root: root)
    impatient.coordinationTimeout = 0.2
    XCTAssertThrowsError(try impatient.readBytes("note.org"))

    release.signal()
    wait(for: [released], timeout: 60)
    XCTAssertEqual(try contents("note.org"), oldBytes)
  }

  // MARK: - createExclusive

  func testCreateWritesExactBytesAndName() throws {
    XCTAssertEqual(files.createExclusive("new.org", bytes: newBytes), .created(path: "new.org"))
    XCTAssertEqual(try contents("new.org"), newBytes)
    XCTAssertEqual(try allNames(), ["new.org"])
  }

  func testCreateNeverReplaces() throws {
    try put("note.org", oldBytes)
    XCTAssertEqual(files.createExclusive("note.org", bytes: newBytes), .exists)
    XCTAssertEqual(try contents("note.org"), oldBytes)
  }

  func testCreateTreatsCaseAndNormalizationVariantsAsTaken() throws {
    try put("Caf\u{00E9}.org", oldBytes)
    XCTAssertEqual(files.createExclusive("cafe\u{0301}.ORG", bytes: newBytes), .exists)
    XCTAssertEqual(try allNames().count, 1)
  }

  func testCreateTreatsAnICloudPlaceholderAsTaken() throws {
    try put(".note.org.icloud", Data())
    XCTAssertEqual(files.createExclusive("note.org", bytes: newBytes), .exists)
  }

  func testCreateInMissingFolderIsNotFound() throws {
    guard case let .failed(failure) = files.createExclusive("no/such.org", bytes: newBytes) else {
      return XCTFail("expected a failure")
    }
    XCTAssertEqual(failure.kind, .notFound)
    XCTAssertEqual(try allNames(), [])
  }

  func testFailureDuringCreateLeavesNoFile() throws {
    for step in [SaveStep.wroteTemp, .verifiedTemp] {
      var faulty = LibraryFiles(root: root)
      faulty.onStep = { current, _ in
        if current == step { throw InjectedFault() }
      }
      guard case .failed = faulty.createExclusive("new.org", bytes: newBytes) else {
        return XCTFail("expected a failure at \(step)")
      }
      XCTAssertEqual(try allNames(), [], "at \(step)")
    }
  }

  // MARK: - list

  func testListWalksSubfoldersAndReportsMetadata() throws {
    try put("top.org", oldBytes)
    try put("daily/2026-01-02.org", newBytes)
    let outcome = files.list()
    XCTAssertEqual(outcome.failures, [])
    let byPath = Dictionary(uniqueKeysWithValues: outcome.entries.map { ($0.path, $0) })
    XCTAssertEqual(Set(byPath.keys), ["top.org", "daily", "daily/2026-01-02.org"])
    let note = try XCTUnwrap(byPath["daily/2026-01-02.org"])
    XCTAssertEqual(note.name, "2026-01-02.org")
    XCTAssertEqual(note.size, Int64(newBytes.count))
    XCTAssertGreaterThan(note.mtime, 0)
    XCTAssertFalse(note.isDir)
    XCTAssertTrue(note.downloaded)
    XCTAssertTrue(note.writable)
    XCTAssertEqual(byPath["daily"]?.isDir, true)
    XCTAssertEqual(byPath["daily"]?.size, 0)
  }

  func testListSkipsHiddenEntriesButKeepsOtherFiles() throws {
    try put(".git/config", oldBytes)
    try put(".#note.org", oldBytes)
    try put(".roamlet-1.tmp", oldBytes)
    try put("image.png", oldBytes)
    XCTAssertEqual(files.list().entries.map(\.path), ["image.png"])
  }

  func testListReportsAnICloudPlaceholderAsItsRealNameNotDownloaded() throws {
    try put("sub/.note.org.icloud", Data("plist".utf8))
    let entry = try XCTUnwrap(files.list().entries.first { $0.path == "sub/note.org" })
    XCTAssertEqual(entry.name, "note.org")
    XCTAssertFalse(entry.downloaded)
    XCTAssertEqual(entry.size, 0)
  }

  func testListPrefersARealFileOverAPlaceholderBesideIt() throws {
    try put("note.org", oldBytes)
    try put(".note.org.icloud", Data())
    let entries = files.list().entries
    XCTAssertEqual(entries.map(\.path), ["note.org"])
    XCTAssertEqual(entries.first?.downloaded, true)
  }

  func testListDoesNotFollowSymbolicLinks() throws {
    try put("sub/note.org", oldBytes)
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent("sub/loop"),
      withDestinationURL: root
    )
    XCTAssertEqual(Set(files.list().entries.map(\.path)), ["sub", "sub/note.org"])
  }

  func testListOfMissingRootFailsAtTheRootWithNoEntries() throws {
    let outcome = LibraryFiles(root: root.appendingPathComponent("gone")).list()
    XCTAssertEqual(outcome.entries, [])
    XCTAssertEqual(outcome.failures.map(\.path), [""])
    XCTAssertEqual(outcome.failures.first?.failure.kind, .notFound)
  }

  // MARK: - read, digest, download

  func testReadAndDigestReturnExactBytes() throws {
    try put("note.org", newBytes)
    XCTAssertEqual(try files.readBytes("note.org"), newBytes)
    XCTAssertEqual(try files.digest("note.org"), hash(newBytes))
  }

  func testDigestMatchesAKnownSha256() throws {
    try put("abc.org", Data("abc".utf8))
    XCTAssertEqual(
      try files.digest("abc.org"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  }

  func testReadOfMissingFileIsNotFound() {
    XCTAssertThrowsError(try files.readBytes("gone.org")) { error in
      XCTAssertEqual((error as? FileFailure)?.kind ?? FileFailure(error).kind, .notFound)
    }
  }

  func testReadOfPlaceholderIsNotDownloadedRatherThanNotFound() throws {
    try put(".note.org.icloud", Data())
    XCTAssertThrowsError(try files.readBytes("note.org")) { error in
      XCTAssertEqual((error as? FileFailure)?.kind, .notDownloaded)
    }
    XCTAssertThrowsError(try files.digest("note.org")) { error in
      XCTAssertEqual((error as? FileFailure)?.kind, .notDownloaded)
    }
  }

  func testReplaceOfPlaceholderIsNotDownloadedAndWritesNothing() throws {
    try put(".note.org.icloud", Data())
    guard case let .failed(failure) = files.replaceFile("note.org", bytes: newBytes, expectedHash: hash(oldBytes)) else {
      return XCTFail("expected a failure")
    }
    XCTAssertEqual(failure.kind, .notDownloaded)
    XCTAssertEqual(try allNames(), [".note.org.icloud"])
  }

  func testPathsCannotLeaveTheRoot() throws {
    let outside = root.deletingLastPathComponent().appendingPathComponent("outside-\(UUID().uuidString).org")
    defer { try? FileManager.default.removeItem(at: outside) }
    let escape = "../\(outside.lastPathComponent)"
    for path in [escape, "", "/absolute.org", "a//b.org", "./note.org", "a/../b.org"] {
      guard case let .failed(failure) = files.createExclusive(path, bytes: newBytes) else {
        return XCTFail("expected \(path) to be refused")
      }
      XCTAssertEqual(failure.kind, .notFound, path)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
  }

  func testRequestDownloadOfLocalFileIsANoOp() throws {
    try put("note.org", oldBytes)
    XCTAssertEqual(files.requestDownload(["note.org"]), [])
  }

  func testRequestDownloadReportsAMissingFile() {
    let failures = files.requestDownload(["gone.org"])
    XCTAssertEqual(failures.map(\.path), ["gone.org"])
    XCTAssertEqual(failures.first?.failure.kind, .notFound)
  }
}
