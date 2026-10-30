## Purpose

Defines where the library lives, how Roamlet gains and keeps access to the user's own folder, how files are read and written in place, and how writes are protected against interruption and silent data loss.

## ADDED Requirements

### Requirement: Library location
The system SHALL have exactly one active library, which is either a folder the user chose or an app-owned folder. The app-owned folder SHALL be created automatically and SHALL be usable without any setup. Notes SHALL be plain `.org` files at their real paths, and no copy of them SHALL be kept as a source of truth.

#### Scenario: First launch
- **WHEN** the app launches for the first time
- **THEN** the app-owned folder is active, notes can be captured without further setup, and the user is offered the choice of opening an existing folder

#### Scenario: Choosing a folder
- **WHEN** the user chooses an existing Org-roam folder
- **THEN** that folder becomes the active library and its notes become browsable after indexing, with no files copied, added, or changed

#### Scenario: App-owned folder on iOS
- **WHEN** the user opens Roamlet's location in the iOS Files app
- **THEN** the app-owned folder's `.org` files are visible, and app-internal data is not

#### Scenario: Switching library
- **WHEN** the user switches to a different folder or back to the app-owned folder
- **THEN** the new library is shown, and the files in the previous library are left untouched and available if the user switches back

### Requirement: Lasting folder access
The system SHALL keep access to a chosen folder across app restarts and device reboots without asking the user to choose it again, for as long as the platform permits.

#### Scenario: Restart
- **WHEN** the user reopens the app after it has been terminated or the device has rebooted
- **THEN** the chosen folder is available without any prompt

#### Scenario: Reference needs refreshing
- **WHEN** the platform reports that the saved folder reference is out of date but still usable
- **THEN** the system refreshes the reference with no user action

### Requirement: Loss of folder access
When a chosen folder is unavailable because access was revoked, or the folder was moved or deleted, the system SHALL show a state offering to reconnect the folder. It SHALL NOT treat the files as deleted, SHALL NOT write anything, and SHALL NOT discard unsaved text.

#### Scenario: Access revoked
- **WHEN** the user revokes Roamlet's folder access in system settings and opens the app
- **THEN** the app explains that access was lost and offers to choose the folder again

#### Scenario: Reconnecting
- **WHEN** the user reconnects the same folder
- **THEN** the library is available again, and any unsaved text is still present

### Requirement: Provider limits
The system SHALL explain, in plain language, when a chosen location can't be used, and SHALL keep the current library active in that case. A location that can be read but not written SHALL be usable for reading.

#### Scenario: Provider doesn't allow folder access
- **WHEN** the user tries to choose a location whose provider doesn't allow folder access
- **THEN** the app explains that this provider can't be used as a library and keeps the current library

#### Scenario: Restricted Android location
- **WHEN** the system picker on Android doesn't allow a location such as the storage root or `Download`
- **THEN** Roamlet's guidance explains that a subfolder must be used

#### Scenario: Read-only location
- **WHEN** the chosen folder doesn't allow writing
- **THEN** notes can be browsed and read, and the app explains that editing and capture are unavailable

### Requirement: In-place files
The system SHALL read and write notes directly at their real paths in the library. It SHALL treat files ending in `.org` as notes and SHALL ignore everything else, including hidden files and folders, version-control data, encrypted notes, attachments, editor lock files, and editor backup files. Ignored files SHALL NOT be changed. Apart from notes the user creates and conflict copies, the system SHALL leave no lasting files in a chosen folder.

#### Scenario: Files in subfolders
- **WHEN** a library contains `daily/2026-01-02.org`
- **THEN** the note is available at that path, and an edit changes that file

#### Scenario: Ignored files
- **WHEN** a library contains `.git/`, `.stfolder/`, `secret.org.gpg`, `image.png`, `.#note.org`, and `note.org~`
- **THEN** none are treated as notes, and none are changed

