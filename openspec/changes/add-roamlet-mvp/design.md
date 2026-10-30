## Context

The repository is empty apart from OpenSpec scaffolding, so there is no existing code to fit around. See `proposal.md` for motivation and `specs/` for required behavior. This document records the five investigations the brief asked for and the architecture that follows from them.

An earlier draft kept the library as a sandbox copy with import and export. That was rejected: opening the user's real folder and editing it in place is core to the product. This version replaces that model.

Facts below come from three sources, checked on 2026-10-30:

- **Experiments:** Parser probes run on Node 24 against small hand-written fixtures. They did not run on Hermes or on a device.
- **Source reading:** `expo-file-system@58.0.13` native code (Swift and Kotlin).
- **Documentation:** Expo SDK 58 docs, Apple and Android developer docs, Org-roam's manual and source, iA Writer's support pages, and Expo's issue tracker.

**None of the native folder behavior has been run yet.** It's based on documentation and source reading. Anything unproven on real devices is listed under [Assumptions to validate](#assumptions-to-validate) and is scheduled as the first milestone.

## Goals / Non-Goals

**Goals:**

- Make silent corruption of a user's notes structurally impossible, not merely tested against.
- Let the user open their existing folder once and edit it in place from then on.
- Deliver the vertical slice with the fewest moving parts that preserve correctness.
- Keep parsing, editing, and indexing independent of React Native, so they can later move to other platforms.
- Leave clear seams for future sync without building any of it.

**Non-Goals:**

- Being a general Org parser. The core recognizes only what Org-roam semantics and the reader need.
- Matching Org-roam's results where they depend on a user's Emacs configuration (see the limitations under Decision 1).
- Several libraries open at once, background processing, or live filesystem watching.
- Running any sync protocol. The user's provider or tool moves the files.

## Decisions

### Decision 1: Saves splice text; a small custom scanner handles reading

**Investigation 2: can an existing JavaScript parser safely support lossless editing?** No. Each candidate was run against a realistic fixture containing drawers, blocks, links in verbatim contexts, and CRLF.

| | `uniorg-parse` 3.2.2 + `uniorg-stringify` 1.4.0 | `orga` 5.0.0 | `org-mode-ast` 0.13.5 |
|---|---|---|---|
| **License** | GPL-3.0-or-later | MIT | MIT |
| **Source offsets** | Yes, with `trackPosition` | Yes | Yes |
| **File-level drawer** | Parsed correctly | **Parsed as a paragraph** | Parsed correctly |
| **Links in src, example, comment, fixed-width** | All excluded | **Fixed-width link counted** | Top level correct; contents under headings not inspected |
| **CRLF input** | **File drawer becomes a generic `drawer`; properties lost** | **Empty top-level tree** | Raw text matched |
| **Serialization** | **Rewrites source:** `#+title` to `#+TITLE`, collapses `:ID:` alignment, drops CRLF | No serializer | `rawValue` matched on valid fixtures, **but differed on a malformed sample** |
| **Maintenance** | Active | Active | Active; 0.x with a single maintainer |

**Decision:** Saves never serialize a parse tree. An edit is a splice: `prefix + replacement + suffix`, taken from the file's original text. Preservation therefore holds by construction, for syntax we do not understand as well as syntax we do. This is the brief's "serializer", and its whole surface is:

- `spliceTitle`: replaces a title value, or inserts a title line if there is none.
- `spliceBody`: computes a single replacement range from the common prefix and suffix of the old and new body, then converts line endings in the replacement only.
- `renderNewNote`: produces the content of a new file.
- `insertLink`: operates on the editor buffer and produces the link text.

For reading, the core uses a **small custom scanner** of the form `scan(text) → OrgDocument`. It is a line-oriented pass that finds headings, drawers, keywords, and blocks, plus a small inline tokenizer for links and emphasis, with every element carrying source offsets.

Why custom rather than `org-mode-ast`, the strongest candidate:

- Title splice offsets are integrity-critical, and the scanner has to guarantee them on malformed input, where `org-mode-ast` was seen to diverge from the source.
- The required subset is small (Org-roam's semantics and basic reader blocks), and it is much easier to test exhaustively than a dependency.
- It adds nothing to the bundle and has no Hermes compatibility risk.
- The scanner's total-function rule ("anything unrecognized is text") maps directly to the spec.

**Trade-offs and alternatives:**

- We own the correctness of an Org subset. Decision 8 mitigates this by treating Emacs itself as the test oracle.
- `OrgDocument` is the only interface to the rest of the app. If reader needs outgrow the scanner, `org-mode-ast` can be adopted **for reader rendering only**, with no change to saves.
- `uniorg` is rejected as a runtime dependency because of its GPL license (Decision 9) and its CRLF behavior.
- Normalizing line endings and running a parser on the normalized copy would fix CRLF parsing, but it would not fix the serialization problem. The scanner handles both line-ending forms directly and reports offsets against the original text.

**Known limitations, to be documented in the repository:**

- Only `TODO`, `DONE`, and keywords declared in the file (`#+TODO` and its variants) are recognized when stripping heading titles. Keywords configured globally in Emacs are not visible to the app and will appear in titles.
- `org-roam-db-node-include-function` and other Emacs customization are not visible to the app.
- `id:` links in plain or angle form are a known gap until conformance results (Decision 8) show whether they matter in practice.

**The fixture bug worth remembering:** An early probe wrongly appeared to show parsers failing on a source block, because the fixture had an unescaped `* ` line inside the block. Org really does treat that as a heading, and `,*` is the escape. Both behaviors are now specified, and fixtures must follow them.

### Decision 2: Nodes are uniform; browsing follows files; editing is file-scoped

**Investigation 1: representing file-level and heading-level nodes.** Per Org-roam's manual, a node is a file or heading with an ID, and only `id:` links count as node-to-node links.

**Decision:** There is a single `Node` shape: `{ id, filePath, level (0 = file), title, tags, startOffset }`. Each link belongs to its nearest enclosing node. Files are a separate concept, so a file with no ID still appears in the library without being a node, and it is never given an ID automatically.

The folder tree shows folders and files, because that's the real structure the user asked to see. Heading nodes don't appear as tree entries. They're reached through search, links, and backlinks, which open their file at the heading.

Editing always targets the file: the title field plus a body consisting of all text after the metadata header. Heading drawers are visible in that text, and a pre-save check (compare the scanner's node set before and after) warns if an ID would be lost, changed, or duplicated.

**Alternatives:**

- *Heading-scoped editor:* Rejected for the MVP because it needs per-subtree range tracking and UI, and adds failure modes for little gain.
- *Hiding heading drawers in the editor:* Rejected because it would require mapping between displayed text and file text, the very kind of transformation this design avoids.
- *Flat list of all nodes as the main view:* Rejected in favor of the tree, which mirrors the user's files. Search covers the flat, node-oriented use.

### Decision 3: The library is the user's real folder, or an app-owned folder

**Investigation 3: Expo filesystem constraints.** Neither iOS nor Android prevents this, and an earlier draft wrongly treated Expo's gaps as if they were platform limits.

- **iOS:** A folder picker grants recursive access to a folder from any provider, including new items added later, and the app "can even save a bookmark" to reach it on next launch. Apple says to use a file coordinator for reads and writes, and that the app must handle access being revoked in Settings ([Apple](https://developer.apple.com/tutorials/data/documentation/uikit/providing-access-to-directories.md)).
- **Android:** `ACTION_OPEN_DOCUMENT_TREE` with a persisted grant keeps access across restarts. On Android 11+ it can't select the storage root, an SD card root, or `Download` ([Android](https://developer.android.com/training/data-storage/shared/documents-files)).
- **Precedent:** iA Writer on iOS opens folders from iCloud Drive, Dropbox, and Working Copy and edits them in place. iA reported in May 2024 that Google Drive and OneDrive didn't allow folder access from other apps ([iA](https://ia.net/writer/support/library/cloud-storage/cloud-storage-ipados)).

**What `expo-file-system@58.0.13` lacks** (from its source):

| Need | iOS | Android |
|---|---|---|
| Lasting folder access | No bookmark code at all | Works: the picker takes a persistable grant |
| File coordination | No `NSFileCoordinator` | Not applicable |
| Safe replace | `write` isn't atomic, and `move` with `overwrite` removes the destination first | Writes use mode `"w"`, which may not truncate. `move` with `overwrite` deletes first |
| Rename | Works | `rename` uses `javaFile`, which throws on content URIs |
| Batched listing | Not exposed with download status | `DocumentFile` runs a provider query per field per file |

**Decision:** One active library at a time, with a root of one of two kinds:

- **External folder:** picked once and restored at launch. This is the main path.
- **App-owned folder:** `Paths.document/org-roam`, the zero-setup default, so capture works before any folder is chosen. It's visible in iOS Files and private on Android, which is why zip export stays.

Roamlet stores nothing in the user's folder except notes they create, conflict copies, and very short-lived temp files during a save. Internal data lives elsewhere:

```
Internal storage (not visible in iOS Files; iOS Application Support, Android app files)
  libraries/<libraryId>/
    txn/                     save journals and backups (Android path, see Decision 4)
    drafts/                  unsaved capture and edit text
  active-library.json        root kind and saved folder reference
Paths.cache/
  index-<libraryId>.db       the index (see Decision 5)
Paths.document/
  org-roam/                  app-owned library (visible in iOS Files)
```

`Paths` doesn't expose Application Support, so the module provides the internal directory path. This keeps internal data out of Files while file sharing is on for the app-owned folder.

**What gets scanned:** `.org` files only. Hidden files and folders are skipped, which matters for performance and correctness in real libraries (`.git`, `.stfolder`, `.stversions`). Non-`.org` files are never touched.

**Files not on the device:** The module's listing reports whether a file is downloaded, hiding provider details such as iCloud's `.name.org.icloud` placeholders. After the first listing, reconcile requests downloads of `.org` files in batches, so search and backlinks can become complete. Without a connection they stay unavailable. A file evicted by the provider keeps its index rows, since its content hasn't changed.

**Alternatives:**

- *Sandbox copy with import and export:* The earlier draft's model. Rejected as a deal breaker, because it adds a manual step and a second copy to reconcile.
- *App-owned folder only, as users report for Obsidian on iOS:* Simple, but you can't choose an existing folder, and it doesn't work on Android.
- *iCloud container for the app (`iCloud Drive/Roamlet`):* Needs entitlements and native code anyway, and only helps iCloud users.
- *`MANAGE_EXTERNAL_STORAGE` on Android:* Restricted on Google Play, where Orgzly Revived's changelog says its Play build disallows external file access. Rejected.
- *Multi-file picker:* Rejected because it flattens subdirectories such as `daily/`.

### Decision 4: Native, per-platform safe replace with a stale check

**Investigation 4: interrupted writes.** Expo's `overwrite: true` is **not atomic**. It deletes the destination first (`FileSystemPath.swift:86-90`, `CopyMoveStrategy.kt:94-99`), so a failure after the delete loses the original. The native module replaces it with `replaceFile(path, bytes, expectedHash)`, which does the stale check close to the write.

**iOS:** Inside a coordinated write on the target, using the replacing option:

1. Hash the current file and compare it with `expectedHash`. If they differ, stop and report a stale edit.
2. Write the new bytes to a temp file from `FileManager`'s item-replacement directory, then read back and verify the hash.
3. Call `replaceItemAt` to swap it in, then verify the final name.

A crash before step 3 leaves the original untouched, so no journal is needed. Leftover temp files are cleaned up by the OS.

**Android, with a provider that supports rename (`FLAG_SUPPORTS_RENAME`):**

1. Check `expectedHash`.
2. Create a hidden temp document in the same folder, such as `.roamlet-<id>.tmp`. Write with mode `"wt"`, then read back and verify. Correct the name if the provider altered it.
3. Write a journal in internal storage: `{ path, tempDoc, oldName, newHash }`.
4. Rename the target to `.roamlet-<id>.old`, rename the temp to the target name, verify, then delete the old document and the journal.

**Android, with a provider that can't rename:**

1. Check `expectedHash`.
2. Back up the old bytes to internal storage and write a journal.
3. Write the target with mode `"wt"`, then read back and verify.
4. On failure, or at recovery if the content doesn't match `newHash`, write the backup back.

This fallback has a window in which a partial file exists at the note's path, and a sync tool could pick that up. It's only used where no better option exists, and the provider matrix shows which providers need it.

**Recovery** runs for the active library before it's used, and waits if the folder is unavailable. For each journal, it finishes or undoes the swap so that the target holds verified old or new content, then removes temp files, `.old` files, and the journal.

**After a save:** The index is updated once the file is in place. If the app dies in between, the next reconcile repairs the index, because the file is what counts. A stale result, such as a sync tool changing the file during editing, leads to the reload or conflict-copy choice. Conflict copies use `createExclusive` with a non-`.org` name.

**New files** use `createExclusive`, which never replaces an existing file, and confirm the name. Android providers may add an extension based on MIME type, so the module creates documents with a neutral type and verifies the result.

**Trade-offs:**

- A folder on a cloud provider can show the temp file or a brief gap to sync tools. Syncing is eventually consistent anyway, and the temp names are hidden and aren't `.org`, so Org-roam ignores them.
- Provider behavior under `replaceItemAt` and `renameDocument` is unproven until the matrix runs. Whether data is flushed to disk on power loss also depends on the provider.
- Native code can't run in Node, so crash testing moves to a Kotlin test with a fake documents provider, plus kill tests on devices.

**Alternatives:**

- *Journaled swap in TypeScript over `expo-file-system`:* The earlier design. It can't rename on Android and has no coordination on iOS.
- *Save protocol in TypeScript over low-level module calls:* Easier to test in Node, but the iOS protocol must run inside one coordination block, and passing that across the bridge would be fragile.

### Decision 5: One reconcile path; the index is cache

**Decision:** There is one operation: `reconcile(files, index)`. It lists the library through `FileStore`, compares each path's size and modification time with the index, hashes files that differ, re-scans only files whose hash changed, and removes entries for paths that a **successful** listing shows are gone. It runs at launch, on return to the foreground, after switching library, and on request.

**Protection against losing access:** A failed listing removes nothing. If listing one subfolder fails, entries under it are kept. This is what stops a revoked permission or a flaky provider from looking like every note was deleted.

**Full rebuild is reconcile against an empty index.** Delete the database and run reconcile. That one decision provides resumable rebuilds, automatic recovery from a corrupt database, and index format upgrades (a `user_version` mismatch deletes the database), all without separate code. It also makes the "incremental equals rebuilt" requirement directly testable. A rebuild needs each file's content, so files not on the device stay as filename-only entries until downloaded.

Each file's rows are replaced in one transaction, so the index is always consistent per file. Results appear progressively during a rebuild.

**Index location:** `Paths.cache`, with one database per library, for two reasons: the index is disposable by definition, and this keeps it out of backups and out of the user's folder. If the OS evicts the cache, the next launch rebuilds it, which on a cloud folder needs the files to be on the device.

**Schema, in outline:**

```
files(path PK, size, mtime, hash, eol, status)     -- status: ok, invalid_utf8, unreadable, not_downloaded
nodes(rowid, id, file_path, level, title, offset)  -- id is indexed, NOT unique
node_tags(node_rowid, tag)
links(source_rowid, target_id, description, offset)
search USING fts5(title, body, tokenize="unicode61 remove_diacritics 2")
```

- **Folder tree:** Derived from `files.path` with an index on the parent directory. It shows only folders containing notes, and needs no listing while browsing.
- **Duplicate IDs** are data, not constraint violations. Lookup picks a deterministic winner (lowest path), and duplicates are a query. This matters more now, because sync tools create conflict copies ending in `.org`, such as Syncthing's `.sync-conflict-` files and Dropbox's "conflicted copy" files.
- **Search units:** Each node gets one `search` row with the text owned by it, and text with no enclosing node gets a file-level row. Metadata lines are excluded.
- **Search queries** use FTS5 prefix matching, with title weighted higher through `bm25`. `unicode61` doesn't segment CJK, so queries containing such characters fall back to `LIKE` over stored text. That's a linear scan, which is acceptable at MVP scale.
- **Unresolved links** are simply links with no matching node, computed at query time, so they resolve on their own when a target appears.

**File watching:** Foreground reconcile gives the behavior the spec needs. `watch` in `expo-file-system` reports only coarse changes on iOS, and iOS suspends the app in the background anyway, so watching is left out.

**Alternatives:**

- *Build a new database and swap it in:* Rejected. It gives slightly better search during a rebuild but needs a second code path.
- *Storing the index in the user's folder:* Rejected. It would sync across devices and pollute the folder.

### Decision 6: A platform-free core behind interfaces

**Investigation 5: sharing the domain layer.**

```
app/                  Expo Router routes (thin)
modules/roamlet-fs/   local Expo module: Swift, Kotlin, TS bindings
src/ui/               components, theme
src/adapters/         roamlet-fs file store, expo-sqlite driver
src/core/             no react-native or expo imports, enforced by lint
  ports.ts            FileStore, SqlDriver, IdGenerator, Clock
  org/                scanner, inline tokenizer, splices, new note, slug
  library/            save orchestration, stale handling, archive
  index/              schema, reconcile, queries
```

`FileStore` is the seam for future sync and other sources:

`list`, `readBytes`, `digest`, `createExclusive`, `replaceFile`, `requestDownload`.

Core tests run in plain Node with an in-memory `FileStore`, which can inject faults such as a stale hash, a provider error, or a failed listing, plus a Node SQLite driver. Git or WebDAV could later arrive as another `FileStore` or as a tool that writes into the folder, without a redesign.

**Alternative:** A monorepo with a `packages/core` package from the start. Rejected for now because workspaces add friction to Metro and EAS setup, and the lint boundary keeps a later extraction mechanical.

### Decision 7: Reader and editor

- **Reader:** The scanner's blocks render in a virtualized list so long notes stay responsive. Every block type has a literal-text fallback, which is how unsupported syntax stays visible. Source blocks and tables render as horizontally scrollable monospace text. There's no syntax highlighting or table layout engine. The reader reads the current file, not indexed text, so it can't show stale content.
- **Editor:** A plain multiline `TextInput` with explicit Save, and drafts persisted with a debounce to internal storage, keyed by library and path. The editor works on an LF-normalized copy of the body because of platform text-input behavior. `spliceBody` maps the result back and restores line endings within the replacement only. Explicit Save was chosen over autosave so that a file is only written when the user intends it, which also avoids constant sync traffic.
- **Edit size limit:** Starts at 512 KiB and is to be tuned in Milestone 0. Larger files remain readable.
- **Encoding:** Files are read as bytes and validated as UTF-8 before decoding. Invalid files are never decoded and re-encoded, because replacement characters would corrupt them on save.
- **Capture title:** The first non-empty line, shortened at a word boundary to 80 characters, with the full text kept in the body in that case.
- **New files:** Created in the library root, following Org-roam's defaults: `:ID:       <lowercase uuid>` alignment, `#+title:`, and `%Y%m%d%H%M%S-${slug}.org`. The slug reimplements the behavior of `org-roam-node-slugify`: strip combining marks, map non-alphanumerics to `_`, collapse and trim underscores, and lowercase. The placeholder slug is `untitled`.
- **Theme:** `useColorScheme`, platform system fonts (serif for reading), and Dynamic Type or font scaling. No bundled fonts or theme settings.

### Decision 8: Emacs itself is the compatibility oracle

**Decision:** CI runs Emacs in batch mode with real Org-roam over the fixture corpus. It dumps nodes and links from Org-roam's database to JSON and compares them with the core's output. Fixtures then get scripted edits through the core and are synced again. Differences must appear in a checked-in allowlist with a reason, and anything else fails the build. This makes acceptance criterion 9 a continuous test at the file level.

Other test layers:

- **Property-based tests:** Random text and edits must satisfy "the scanner never throws" and "bytes outside the replacement are identical".
- **Native tests:** The Android protocol runs against a fake documents provider that fails at every step, and recovery is then checked for complete old or new content.
- **Device tests:** The provider matrix (below) and a manual checklist per milestone, since native picker and provider behavior cannot be exercised in Node.
- **End-to-end sync test:** Edit on a device, let the real sync tool carry the file, and open it in Emacs.

**Alternative:** Differential testing against `uniorg`. Rejected because Emacs is the actual compatibility target, and it avoids the question of a GPL dev dependency altogether.

### Decision 9: Keep GPL code out of the shipped app

`uniorg` is GPL-3.0-or-later, and bundling it would bind the whole app to the GPL. GPL terms have a known conflict with App Store distribution. Emacs and Org-roam are GPL too, but they only run as separate programs in CI and don't ship. The slug and parsing logic is to be written from documented behavior and test results rather than by translating Org-roam's source.

### Decision 10: A small local Expo module, staying on Expo

**Decision:** `modules/roamlet-fs` is a local module using the Expo Modules API, written in Swift and Kotlin. It covers both root kinds, so all library access has one code path. `expo-file-system` stays for internal data only.

| API | iOS | Android |
|---|---|---|
| `pickFolder` | Folder picker, saves bookmark data | `ACTION_OPEN_DOCUMENT_TREE`, persisted read and write grant |
| `restore` (ok, stale, revoked, missing) | Resolves the bookmark, refreshes it if stale, holds one long-lived `startAccessingSecurityScopedResource` | Checks the persisted grant and that the tree exists |
| `list` (name, size, mtime, isDir, downloaded, writable) | Coordinated enumeration with resource keys | One `DocumentsContract` child-documents query per directory |
| `readBytes`, `digest` | Coordinated read, SHA-256 | Stream read, SHA-256 |
| `createExclusive`, `replaceFile` | Decision 4 | Decision 4 |
| `requestDownload` | `startDownloadingUbiquitousItem` | Reading the file triggers the provider's fetch |
| `internalDirectory` | Application Support | App files directory |

App-owned folders use ordinary file paths behind the same API.

**Alternatives:**

- *`expo-file-system` alone:* iOS would ask for the folder on every launch, and saves would stay unsafe on both platforms.
- *`@react-native-documents/picker`:* It offers `requestLongTermAccess` and bookmarks, which covers picking and access only, with no coordinated write, rename, safe replace, or batched listing. Using it would mean maintaining our own module anyway plus another dependency.
- *Bare React Native or fully native apps:* They'd use the same OS APIs, so they'd add cost and solve nothing here. The module is about what the app calls, not about leaving Expo.

## Risks / Trade-offs

- **[Provider behavior varies]** → This is the largest risk now. The Milestone 0 matrix tests each target provider on real devices before dependent work. A failing provider is documented as unsupported or read-only, with a clear in-app message.
- **[Dropbox on Android may not offer folder access]** → **Unverified.** If the picker can't select a Dropbox folder, Android Dropbox users need a sync app that keeps a local folder, and the guidance says so.
- **[Google Drive and OneDrive on iOS]** → iA reported in May 2024 that they didn't allow folder access. Re-check in Milestone 0, and explain the limit in the app if it still holds.
- **[Sync tools create conflict copies ending in `.org`]** → They're treated as ordinary files with duplicate IDs: reported in diagnostics, never changed.
- **[Android folder restrictions]** → The storage root and `Download` can't be selected, so Syncthing folders must be subfolders elsewhere. Covered in guidance at pick time.
- **[Android picker issue #50386, open and reproduced on SDK 56 and 57]** → Pickers can reject after a configuration-change relaunch until the process restarts. The module would use the same activity-result mechanism, so it could be affected. Catch the rejection and show a "restart the app" message, as `app-experience` requires. Reproduce on SDK 58 in Milestone 0.
- **[Native code from a Windows machine]** → Every Swift change requires an EAS Build, and interactive iOS debugging needs a Mac. Keep Swift small, build the Android side first where local iteration works, and use a borrowed or cloud Mac if needed.
- **[Scanner diverges from Org on real files]** → Emacs conformance in CI, a corpus that grows with each found bug, and a literal-text fallback in the reader. Because saves never depend on full parsing, the worst case is a misdisplay or a wrong index entry, which is not file damage.
- **[Title splice on an unusual header]** → Title edits touch only a value span the scanner reports. If the header is ambiguous, the app inserts a new title line rather than guessing, and conformance fixtures cover odd headers.
- **[Cloud folders with many undownloaded files]** → The first index can be slow and needs a connection. Show progress, and let downloaded files work right away. The cache-evicted case repeats this cost, and may justify moving the index if eviction proves common.
- **[Slow listing on large cloud folders]** → Listing is once per reconcile, with a per-directory query. Budgets are in A8, and the tree reads from the index, so browsing doesn't wait on listings.
- **[Notes captured in the app-owned folder stay there when a folder is chosen later]** → They remain available by switching back, and through zip export. An in-app move is a future enhancement, and the UI says this when choosing a folder.
- **[No note deletion or rename in the app]** → Both remain possible through the Files app or on the desktop, except for the app-owned folder on Android. Flagged as a future enhancement.
- **[Non-`.org` files aren't shown]** → Attachments stay untouched in the folder, but images linked from notes won't render in the MVP.
- **[Filename case or Unicode normalization differences across filesystems]** → Paths are used exactly as the provider reports them, and new-file collision checks compare normalized, case-folded names.

### Assumptions to validate

Each one is tested in Milestone 0, before dependent work starts. If one fails, the listed fallback applies.

| # | Assumption | Fallback if it fails |
|---|---|---|
| A1 | iOS bookmarks and Android grants restore folder access after restart and reboot on each provider in the matrix | Provider documented as unsupported; if it's iCloud Drive, stop and return to the maintainer |
| A2 | `replaceFile` and `createExclusive` survive kill tests with verified old or new content on each provider, with exact filenames | Provider documented as read-only; if it's a primary provider, stop and return to the maintainer |
| A3 | FTS5 with `unicode61` works in `expo-sqlite` on both platforms (docs say it's on by default) | `LIKE` search only |
| A4 | A database opens at `Paths.cache` via the `directory` argument, and eviction is rare enough that rebuilds aren't a problem | Move the index to internal storage |
| A5 | Application Support and Android app files stay hidden, while `org-roam/` is visible in iOS Files | Adjust folder layout |
| A6 | UTF-8 validation is available on Hermes (`TextDecoder` with `fatal`) | Small validator in core |
| A7 | `TextInput` handles a 512 KiB document acceptably on a mid-range Android phone, and preserves text exactly | Lower the edit size limit |
| A8 | Budgets for a 5,000-note, 50 MiB library on a mid-range Android phone, on a local folder: rebuild under 60 s, no-change launch reconcile under 2 s, search under 200 ms. Cloud-folder numbers are recorded without a target at first | Run work in smaller batches, add a dedicated worker, or relax the budget |
| A9 | The #49782 fix is present in `expo-file-system@58.0.13`, and whether #50386 reproduces on SDK 58 | Pin or patch the version; keep the mitigation |
| A10 | Full folder enumeration, download status, and `requestDownload` work on iCloud Drive, including dataless files | Open on demand only, with search limited to downloaded files |

### Provider matrix (Milestone 0, go/no-go)

| Provider | Platform |
|---|---|
| iCloud Drive | iOS |
| Dropbox | iOS and Android |
| Working Copy | iOS |
| Syncthing or local folder | Android |

Each provider is tested for: access surviving a restart and a reboot, listing a 5,000-note tree, reading undownloaded files, killing the app mid-save, rename support and exact filenames, external changes picked up on return to the foreground, revoked access, and bytes confirmed intact in Emacs after sync.

**Outcome rules:** A failing provider is documented as unsupported or read-only, with a clear in-app message. If iCloud Drive, or safe saves on a primary provider, can't be made reliable, work stops and the question goes back to the maintainer before anything is built on it.

## Migration Plan

This is a first release, so there's no data migration. Roamlet doesn't change anything in a folder until the user saves, which means rollback is simply removing the app and its folder access. Index format changes trigger an automatic rebuild. Any future change to the saved library reference or journal format must carry a version field and a migration.

## Open Questions

- **Project license:** Not stated in the brief. Decision 9 keeps every option open, and the task list assumes MIT, which the maintainer should confirm before the repository is published.
- **Bundle identifier and app name registration:** Needed for EAS and doesn't affect the design. Assumed to be `com.roamlet.app` until confirmed.
- **Budget numbers in A8:** These are initial targets without real-device data and may be adjusted after Milestone 0.
