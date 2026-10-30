# Device validation

**Nothing here has been run yet, and every result cell is blank.** Fill in a cell only with what you saw on a real device. Assumptions and the matrix come from `openspec/changes/add-roamlet-mvp/design.md`, and the tasks from `tasks.md` in the same folder.

For a result, write `pass` or `fail`. Record the device model, OS version, and build in the columns, and put details, including any fallback taken, in Notes.

## Device checklist

Work through these in order.

1. **Check CI.** Confirm that CI, Conformance, Native Android, and Native iOS are green for the commit you're building.
2. **Set up EAS.** Run `npm ci` and `npx eas-cli login`. If `app.json` has no EAS project ID yet, run `npx eas-cli init` and commit the change. For iOS you need an Apple Developer account, and you register the device with `npx eas-cli device:create`.
3. **Make the development builds.** Run `npx eas-cli build --profile development --platform android` and `npx eas-cli build --profile development --platform ios`, then install each from the link EAS gives you. Expo Go can't load the native module, so it won't work.
4. **Start the bundler.** Run `npx expo start --dev-client`, and open the app on each device. Task 1.5 is done when it launches on one iOS and one Android device.
5. **Open the spike screen** with the link `roamlet:///spike`. Run `npx uri-scheme open "roamlet:///spike" --android` or `--ios`, or open the link from Safari on iOS. Then do the spike checks in tasks 1.6 and 1.7.
6. **Run the FileStore contract** (task 5.4). On the spike screen, select **Run the FileStore contract in a scratch folder**. Each case logs `PASS` or `FAIL`, with a total at the top.
   - On the app-owned folder, run it on both platforms. Scratch folders named `roamlet-contract-…` appear beside any notes there, and are removed afterward. A run that died is cleaned up by the next one. Stay in the app during a run, or a foreground reconcile could index them.
   - On Android, select **Pick folder**, choose a new, empty folder on a real provider, and run it again. It refuses a folder with anything in it. If a run dies, delete what it left by hand.
   - On iOS, it can't run on a picked folder, because the module holds the bookmark and can't make folders. A picked folder there is only covered by the spike checks and the matrix.
   - On iOS, relaunch the app after an app-owned run. Restoring the app-owned folder releases the security scope held for a picked folder.
7. **Prepare the test library:** 5,000 notes and 50 MiB, with real Org-roam structure. There's no generator in the repository, so it has to be made or copied from a real library. Keep a copy elsewhere for comparison.
8. **Run the provider matrix** (task 1.8). Start with iCloud Drive, because it's a go/no-go item. For the Emacs test, let the sync tool carry the files, run `org-roam-db-sync`, and compare bytes with your copy.
9. **Check other providers** (task 1.9).
10. **Run the assumptions** (task 1.10).
11. **Take the baselines and benchmark** (tasks 1.11 and 6.8) on a mid-range Android phone. There's no benchmark tool in the repository. The spike screen logs how long a listing takes. Timing a rebuild or a search currently means a stopwatch or added instrumentation, so say which you used in Notes.
12. **Apply the go/no-go rules** (task 1.12). If iCloud Drive, or safe saves on a primary provider, can't be made reliable, stop and take the question back before building on it. A failing provider otherwise becomes unsupported or read-only in [compatibility.md](compatibility.md). Delete the spike screen and `src/adapters/roamlet-fs-contract.ts` and its test together, but only once nothing still needs the contract run.
13. **Walk through the acceptance criteria** (task 11.5) on both platforms.

## FileStore contract (task 5.4)

| Device kind | Root | Passed | Failed | Device and OS | Build | Date | Notes |
|---|---|---|---|---|---|---|---|
| iOS | App-owned folder | | | | | | |
| Android | App-owned folder | | | | | | |
| Android | Empty picked folder (name the provider in Notes) | | | | | | |

## Task status

