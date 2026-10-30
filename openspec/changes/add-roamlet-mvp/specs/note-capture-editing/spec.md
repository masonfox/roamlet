## Purpose

Defines how users create notes with minimal friction and edit existing notes through plain text, without disturbing any syntax they did not change.

## ADDED Requirements

### Requirement: Quick capture
The system SHALL let the user create a note from any primary destination, requiring only text. Capture SHALL NOT require a title field, tags, folder, or template. The first non-empty line SHALL become the title and the remaining text SHALL become the body. A first line too long to use as a title SHALL be shortened for the title, with the full text retained in the body.

#### Scenario: One-line capture
- **WHEN** the user enters `Buy a better notebook` and saves
- **THEN** a note titled `Buy a better notebook` exists with an empty body

#### Scenario: Multi-line capture
- **WHEN** the user enters a first line followed by more lines and saves
- **THEN** the first line is the title and the other lines are the body

#### Scenario: Long first line
- **WHEN** the first line is too long to use as a title
- **THEN** the title is a shortened form of the line, and the body contains the full text

#### Scenario: Empty capture
- **WHEN** the text is empty or only whitespace
- **THEN** saving is unavailable, and no file is created

### Requirement: New note format
A new note SHALL be a valid Org-roam file-level node: a property drawer with a generated lowercase UUID `ID`, followed by a `#+title` keyword and the body, with LF line endings and a trailing newline. It SHALL be created in the root of the active library. Its filename SHALL follow Org-roam's default `YYYYMMDDHHMMSS-slug.org` form and SHALL never replace an existing file.

#### Scenario: Generated file content
- **WHEN** the user captures a note titled `Café Notes!`
- **THEN** the file has a valid `ID`, the line `#+title: Café Notes!`, and a filename such as `20260115093000-cafe_notes.org`

#### Scenario: Title with no usable slug characters
- **WHEN** a title contains no letters or digits
- **THEN** the filename is still valid and uses a placeholder slug

#### Scenario: Filename collision
- **WHEN** the generated filename already exists
- **THEN** the system picks a different filename, and the existing file is unchanged

#### Scenario: Capture to a chosen folder
- **WHEN** the active library is a folder the user chose
- **THEN** the new note is written in that folder's root, ready for the user's sync tool to pick up

#### Scenario: Capture when the library can't be written
- **WHEN** the active library is read-only or currently unavailable
- **THEN** the captured text is kept as a draft, the app explains why it can't be saved, and no text is lost

### Requirement: Plain-text editing
The system SHALL let the user edit a note's title and body as plain text. The body SHALL include all text after the file's metadata header, including headings, drawers, and blocks, exactly as written.

#### Scenario: Editing a note with complex syntax
- **WHEN** the user opens a note with headings, property drawers, and source blocks for editing
- **THEN** all of that syntax is visible as editable text, with no formatting applied

#### Scenario: File too large to edit
- **WHEN** a file exceeds the supported editing size
- **THEN** it can still be read, and the app explains why it cannot be edited

#### Scenario: Read-only location
- **WHEN** the active library doesn't allow writing
- **THEN** the note can still be read, and the app explains why it cannot be edited

#### Scenario: Provider rejects a save
- **WHEN** the provider rejects a save, or access is lost while editing
- **THEN** the file's content is preserved, the user's text stays in the editor, and an error is shown

### Requirement: Non-destructive save
Saving SHALL change only the text the user changed. Every byte outside the edited range SHALL be preserved, including unsupported syntax, whitespace, keyword casing, property alignment, byte order mark, and line endings. Inserted line endings SHALL follow the file's existing style. The filename SHALL NOT change.

#### Scenario: Body edit
- **WHEN** the user changes one word in a note containing tables, source blocks, and custom drawers
- **THEN** the only difference between the old and new file is that word

#### Scenario: Title edit
- **WHEN** the user edits the title of a file with `#+TITLE:   Old`
- **THEN** only the title value changes, and the keyword casing, spacing, and filename are kept

#### Scenario: Save without changes
- **WHEN** the user saves with no changes
- **THEN** the file is not rewritten

#### Scenario: CRLF file
- **WHEN** the user edits a file that uses CRLF line endings
- **THEN** existing line endings are unchanged and new lines use CRLF

#### Scenario: Mixed line endings
- **WHEN** the user edits one line of a file with mixed line endings
- **THEN** the line endings outside the edited range are unchanged

#### Scenario: Title added to a file without one
- **WHEN** the user sets a title on a file with no title keyword
- **THEN** a `#+title` line is added after the file's property drawer, or at the start of the file if it has no drawer, and all other bytes are unchanged

### Requirement: ID protection during editing
The system SHALL warn before saving an edit that would remove or change an existing node ID, or create an ID already in use. The user SHALL be able to return to editing. The system SHALL NOT add, regenerate, or repair IDs on its own.

#### Scenario: Heading ID removed
- **WHEN** the user's edit deletes a heading's `ID` line and the user saves
- **THEN** the system warns that the node will no longer exist, and saves only if the user confirms

#### Scenario: Editing a note without an ID
- **WHEN** the user edits and saves a file without an ID
- **THEN** no ID is added

### Requirement: Stale edit protection
The system SHALL NOT overwrite a file that changed after editing began, including changes made by a sync tool. It SHALL keep the user's text and let the user either reload the file or save their text as a conflict copy. A conflict copy SHALL be saved beside the note, and its name SHALL NOT end in `.org`, so neither Org-roam nor Roamlet treats it as a note and it cannot introduce duplicate IDs.

#### Scenario: External change during editing
- **WHEN** a file changes while it is being edited and the user saves
- **THEN** the changed file is not overwritten, the user's text is retained, and both choices are offered

#### Scenario: Saving a conflict copy
- **WHEN** the user chooses to save their text as a conflict copy of `note.org`
- **THEN** a file such as `note.org.conflict-20260115093000` is created beside it, `note.org` is unchanged, and the copy is listed in diagnostics

### Requirement: Draft preservation
The system SHALL preserve unsaved capture and edit text across backgrounding and app termination, and SHALL require confirmation before discarding it.

#### Scenario: App terminated during capture
- **WHEN** the app is terminated with unsaved capture text and later reopened
- **THEN** the text is restored in Capture

#### Scenario: Discarding an edit
- **WHEN** the user leaves an editor with unsaved changes
- **THEN** the system asks for confirmation before discarding them

### Requirement: Link insertion
The system SHALL let the user search existing notes while capturing or editing and insert a link at the cursor as `[[id:UUID][Title]]`. Only nodes SHALL be offered as targets. Square brackets in the title SHALL NOT produce a malformed link.

#### Scenario: Insert a link
- **WHEN** the user searches for a note and selects it while editing
- **THEN** a valid ID link with that note's title as description is inserted at the cursor

#### Scenario: Link to a heading-level node
- **WHEN** the user selects a heading-level node
- **THEN** the inserted link uses that heading's ID

#### Scenario: Title containing brackets
- **WHEN** the selected note's title contains `[` or `]`
- **THEN** the inserted link is well formed and resolves correctly in both Roamlet and Org-roam

#### Scenario: Files without an ID
- **WHEN** a file without an ID matches the search
- **THEN** it is not offered as a link target