#### Scenario: Files without IDs
- **WHEN** a file has no `ID` property
- **THEN** the file is usable and no ID is added

#### Scenario: Nothing added by browsing
- **WHEN** the user opens a folder and browses it without saving anything
- **THEN** the folder's contents are unchanged

### Requirement: Files not yet downloaded
The system SHALL recognize files that a cloud provider lists but hasn't stored on the device. It SHALL request their download when possible, and SHALL show them as unavailable until the content is on the device. Downloading SHALL NOT change file content. A file later removed from the device by the provider, but still listed, SHALL keep its known place in the library.

#### Scenario: Opening an undownloaded note
- **WHEN** the user opens a note that isn't on the device yet and a connection is available
- **THEN** the system downloads it and then opens it

#### Scenario: Undownloaded note while offline
- **WHEN** the user opens a note that isn't on the device and there is no connection
- **THEN** the app explains that the note isn't available offline and doesn't show an empty note

#### Scenario: Provider removes the local copy
- **WHEN** the provider removes a file's local copy to save space but still lists the file
- **THEN** the note stays in the library, its links and backlinks stay available, and the note is treated as not downloaded

### Requirement: Export
The system SHALL export the library's `.org` files and conflict copies as a `.zip` archive through the platform share sheet, at their relative paths and byte-identical to the library files, with no app-internal data. Files that aren't on the device SHALL be listed as omitted. Export SHALL NOT require a network connection for files already on the device.

#### Scenario: Retrieving notes from the app-owned folder
- **WHEN** the user exports the app-owned folder and extracts the archive into a directory
- **THEN** the `.org` files and subdirectory structure match the library exactly

#### Scenario: Export excludes internals
- **WHEN** the user inspects an exported archive
- **THEN** it contains no index files, drafts, or recovery files

#### Scenario: Files not on the device
- **WHEN** some files in the library haven't been downloaded at export time
- **THEN** the export completes with the available files, and the omitted files are listed

### Requirement: Interruption-safe writes
The system SHALL write note changes so that an interruption at any point leaves either the complete old content or the complete new content recoverable, and SHALL finish any recovery before that library is next used. New content SHALL be verified before it replaces existing content.

#### Scenario: Interrupted save
- **WHEN** the app is terminated at any step of saving a note
- **THEN** after recovery on the next launch, the note contains either the complete old content or the complete new content, and no partial file or temporary file remains in the folder

#### Scenario: Failed write
- **WHEN** a save fails, such as when storage is full or the provider returns an error
- **THEN** the existing file's content is preserved, the user's edits are retained in the editor, and an error is shown

#### Scenario: Recovery while the folder is unavailable
- **WHEN** recovery is needed but the folder is currently unavailable
- **THEN** recovery waits until access returns, and the data needed to finish it is kept

#### Scenario: Temporary files are never notes
- **WHEN** a temporary file exists briefly during a save
- **THEN** it doesn't appear in the library, in search, or in exports, and it isn't recognized as a note by Roamlet or Org-roam

### Requirement: Filename integrity
Files written by the system SHALL have exactly the intended name. The system SHALL verify the resulting name after creating or replacing a file, because some providers alter names. It SHALL NOT leave an altered name in place.

#### Scenario: Provider alters a new file's name
- **WHEN** a provider adds a suffix or extension to a newly created note
- **THEN** the system corrects the name or, if that isn't possible, reports the failure and doesn't report the note as saved

### Requirement: Encoding preservation
The system SHALL treat file content as UTF-8 and SHALL preserve file bytes, including any byte order mark. Files that are not valid UTF-8 SHALL be left unchanged and SHALL NOT be editable.

#### Scenario: Unicode content
- **WHEN** a note contains accented text, CJK text, and emoji
- **THEN** the content displays correctly and survives editing and sync intact

#### Scenario: Invalid UTF-8
- **WHEN** a file is not valid UTF-8
- **THEN** the file is flagged in diagnostics, cannot be edited, and remains byte-identical
