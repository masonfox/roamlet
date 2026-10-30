## 1. Milestone 0: Project foundation and device validation

- [x] 1.1 Scaffold an Expo SDK 58 TypeScript app with Expo Router and verify `npx tsc --noEmit` and `npx expo-doctor` pass
- [x] 1.2 Create the `app/`, `modules/roamlet-fs/`, `src/ui/`, `src/adapters/`, and `src/core/` layout with a lint rule banning `react-native` and `expo*` imports from `src/core/`, and verify a deliberate violation fails lint
- [x] 1.3 Set up Jest with a plain Node project for `src/core/` and a `jest-expo` project for UI, and verify a sample test runs in each
- [x] 1.4 Add CI for lint, typecheck, and tests, plus a `LICENSE` file (MIT unless the maintainer decides otherwise), and verify CI passes on a branch
- [ ] 1.5 Configure the `expo-file-system` iOS file sharing and open-in-place options and EAS development builds, and verify the app launches on one iOS and one Android device (delivers acceptance criterion 1)
- [ ] 1.6 Spike `roamlet-fs` on Android (`pickFolder`, `restore`, `list`, `readBytes`, `createExclusive`, `replaceFile`), and verify from a throwaway screen that a file in a picked folder can be listed and replaced with exact bytes and name
- [ ] 1.7 Spike the same API on iOS, including bookmarks, coordination, `replaceItemAt`, and `requestDownload`, and verify from the same screen through an EAS build
- [ ] 1.8 Run the provider matrix from `design.md` (iCloud Drive, Dropbox on both platforms, Working Copy, Syncthing or local folder) with a 5,000-note test library, and record a result per provider and test in `docs/validation.md`
- [ ] 1.9 Re-check Google Drive and OneDrive folder access on iOS, and confirm whether Dropbox on Android offers folder access, and record both in `docs/validation.md`
- [ ] 1.10 Run assumptions A3–A7, A9, and A10 from `design.md`, and record pass or fail and any fallback taken in `docs/validation.md`
- [ ] 1.11 Record A8 baseline numbers for listing and hashing on a local folder and a cloud folder in `docs/validation.md`
- [ ] 1.12 Apply the go/no-go rules: if iCloud Drive or safe saves on a primary provider aren't reliable, stop and report to the maintainer. Otherwise update `design.md` for any failed assumption, and once tasks 5.4 and 6.8 have run on it, delete the throwaway screen and its contract and benchmark helpers (`src/adapters/roamlet-fs-contract.ts`, `src/adapters/library-benchmark.ts`), and verify they are gone from the app

## 2. Milestone 1: Org scanner

- [x] 2.1 Define `ports.ts` (`FileStore`, `SqlDriver`, `IdGenerator`, `Clock`) and the `OrgDocument` types, and verify they compile with no platform imports
- [x] 2.2 Create the fixture corpus in `test/fixtures/` covering headings, property drawers, source blocks, links, metadata, CRLF, mixed line endings, BOM, Unicode, malformed drawers, unterminated blocks, comma escapes, duplicate IDs, sync-conflict copies, and broken links, and verify each fixture is documented in a fixture README
- [x] 2.3 Implement line scanning for headings, planning lines, drawers, keywords, blocks, comments, and fixed-width lines with source offsets, and verify with tests for the "Org block and heading precedence" and "Tolerant parsing" specs
- [x] 2.4 Implement file-level and heading-level node extraction, `ROAM_EXCLUDE`, title and tag parsing, and TODO and priority stripping, and verify with tests for each node recognition scenario
- [x] 2.5 Implement the inline tokenizer for links and emphasis, plus link attribution to the nearest node, and verify with tests for all "ID link recognition" scenarios
- [x] 2.6 Add property-based tests and verify that the scanner never throws, offsets always stay within bounds, and LF and CRLF forms of any input give equivalent results

## 3. Milestone 2: Emacs conformance harness

- [x] 3.1 Write `test/emacs/oracle.el` to run `org-roam-db-sync` in batch mode on a directory and dump nodes and links as JSON, and verify it runs against the corpus locally or in CI
- [x] 3.2 Add a comparison test between oracle and scanner results with a checked-in allowlist of justified differences, and verify an injected scanner bug fails it
- [x] 3.3 Add the CI job with pinned Emacs and Org-roam versions and verify it passes on the corpus
- [x] 3.4 Resolve the behaviors `design.md` leaves to conformance (`ROAM_EXCLUDE` inheritance, plain and angle `id:` links, links in property drawers and keywords, duplicate IDs in sync-conflict copies) by fixing the scanner or adding allowlist entries, and verify the job is green

