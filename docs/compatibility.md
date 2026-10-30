# Compatibility

What Roamlet is expected to work with, what it understands, and where it falls short.

## Supported providers

**The provider matrix has not been run yet, so no provider is proven.** Every entry below is an expectation, based on documentation, source reading, and other apps' reports. Results will be recorded in [validation.md](validation.md). A provider that fails will be documented as unsupported or read-only, with a clear message in the app.

### Expected to work, not proven

| Provider | Platform | Basis for the expectation |
|---|---|---|
| iCloud Drive | iOS | Apple documents folder pickers with lasting bookmarks. iA Writer edits iCloud Drive folders in place. |
| Dropbox | iOS | iA Writer opens Dropbox folders in place on iOS. |
| Working Copy | iOS | iA Writer opens Working Copy folders in place on iOS. |
| Syncthing or a local folder | Android | Android documents persisted grants through `ACTION_OPEN_DOCUMENT_TREE`. Use a subfolder, as described under [Platform limits](#platform-limits). |

### Unknown or expected not to work

| Provider | Platform | What's known |
|---|---|---|
| Dropbox | Android | **Unverified**, even though it's in the matrix. If the picker can't select a Dropbox folder, Android Dropbox users will need a sync app that keeps a local folder. |
| Google Drive | iOS | Expected not to work. iA reported in May 2024 that it didn't allow folder access from other apps. To be re-checked. |
| OneDrive | iOS | Expected not to work, for the same reason and from the same report. To be re-checked. |
| Any other provider | Either | Not planned for testing. It might work if the system picker lets you select a folder. |

### Platform limits

- **Android:** The system picker can't select the storage root, an SD card root, or `Download` on Android 11 and later, so a Syncthing folder must be a subfolder elsewhere.
- **Android:** Folder pickers can fail after a configuration-change relaunch until the process restarts (Expo issue #50386, reproduced on SDK 56 and 57, and not yet checked on 58). If that happens, Roamlet asks you to restart the app.
- **iOS:** You can withdraw folder access in Settings. Roamlet then offers to reconnect, without treating your notes as deleted.

### How saves differ by provider

Saves always check that the file hasn't changed since you opened it.

- **iOS:** A coordinated `replaceItemAt` swap. A crash before the swap leaves the original untouched.
- **Android, provider supports rename:** A hidden temp file (`.roamlet-<id>.tmp`) is written, verified, and swapped in by renames. Recovery finishes or undoes an interrupted swap on the next launch.
- **Android, provider can't rename:** The old bytes are backed up internally, then the file is rewritten in place. **While this happens, a partial file exists at the note's path, and a sync tool could pick it up.** It's only used where no better option exists. The matrix will show which providers need it.

Also note:

- A sync tool can see a temp file or a brief gap during a save on a cloud folder. Temp names are hidden and don't end in `.org`, so Org-roam ignores them.
- Whether data reaches the disk on power loss depends on the provider.
- `replaceItemAt` and `renameDocument` behavior on real providers is unproven until the matrix runs.

## Supported Org subset

Roamlet isn't a general Org parser. It recognizes what Org-roam semantics and the reader need, and anything else is treated as text. Saves never depend on this parsing, so the worst case for a misread construct is a wrong display or index entry, not file damage.

**Nodes and metadata**

- **File-level nodes:** A property drawer with a non-empty `ID`, with only blank lines and comments before it.
- **Heading-level nodes:** A heading whose own property drawer has a non-empty `ID`.
- **`ROAM_EXCLUDE`:** A non-nil value excludes that entry. It isn't inherited.
- **Titles:** The first `#+title`, or else the file name without its extension. Heading titles leave out stars, the TODO keyword, the priority cookie, and trailing tags.
- **Tags:** `#+filetags` and heading tags, with inheritance.
- **TODO keywords:** `TODO`, `DONE`, and keywords declared in the file (`#+TODO` and its variants).
- **Names:** Drawer and keyword names match case-insensitively.
- **Preserved but not indexed:** `ROAM_ALIASES` and `ROAM_REFS`.

**Links**

- `[[id:TARGET]]` and `[[id:TARGET][description]]`, as well as plain and angle forms, including in property drawers and keywords, as Org-roam counts them.
- Not recognized inside source blocks, example blocks, comment lines, fixed-width lines, or inline verbatim and code markup.
- Links outside any node aren't backlink sources.
- Web links open outside the app. Other types, such as `roam:` and `cite:`, show as text.
- A link with no matching node is shown as unresolved, and resolves by itself if the target appears later.

**Structure**

- A line starting with stars and a space is a heading, even inside a block, as in Org. `,*` is the escape. A block with no end line before the next heading is ordinary text.
- LF, CRLF, and mixed line endings, plus a BOM, are handled, and preserved outside the edited range.
- Files must be valid UTF-8 to be edited. Other files are flagged in diagnostics, can't be edited, and stay byte-identical.

**Reader**

- Headings, paragraphs, lists, emphasis, links, quotes, source and example blocks, and tables.
- Source blocks and tables are horizontally scrollable monospace text, with no syntax highlighting or table layout.
- Everything else, such as a LaTeX environment or a dynamic block, is shown as literal text and never dropped.
- Property drawers are hidden. They're visible in the editor.

**New notes** follow Org-roam's defaults: `:ID:` with a lowercase UUID, `#+title:`, and a `%Y%m%d%H%M%S-${slug}.org` name, in the library root.

## Differences from Org-roam

CI compares Roamlet with real Org-roam (2.3.1) over `test/fixtures/`. Each remaining difference is justified in `test/emacs/allowlist.json`. All 18 entries fall into these groups:

| Case | Org-roam | Roamlet | Fixtures | Entries |
|---|---|---|---|---|
| **Mixed line endings** | Decodes the file as Unix, so a CR stays on CRLF lines. It misses the file drawer, stores IDs and titles with a trailing CR, and a CR-broken source block lets a link count. | Accepts both endings on every line, so it finds the drawer, reads clean IDs, and keeps the block's link verbatim. | `line-endings-mixed.org` | 7 |
| **Empty link `[[id:]]`** | Stores a link to an empty ID, which can never resolve. | Records no link. | `broken-links.org` | 1 |
| **Blank line before the file drawer** | Doesn't see the node. A comment line alone is fine. | Lists the node, as the spec requires. So the app can list a node that Emacs doesn't, and nothing in the file changes. | `comments-before-drawer.org`, `drawer-after-blank.org` | 2 |
| **Duplicate IDs, across or within files** | Keeps one row per ID: the first to sync, or the first heading in a file. | Keeps every holder as data and reports them. | `duplicate-ids-a.org` | 2 |
| **Sync conflict copies with duplicate IDs** | Keeps one holder, in sync order. | Keeps every holder, and its lookup winner is the original. So the two tools can pick different holders. | `note (Laptop's conflicted copy 2026-01-15).org`, `note.org` | 4 |
| **No title keyword** | Stores an empty title. | Uses the file name. | `20260101120000-foo.org` | 1 |
| **Two title keywords** | Joins them. | Uses the first, which is also the only value a title edit replaces. | `multiple-titles.org` | 1 |

## Sync conflicts

Sync tools can create conflict copies ending in `.org`. They're treated as ordinary files with duplicate IDs: reported in diagnostics and never changed.

When several files hold an ID, a link goes to the lowest path among files that don't look like a sync tool's copy, or to the lowest path overall if only copies remain.

**Recognition goes by English Dropbox and Syncthing names:** `<name>.sync-conflict-<date>-<time>-<device>.org` and `<name> (<device>'s conflicted copy <date>).org`. A copy named some other way, such as by a localized Dropbox, isn't recognized. It still appears as a duplicate, but it can win the lookup if its path sorts first, and Dropbox's copy would do so, since a space sorts before a dot.

Roamlet's own conflict copies, made when you choose to keep your edit after a file changed underneath you, are named like `note.org.conflict-20260115093000`. They don't end in `.org`, so they aren't notes in either tool. Export includes them.

## Known limitations

**Emacs configuration isn't visible to the app**

- Keywords configured globally in Emacs aren't known, and will appear in heading titles. Declare them in the file with `#+TODO` to avoid this.
- `org-roam-db-node-include-function` and other Emacs customization don't apply.

**Library**

- One library is open at a time.
- Only `.org` files are notes. Hidden files and folders, such as `.git`, `.stfolder`, and `.stversions`, are skipped. Attachments, encrypted notes, and editor backups are left untouched.
- Images linked from notes don't render.
- Notes can't be deleted or renamed in the app. Use the Files app or the desktop, which isn't possible for the app-owned folder on Android.
- Notes captured in the app-owned folder stay there when you choose another folder. Switch back or export to reach them.
- The app-owned folder is visible in iOS Files, but private on Android.

**Cloud folders**

- The first index needs each file's content, so it can be slow and needs a connection. Downloaded files work right away.
- Files not on the device appear by name only, and their content isn't searchable until downloaded. A file that the provider evicts keeps its known links and search entries.
- Listing a large cloud folder can be slow. Browsing reads from the index, so it doesn't wait for a listing.
- The index lives in the app's cache. If the OS evicts it, the next launch rebuilds it, which on a cloud folder repeats the download cost.

**Changes from outside**

- There's no live watching or background work. Outside changes are picked up at launch, on returning to the foreground, after switching library, and on request.

**Names**

- Paths are used exactly as the provider reports them. Only new-file collision checks compare normalized, case-folded names, so names differing in case or Unicode form can behave differently across filesystems.

**Editing**

- Editing is file-scoped, with a title field and a plain-text body. There's no dedicated heading editor, so heading drawers appear in the body. You get a warning before a save that would lose, change, or duplicate an ID.
- If a title line is ambiguous, Roamlet inserts a new title line rather than guessing.
- Saving is explicit. There's no autosave, though unsaved text is kept as a draft.
- Files over 512 KiB can be read but not edited. This limit is provisional.
- A file with no ID stays that way. Roamlet won't add one.
- Captured notes are created in the library root.

**Search**

- Queries containing CJK characters fall back to a linear scan, because the tokenizer doesn't segment them. That's acceptable at MVP scale, but slower.

**Performance**

- The budgets for a 5,000-note, 50 MiB library (rebuild under 60 s, no-change launch under 2 s, search under 200 ms) are initial targets with no device data behind them.

**Not in this release**

Deleting or renaming in the app, copying notes between libraries, several libraries at once, built-in Git or WebDAV sync, background updates, adding an ID to a note, `ROAM_ALIASES` and `ROAM_REFS` behavior, daily notes, share-sheet capture, WYSIWYG editing, agenda and TODO workflows, graph view, AI features, accounts, a hosted backend, plugins, and an Emacs server dependency.

## Cross-check against the design

Each limitation and risk in `openspec/changes/add-roamlet-mvp/design.md` and where it's covered. "README" means the root `README.md`, and other sections are on this page.

| Source in `design.md` | Item | Covered in |
|---|---|---|
| Decision 1 | Globally configured keywords appear in titles | Known limitations |
| Decision 1 | `org-roam-db-node-include-function` and customization not visible | Known limitations |
| Decision 1 | `id:` forms, `ROAM_EXCLUDE` not inherited, allowlisted differences | Supported Org subset, Differences from Org-roam |
| Decision 3 | Android can't select storage root, SD root, or `Download` | Platform limits |
| Decision 3 | App-owned folder visible on iOS, private on Android | Known limitations, README |
| Decision 3 | Hidden files skipped, non-`.org` files untouched | Known limitations |
| Decision 3 | Files not on the device, eviction keeps index rows | Known limitations |
| Decision 4 | Android non-rename fallback's partial-file window | How saves differ by provider |
| Decision 4 | Sync tools can see temp files or a gap | How saves differ by provider |
| Decision 4 | Provider behavior unproven, flush on power loss | How saves differ by provider |
| Decision 5 | Conflict recognition goes by English Dropbox and Syncthing names | Sync conflicts |
| Decision 5 | Rebuild needs content, cache eviction | Known limitations |
| Decision 5 | CJK search is a linear scan | Known limitations |
| Decision 5 | No file watching | Known limitations |
| Decision 2, 7 | File-scoped editing, heading drawers in the body | Known limitations |
| Decision 7 | No syntax highlighting or table layout | Supported Org subset |
| Decision 7 | 512 KiB edit limit, provisional | Known limitations |
| Decision 7 | Invalid UTF-8 can't be edited | Supported Org subset |
| Decision 7 | Explicit Save, new files in the root | Known limitations |
| Non-goals | One library, no background work, no sync protocol | Known limitations, README |
| Risk | Provider behavior varies | Supported providers |
| Risk | Dropbox on Android may not offer folder access | Unknown or expected not to work |
| Risk | Google Drive and OneDrive on iOS | Unknown or expected not to work |
| Risk | Sync tools create conflict copies ending in `.org` | Sync conflicts |
| Risk | Android folder restrictions | Platform limits |
| Risk | Android picker issue #50386 | Platform limits |
| Risk | Native code from a Windows machine | README, Building |
| Risk | Scanner diverges from Org on real files | Supported Org subset, Differences from Org-roam |
| Risk | Title splice on an unusual header | Known limitations |
| Risk | Cloud folders with many undownloaded files | Known limitations |
| Risk | Slow listing on large cloud folders | Known limitations |
| Risk | App-owned notes stay when a folder is chosen | Known limitations, README |
| Risk | No note deletion or rename in the app | Known limitations |
| Risk | Non-`.org` files aren't shown, images don't render | Known limitations |
| Risk | Filename case or Unicode normalization | Known limitations |
| Open question | A8 budgets may change | Known limitations |
| `allowlist.json` | All 18 entries | Differences from Org-roam |
