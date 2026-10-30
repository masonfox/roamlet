# roamlet-fs

The local Expo module that provides lasting folder access, file coordination, and safe in-place replacement. See Decisions 3, 4, and 10 in `openspec/changes/add-roamlet-mvp/design.md`.

`src/RoamletFs.types.ts` is the native API, and both platforms implement it.

## Android

`RoamletLibrary` holds the listing and the save protocols, over a `LibraryBackend`: `SafBackend` for external folders and `PlainFileBackend` for the app-owned folder. `RoamletFsModule` only converts between it and JavaScript.

The tests in `android/src/test` run under Robolectric against a fake `DocumentsProvider`, and fail every step of each save protocol. To run them, use the `Native Android` workflow, or `./gradlew :roamlet-fs:testDebugUnitTest` in a prebuilt `android/` folder.