## 4. Milestone 3: Editing operations

- [x] 4.1 Implement `spliceBody` with single-range diffing and line-ending handling, and verify with tests for body edit, no-op, CRLF, and mixed line ending scenarios
- [x] 4.2 Implement `spliceTitle` covering replacement, keyword casing, missing title, and missing drawer, and verify with tests for all title scenarios
- [x] 4.3 Add property-based tests and verify that for random text and edits, all bytes outside the replacement range are identical to the original
- [x] 4.4 Implement `renderNewNote`, UUID generation through the port, title derivation, and slug generation, and verify with tests for all "New note format" and "Quick capture" scenarios
- [x] 4.5 Implement the node-set comparison for ID warnings and the link text builder with bracket handling, and verify with tests for "ID protection during editing" and bracketed title scenarios
- [x] 4.6 Extend the conformance job to apply scripted edits and new notes through these operations, and verify Org-roam still finds the expected nodes and links with byte preservation outside edits

## 5. Milestone 4: Native file layer and save handling

- [x] 5.1 Write a shared `FileStore` contract test and an in-memory `FileStore` with fault injection, and verify the in-memory store passes in Node
- [x] 5.2 Finish `roamlet-fs` on Android with both save paths, recovery, the batched listing, and name verification, and verify a Kotlin test with a fake documents provider that fails at every step always recovers complete old or new content with no temp files left
- [ ] 5.3 Finish `roamlet-fs` on iOS with coordination throughout, stale bookmark refresh, access-state reporting, and download status, and verify with the on-device contract test through an EAS build
- [ ] 5.4 Add the `FileStore` adapter over the module for both root kinds, including the app-owned folder, and verify the contract test passes on one iOS and one Android device
- [x] 5.5 Implement save orchestration in core: stale handling, conflict copy creation and naming, new-file collisions, and provider error mapping, and verify with fault-injection tests for "Stale edit protection" and the failed-write scenarios
- [x] 5.6 Implement UTF-8 validation and read-only flagging, and verify invalid UTF-8 fixtures stay byte-identical and cannot be saved
- [x] 5.7 Implement library state (active root, restore at launch, switch, reconnect, read-only) and verify with tests for every "Loss of folder access" and "Library location" scenario that applies in core
- [x] 5.8 Implement archive writing with `fflate`, and verify with tests for UTF-8 names, subdirectories, conflict copies, omitted files, excluded internals, and byte-identical contents

## 6. Milestone 5: Index

- [x] 6.1 Implement the Expo and Node `SqlDriver` adapters and a versioned per-library schema with FTS5, and verify a mismatched `user_version` causes the database to be recreated
- [x] 6.2 Implement `reconcile` with per-file transactions, and verify with tests for added, changed, removed, renamed, and timestamp-only changes
- [x] 6.3 Add listing-failure, partial-failure, and evicted-file handling to `reconcile`, and verify with tests for every "Index survives loss of access" scenario, including that a failed listing removes nothing
- [x] 6.4 Add not-downloaded entries and batched download requests, and verify with tests that such files appear by name and gain content once available
- [x] 6.5 Implement queries for the folder tree, backlinks, outgoing links, link resolution, and duplicate and problem reporting, and verify with tests for "Indexed content" and "Data problem reporting"
- [x] 6.6 Implement search with title weighting, diacritic handling, and CJK fallback, and verify with tests for all "Search" scenarios that apply at the query level
- [x] 6.7 Add a test that an incrementally built index and a rebuilt index are identical after a random sequence of file operations, and a test that resumes after an interrupted rebuild
- [ ] 6.8 Run the A8 benchmark for rebuild, no-change reconcile, and search on a mid-range Android device, and record results in `docs/validation.md`

## 7. Milestone 6: Vertical slice — Open folder, Browse, Read

