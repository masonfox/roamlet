# Roamlet

A local-first iOS and Android companion for [Org-roam](https://www.orgroam.com/). Roamlet opens your real folder of plain `.org` files and lets you capture, read, and lightly edit them in place, so they stay fully usable in Emacs with no conversion or import.

- **No import.** You pick a folder once, and Roamlet reads and edits the files where they are. An app-owned folder is the zero-setup default, so capture works before you choose one.
- **Saves don't rewrite your files.** An edit is spliced into the original text, so every byte outside the edited range is preserved. Saves are designed to survive interruption, and a file that changed underneath you is never overwritten silently.
- **Sync stays outside the app.** iCloud Drive, Dropbox, Git, or Syncthing moves the files. Roamlet has no accounts, backend, or telemetry.
- **The index is disposable.** Search and backlinks come from a local cache that can always be rebuilt from the files, and it's never written to your folder.

## Status

Roamlet is pre-release. **It has not been validated on real devices yet.** The automated tests cover the core, the Emacs conformance job, and the native save protocols under simulated failure, but the folder behavior of real providers is unproven until the device matrix runs. Results will be recorded in [docs/validation.md](docs/validation.md), which is still blank.

Don't point it at your only copy of a library yet.

## Documentation

- [docs/compatibility.md](docs/compatibility.md): supported providers, the supported Org subset, differences from Org-roam, and known limitations.
- [docs/validation.md](docs/validation.md): the device validation template and the maintainer's checklist.
- [openspec/changes/add-roamlet-mvp/](openspec/changes/add-roamlet-mvp/): the proposal, design, specs, and tasks.

## Getting your notes out of the app-owned folder

Notes in a folder you chose are already there, so there's nothing to retrieve. Notes captured in the app-owned folder stay in it when you later choose a folder, and an in-app move isn't available yet. To reach them:

- **iOS:** Open the Files app and find the `org-roam` folder under Roamlet's location on the device. You can copy the files from there.
- **Android:** The folder is private to the app, so use the export below.
- **Either platform:** In Settings, select **Export library**. If another folder is active, select **Switch to Roamlet's own folder** first. Export produces a `.zip` of the library's `.org` files and conflict copies at their relative paths, byte-identical to the originals, through the system share sheet. It contains no index, drafts, or recovery files.

Uninstalling the app removes the app-owned folder, so export first.

## Building

**Expo Go can't run Roamlet.** The app depends on a local native module, `modules/roamlet-fs`, and Expo Go can't load it. Merely importing the module throws there. You need a development build.

Prerequisites: Node 24 and an [Expo account](https://expo.dev/signup). iOS device builds also need an Apple Developer account.

```sh
npm ci
npx eas-cli login
npx eas-cli init                                       # once: links the project and adds its ID to app.json
npx eas-cli device:create                              # iOS only: registers your device
npx eas-cli build --profile development --platform android
npx eas-cli build --profile development --platform ios
```

Install the result on the device, then start the bundler and open the app:

```sh
npx expo start --dev-client
```

The `development-simulator` profile builds for the iOS Simulator instead. Folder pickers and cloud providers can't be validated there.

On a machine with the Android SDK, `npx expo run:android` builds locally. Every Swift change needs a new EAS build or a Mac, and interactive iOS debugging needs a Mac, so the Android side is the faster place to iterate.

## Development

```sh
npm run lint
npm run typecheck
npm test
```

`src/core/` is free of React Native and Expo, and lint enforces that, so its tests run in plain Node. Other checks run in GitHub Actions:

- **Conformance** (`.github/workflows/conformance.yml`) runs real Emacs and Org-roam at pinned versions over `test/fixtures/`, and compares the results with the scanner's. Any difference must be justified in `test/emacs/allowlist.json`.
- **Native Android** runs the save protocols against a fake documents provider that fails at every step.
- **Native iOS** runs the Swift tests.

Emacs and Org-roam are GPL and only run as separate programs in CI. Nothing from them ships in the app.

## License

[MIT](LICENSE)
