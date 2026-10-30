// swift-tools-version:5.9

// Only for tests: builds Core/ without Expo so `swift test` and `xcodebuild test` can run the save
// protocol on a plain directory. The app builds these same files through the podspec.

import PackageDescription

let package = Package(
  name: "RoamletFsCore",
  platforms: [.iOS("16.4"), .macOS(.v13)],
  products: [.library(name: "RoamletFsCore", targets: ["RoamletFsCore"])],
  targets: [
    .target(name: "RoamletFsCore", path: "Core"),
    .testTarget(name: "RoamletFsCoreTests", dependencies: ["RoamletFsCore"], path: "Tests"),
  ]
)
