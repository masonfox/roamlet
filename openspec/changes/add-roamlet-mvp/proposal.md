## Why

Org-roam users have no good way to capture, read, or lightly edit their notes away from a computer, and any tool that rewrites their files puts a long-lived knowledge base at risk. Roamlet is a local-first iOS and Android companion that opens the user's real folder of plain `.org` files and edits them in place, so those files stay fully usable in Emacs with no conversion, migration, or import step.

## What Changes

This is a greenfield change: the repository holds only OpenSpec scaffolding today. It delivers the vertical slice **Open folder → Index → Browse → Read → Create → Edit → Retrieve in Emacs**.

- Add an Expo, React Native, and TypeScript app with three destinations: Notes, Capture, and Settings.
- Let the user pick a folder once (iCloud Drive, Dropbox, a Git working copy, a Syncthing or local folder, or any provider that allows folder access) and read and edit its files in place, with access restored on every launch. An app-owned folder is the zero-setup default, so capture works before any folder is chosen.
- Add a small local native Expo module for what `expo-file-system` lacks: lasting folder access on iOS, file coordination, and safe in-place replacement on both platforms.
- Show the library in Notes as a folder tree mirroring the real files and folders, with search across everything.
- Recognize Org-roam file-level and heading-level nodes, `#+title`, `#+filetags`, `:ID:`, and `[[id:UUID][description]]` links.
- Maintain a disposable local index for full-text search and backlinks, which can always be rebuilt from the files and is never written to the user's folder.
- Read notes in a mobile-friendly view, follow ID links, and see backlinks. Unresolved links are shown as such rather than failing.
- Create notes with valid Org-roam IDs, edit titles and body text, and insert links through search.
- Guarantee that saves are non-destructive. Edits are spliced into the original text, so every byte outside the edited range is preserved. Saves survive interruption, and external changes are never overwritten silently.
- Offer a `.zip` export, mainly so notes in the app-owned folder can always be retrieved.
- Verify compatibility against real Emacs Org-roam in automated tests, using realistic fixtures, and verify folder behavior on real devices for each supported provider.

### Explicit scope decisions

These follow from the investigation in `design.md` and refine the brief:

- **No import step.** Opening a folder replaces importing a collection, so there is no copy to keep in step and no re-import conflict logic. This changes two acceptance criteria:
  - **Criterion 2** becomes "Open an existing Org-roam folder, or start in the app-owned folder."
  - **Criterion 8** becomes "Retrieve modified files: they are already in the opened folder, and `.zip` export covers the app-owned folder."
- **Sync stays outside Roamlet.** Roamlet reads and writes the folder, and iCloud, Dropbox, Git, or Syncthing moves the files. It runs no sync protocol of its own.
- **There is no AST-based serializer.** No evaluated library reproduces source text reliably enough to be trusted with saves, so the "serializer" is a set of text-splicing operations.
- **Editing is file-scoped.** Heading-level nodes are indexed, linkable, and readable, and their text can be edited as part of the file body. There is no dedicated heading-node editor.

### Future enhancements (not in this change)

- Deleting or renaming notes and folders in the app. Both remain possible through the Files app or on the desktop.
- Copying notes from the app-owned folder into a chosen folder.
- Several libraries open at once.
- Built-in Git or WebDAV sync, and running in the background to react to changes while suspended.
- Adding an ID to a note that lacks one.
- `ROAM_ALIASES` and `ROAM_REFS` behavior (preserved in files, but not indexed), daily notes, and share-sheet capture.
- Everything the brief marks out of scope: WYSIWYG editing, agenda and TODO workflows, graph view, AI features, accounts, a hosted backend, plugins, and an Emacs server dependency.

## Capabilities

### New Capabilities

- `org-parsing`: Tolerant recognition of Org-roam nodes, metadata, and links in `.org` text, including how malformed input is handled.
- `library-storage`: Choosing and keeping access to the library folder, reading and writing files in place, interruption-safe writes, provider failure states, and archive export.
- `library-index`: The disposable index, including change detection, full rebuild, behavior when access is lost, and reporting of data problems.
- `note-browsing`: The folder tree, search, reading view, link navigation, backlinks, and unresolved-link handling.
- `note-capture-editing`: Quick capture, title and body editing, link insertion, and non-destructive saves.
- `app-experience`: Navigation between the three destinations, settings and diagnostics, appearance, and offline operation.
- `org-roam-compatibility`: The end-to-end contract that files produced or modified by Roamlet stay valid and intact in Emacs Org-roam.

### Modified Capabilities

None. There are no existing specs.

## Impact

- **Code:** New Expo Router app, a platform-independent core for parsing, editing, and indexing behind filesystem and SQL interfaces, and a local Expo module, `modules/roamlet-fs`, with Swift and Kotlin code.
- **Dependencies:** Expo SDK 58 (`expo-router`, `expo-sqlite`, `expo-file-system` for internal app data only, `expo-sharing`, `expo-crypto`) and `fflate` for export archives. No Org parser ships in the app.
- **Build:** Requires development builds rather than Expo Go, because of the native module. iOS builds need EAS or a Mac, plus an Apple Developer account for device testing. From a Windows machine, every Swift change goes through EAS Build, which slows that part of development.
- **Testing:** Real-device runs on each supported provider, because provider behavior can't be exercised in Node. CI adds an Emacs and Org-roam job as a test-only conformance check. Nothing from Emacs ships in the app, and the app has no runtime dependency on it.
- **Licensing:** The project's license is not yet chosen. Keeping GPL code out of the app (see `design.md`) leaves that choice open and avoids a known conflict with App Store distribution.
- **Systems:** No backend, accounts, telemetry, or network dependency of Roamlet's own. Cloud providers are whatever the user already uses.
