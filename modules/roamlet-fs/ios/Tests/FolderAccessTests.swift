import XCTest

@testable import RoamletFsCore

// Temp directories aren't security scoped, so these cover the state logic only. What real bookmarks
// do across restarts, revocation, and providers can only be shown on a device (assumption A1).
final class FolderAccessTests: XCTestCase {
  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("roamlet-access-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  private func adopted(_ access: FolderAccess = FolderAccess()) throws -> ExternalRoot {
    return try XCTUnwrap(access.adopt(folder)).root
  }

  func testAdoptGivesAStablePathSafeIdAndWritesNothing() throws {
    let access = FolderAccess()
    let first = try XCTUnwrap(access.adopt(folder))
    XCTAssertTrue(first.writable)
    XCTAssertEqual(first.root.name, folder.lastPathComponent)
    XCTAssertEqual(try adopted().id, first.root.id)
    XCTAssertTrue(first.root.id.allSatisfy { $0.isHexDigit })
    XCTAssertNotNil(Data(base64Encoded: first.root.reference))
    XCTAssertEqual(access.url(forRootId: first.root.id), folder)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
  }

  func testAdoptOfMissingFolderIsRefused() throws {
    try FileManager.default.removeItem(at: folder)
    XCTAssertNil(FolderAccess().adopt(folder))
  }

  func testRestoreOfSavedBookmarkIsOk() throws {
    let root = try adopted()
    let access = FolderAccess()
    XCTAssertEqual(access.restore(root), .ok(writable: true))
    XCTAssertNotNil(access.url(forRootId: root.id))
  }

  func testRestoreAfterTheFolderIsDeletedIsMissing() throws {
    let root = try adopted()
    try FileManager.default.removeItem(at: folder)
    XCTAssertEqual(FolderAccess().restore(root), .missing)
  }

  func testUnreadableReferenceIsRevoked() {
    let root = ExternalRoot(id: "x", name: "x", reference: "not base64!")
    XCTAssertEqual(FolderAccess().restore(root), .revoked)
  }

  func testBookmarkPermissionErrorIsRevokedAndHoldsNothing() throws {
    let root = try adopted()
    let access = FolderAccess()
    access.resolveBookmark = { _ in
      throw NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)
    }
    XCTAssertEqual(access.restore(root), .revoked)
    XCTAssertNil(access.url(forRootId: root.id))
  }

  func testStaleBookmarkIsRefreshedAndKeepsItsId() throws {
    let root = try adopted()
    let folder = self.folder!
    let access = FolderAccess()
    access.resolveBookmark = { _ in (folder, true) }
    guard case let .stale(refreshed, writable) = access.restore(root) else {
      return XCTFail("expected stale")
    }
    XCTAssertTrue(writable)
    XCTAssertEqual(refreshed.id, root.id)
    XCTAssertEqual(refreshed.name, folder.lastPathComponent)

    let fresh = FolderAccess()
    XCTAssertEqual(fresh.restore(refreshed), .ok(writable: true))
  }

  func testRestoringOneRootReleasesTheOthers() throws {
    let access = FolderAccess()
    let first = try XCTUnwrap(access.adopt(folder)).root
    let otherFolder = folder.appendingPathComponent("other", isDirectory: true)
    try FileManager.default.createDirectory(at: otherFolder, withIntermediateDirectories: true)
    let second = try XCTUnwrap(access.adopt(otherFolder)).root

    // Picking must not disturb the active library, in case the user keeps it.
    XCTAssertNotNil(access.url(forRootId: first.id))
    XCTAssertNotNil(access.url(forRootId: second.id))

    XCTAssertEqual(access.restore(second), .ok(writable: true))
    XCTAssertNil(access.url(forRootId: first.id))
    XCTAssertNotNil(access.url(forRootId: second.id))

    access.releaseAll()
    XCTAssertNil(access.url(forRootId: second.id))
  }

  func testAFailedRestoreKeepsTheActiveRoot() throws {
    let access = FolderAccess()
    let active = try XCTUnwrap(access.adopt(folder)).root
    XCTAssertEqual(access.restore(ExternalRoot(id: "x", name: "x", reference: "not base64!")), .revoked)
    XCTAssertNotNil(access.url(forRootId: active.id))
  }
}