- [ ] 7.1 Build the three-destination navigation with light and dark theme tokens and system typography, and verify on both platforms that switching tabs keeps state and appearance changes apply live
- [ ] 7.2 Wire app startup (restore access, recovery, then reconcile) and foreground reconcile, and verify on a device that a file changed by a sync tool appears after returning to the app
- [ ] 7.3 Build the Settings flow to choose a folder, including provider and restricted-location guidance, indexing progress, and picker failure messaging, and verify on both platforms with a real Org-roam folder that no file in it changes (delivers acceptance criterion 2)
- [ ] 7.4 Build the reconnect state, and verify on a device that revoking access keeps the index and drafts, and that reconnecting restores the library
- [ ] 7.5 Build the Notes folder tree with empty, no-ID, and not-downloaded states, and verify on both platforms that the tree matches the real folder
- [ ] 7.6 Build global search in Notes with heading results, and verify in airplane mode on both platforms (delivers acceptance criterion 3)
- [ ] 7.7 Build the reader's block renderer with literal-text fallback, including the unavailable-note state, and verify with `jest-expo` tests for each block type and on-device review of the fixture corpus, including long notes and large font sizes
- [ ] 7.8 Add ID link navigation, heading positioning, and unresolved link behavior, and verify by following resolved, heading, and missing links on a device (delivers acceptance criterion 4)
- [ ] 7.9 Add the backlinks and outgoing links sections, and verify on a device that the listed backlinks match the Org-roam oracle's output for the same folder (delivers acceptance criterion 5)

## 8. Milestone 7: Vertical slice — Create

- [ ] 8.1 Build the Capture screen with title derivation, draft persistence, and the empty-state guard, and verify on a device that killing the app during capture restores the text
- [ ] 8.2 Connect capture to `createExclusive` and the index, including read-only and unavailable library handling, and verify a captured note appears immediately in the tree and search, is written to the chosen folder's root, and passes the Org-roam oracle (delivers acceptance criterion 6)

## 9. Milestone 8: Vertical slice — Edit

- [x] 9.1 Build the editor with title field, plain-text body, explicit save, drafts, discard confirmation, and the size limit, and verify with UI tests for each flow
- [ ] 9.2 Connect saves to splicing, the ID warning, `replaceFile`, stale-edit handling, and the index, and verify on a device that a file diff after editing one word shows only that word (delivers acceptance criterion 7)
- [ ] 9.3 Add link insertion through search in Capture and the editor, and verify an inserted link resolves in the app and appears as a backlink in the Org-roam oracle
- [ ] 9.4 Kill-test saves on each provider in the matrix during repeated editing, and verify no note is left partial or missing after relaunch

## 10. Milestone 9: Retrieve, rebuild, and diagnostics

- [ ] 10.1 Build archive export through the share sheet, and verify on a device that a library in the app-owned folder can be fully retrieved with byte-identical files (delivers acceptance criterion 8, together with task 11.1 for chosen folders)
- [ ] 10.2 Build Rebuild Index with progress in Settings, and verify on a device that killing the app during a rebuild resumes correctly and results match the files (delivers acceptance criterion 10)
- [x] 10.3 Build the library status, storage information, statistics, and diagnostics views with per-category file lists, and verify with fixtures containing every problem type, including conflict copies and undownloaded files
- [ ] 10.4 Audit screen reader labels and font scaling on the main flows, including the folder tree, and verify using VoiceOver and TalkBack on one device each

## 11. Milestone 10: End-to-end acceptance

- [ ] 11.1 On each provider in the matrix, run the full journey on a real Org-roam folder (open, browse, read, create, edit), let the sync tool carry the files to the Emacs machine, run `org-roam-db-sync`, and verify IDs, links, and content are intact (delivers acceptance criteria 8 and 9)
- [ ] 11.2 Edit the same notes in Emacs, sync them back, and verify the changes appear in Roamlet. Change a note in Emacs while it's open in the Roamlet editor, and verify the stale-edit choices appear and nothing is overwritten
- [ ] 11.3 Force a sync conflict on Dropbox and Syncthing, and verify the conflict copy shows up with a duplicate ID report and neither file is changed
- [ ] 11.4 Write the README and compatibility notes, covering supported providers, known limitations, supported Org subset, and how to retrieve notes from the app-owned folder, and verify each limitation in `design.md` is covered
- [ ] 11.5 Walk through acceptance criteria 1–10, as revised in `proposal.md`, on both platforms, and record the results in `docs/validation.md`