| Task | What it asks for | Section | Result | Date | Notes |
|---|---|---|---|---|---|
| 1.8 | Provider matrix, 5,000-note library | [Provider matrix](#provider-matrix-task-18) | | | |
| 1.9 | Google Drive and OneDrive on iOS, Dropbox on Android | [Other providers](#other-providers-task-19) | | | |
| 1.10 | Assumptions A3 to A7, A9, A10 | [Assumptions](#assumptions-a1-to-a10) | | | |
| 1.11 | A8 baselines for listing and hashing | [A8 baselines](#a8-baselines-task-111) | | | |
| 6.8 | A8 benchmark for rebuild, reconcile, and search | [A8 benchmark](#a8-benchmark-task-68) | | | |

## Provider matrix (task 1.8)

| Provider | Platform | Test | Result | Device and OS | Build | Date | Notes |
|---|---|---|---|---|---|---|---|
| iCloud Drive | iOS | Access survives a restart | | | | | |
| iCloud Drive | iOS | Access survives a reboot | | | | | |
| iCloud Drive | iOS | Lists a 5,000-note tree | | | | | |
| iCloud Drive | iOS | Reads undownloaded files | | | | | |
| iCloud Drive | iOS | Killing the app mid-save leaves verified old or new content | | | | | |
| iCloud Drive | iOS | Rename support and exact filenames | | | | | |
| iCloud Drive | iOS | External changes picked up on return to the foreground | | | | | |
| iCloud Drive | iOS | Revoked access | | | | | |
| iCloud Drive | iOS | Bytes confirmed intact in Emacs after sync | | | | | |
| Dropbox | iOS | Access survives a restart | | | | | |
| Dropbox | iOS | Access survives a reboot | | | | | |
| Dropbox | iOS | Lists a 5,000-note tree | | | | | |
| Dropbox | iOS | Reads undownloaded files | | | | | |
| Dropbox | iOS | Killing the app mid-save leaves verified old or new content | | | | | |
| Dropbox | iOS | Rename support and exact filenames | | | | | |
| Dropbox | iOS | External changes picked up on return to the foreground | | | | | |
| Dropbox | iOS | Revoked access | | | | | |
| Dropbox | iOS | Bytes confirmed intact in Emacs after sync | | | | | |
| Dropbox | Android | Access survives a restart | | | | | |
| Dropbox | Android | Access survives a reboot | | | | | |
| Dropbox | Android | Lists a 5,000-note tree | | | | | |
| Dropbox | Android | Reads undownloaded files | | | | | |
| Dropbox | Android | Killing the app mid-save leaves verified old or new content | | | | | |
| Dropbox | Android | Rename support and exact filenames | | | | | |
| Dropbox | Android | External changes picked up on return to the foreground | | | | | |
| Dropbox | Android | Revoked access | | | | | |
| Dropbox | Android | Bytes confirmed intact in Emacs after sync | | | | | |
| Working Copy | iOS | Access survives a restart | | | | | |
| Working Copy | iOS | Access survives a reboot | | | | | |
| Working Copy | iOS | Lists a 5,000-note tree | | | | | |
| Working Copy | iOS | Reads undownloaded files | | | | | |
| Working Copy | iOS | Killing the app mid-save leaves verified old or new content | | | | | |
| Working Copy | iOS | Rename support and exact filenames | | | | | |
| Working Copy | iOS | External changes picked up on return to the foreground | | | | | |
| Working Copy | iOS | Revoked access | | | | | |
| Working Copy | iOS | Bytes confirmed intact in Emacs after sync | | | | | |
| Syncthing or local folder | Android | Access survives a restart | | | | | |
| Syncthing or local folder | Android | Access survives a reboot | | | | | |
| Syncthing or local folder | Android | Lists a 5,000-note tree | | | | | |
| Syncthing or local folder | Android | Reads undownloaded files | | | | | |
| Syncthing or local folder | Android | Killing the app mid-save leaves verified old or new content | | | | | |
| Syncthing or local folder | Android | Rename support and exact filenames | | | | | |
| Syncthing or local folder | Android | External changes picked up on return to the foreground | | | | | |
| Syncthing or local folder | Android | Revoked access | | | | | |
| Syncthing or local folder | Android | Bytes confirmed intact in Emacs after sync | | | | | |

## Other providers (task 1.9)

| Question | Platform | Folder access offered? | Device and OS | Provider app version | Date | Notes |
|---|---|---|---|---|---|---|
| Does Google Drive allow folder access? | iOS | | | | | |
| Does OneDrive allow folder access? | iOS | | | | | |
| Does Dropbox offer folder access? | Android | | | | | |

## Assumptions (A1 to A10)

| # | Assumption | Task | Fallback if it fails | Result | Fallback taken | Device and OS | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| A1 | iOS bookmarks and Android grants restore folder access after restart and reboot on each provider in the matrix | 1.8 | Provider documented as unsupported. If it's iCloud Drive, stop and return to the maintainer | | | | | |
| A2 | `replaceFile` and `createExclusive` survive kill tests with verified old or new content on each provider, with exact filenames | 1.8 | Provider documented as read-only. If it's a primary provider, stop and return to the maintainer | | | | | |
| A3 | FTS5 with `unicode61` works in `expo-sqlite` on both platforms | 1.10 | `LIKE` search only | | | | | |
| A4 | A database opens at `Paths.cache` via the `directory` argument, and eviction is rare enough that rebuilds aren't a problem | 1.10 | Move the index to internal storage | | | | | |
| A5 | Application Support and Android app files stay hidden, while `org-roam/` is visible in iOS Files | 1.10 | Adjust folder layout | | | | | |
| A6 | UTF-8 validation is available on Hermes (`TextDecoder` with `fatal`) | 1.10 | Small validator in core | | | | | |
| A7 | `TextInput` handles a 512 KiB document acceptably on a mid-range Android phone, and preserves text exactly | 1.10 | Lower the edit size limit | | | | | |
| A8 | Budgets for a 5,000-note, 50 MiB library on a mid-range Android phone, on a local folder: rebuild under 60 s, no-change launch reconcile under 2 s, search under 200 ms. Cloud-folder numbers are recorded without a target at first | 1.11, 6.8 | Run work in smaller batches, add a dedicated worker, or relax the budget | | | | | |
| A9 | The #49782 fix is present in `expo-file-system@58.0.13`, and whether #50386 reproduces on SDK 58 | 1.10 | Pin or patch the version, and keep the mitigation | | | | | |
| A10 | Full folder enumeration, download status, and `requestDownload` work on iCloud Drive, including dataless files | 1.10 | Open on demand only, with search limited to downloaded files | | | | | |

## A8 baselines (task 1.11)

| Measure | Folder | Provider | Notes in library | Library size | Time | Device and OS | Date | Notes |
|---|---|---|---|---|---|---|---|---|
| Listing | Local | | | | | | | |
| Hashing | Local | | | | | | | |
| Listing | Cloud | | | | | | | |
| Hashing | Cloud | | | | | | | |

## A8 benchmark (task 6.8)

| Measure | Folder | Budget | Time | Result | Device and OS | Date | Notes |
|---|---|---|---|---|---|---|---|
| Full rebuild | Local | Under 60 s | | | | | |
| No-change launch reconcile | Local | Under 2 s | | | | | |
| Search | Local | Under 200 ms | | | | | |
| Full rebuild | Cloud | None yet | | | | | |
| No-change launch reconcile | Cloud | None yet | | | | | |
| Search | Cloud | None yet | | | | | |

## Acceptance criteria (task 11.5)

Criteria 2 and 8 use the wording as revised in `proposal.md`. The repository doesn't hold the full text of the others, so they're summarized from the tasks in `tasks.md` that deliver them.

| # | Criterion | Delivered by | iOS result | Android result | Device and OS | Date | Notes |
|---|---|---|---|---|---|---|---|
| 1 | The app launches from a development build on a real device | 1.5 | | | | | |
| 2 | Open an existing Org-roam folder, or start in the app-owned folder | 7.3 | | | | | |
| 3 | Search works across the library in airplane mode | 7.6 | | | | | |
| 4 | Follow resolved, heading, and missing ID links | 7.8 | | | | | |
| 5 | Backlinks match the Org-roam oracle's output for the same folder | 7.9 | | | | | |
| 6 | A captured note appears at once in the tree and search, is written to the chosen folder's root, and passes the oracle | 8.2 | | | | | |
| 7 | After editing one word, a file diff shows only that word | 9.2 | | | | | |
| 8 | Retrieve modified files: they are already in the opened folder, and `.zip` export covers the app-owned folder | 10.1, 11.1 | | | | | |
| 9 | After the sync tool carries files to Emacs and `org-roam-db-sync` runs, IDs, links, and content are intact | 11.1 | | | | | |
| 10 | Rebuild Index resumes after being killed, and its results match the files | 10.2 | | | | | |
