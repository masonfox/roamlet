## Purpose

Defines how users find, read, and move between notes, including the folder view, search, backlinks, and how broken links are presented.

## ADDED Requirements

### Requirement: Folder tree
The Notes destination SHALL present the library as a tree mirroring its real folders and `.org` files. Each file SHALL show its title and enough of its filename to tell it apart. Folders SHALL open in place within the tree. Files without nodes SHALL be marked as having no ID, and files not on the device SHALL be marked as not downloaded. Hidden folders and folders with no notes SHALL NOT be shown.

#### Scenario: Browsing folders
- **WHEN** the library contains `daily/2026-01-02.org` and `20260101-idea.org`
- **THEN** the root shows a `daily` folder and the `idea` note, and opening `daily` shows its note

#### Scenario: Matching the real folder
- **WHEN** a file is added or moved outside the app and the user returns to Roamlet
- **THEN** the tree shows the file at its new location

#### Scenario: Mixed library
- **WHEN** the library has notes with IDs, a file with no ID, and a file not yet downloaded
- **THEN** all appear in the tree, with the no-ID and not-downloaded files visibly marked

#### Scenario: Empty library
- **WHEN** the library has no notes
- **THEN** the view explains how to capture a note or open an existing folder

#### Scenario: Library unavailable
- **WHEN** access to the library folder has been lost
- **THEN** the view shows the reconnect option, and indexed notes stay searchable with a notice that files can't be opened until access returns

### Requirement: Search
The system SHALL search titles and body text across the whole library from the Notes destination, without a network connection, returning matches as the user types with title matches ranked above body-only matches. Results SHALL include file-level and heading-level nodes, and files without nodes. Search SHALL handle diacritics and SHALL find text in scripts that do not separate words with spaces. Search SHALL NOT match metadata such as raw IDs.

#### Scenario: Title and body matches
- **WHEN** the user searches for a word present in one note's title and another note's body
- **THEN** both appear, with the title match first

#### Scenario: Heading-level node in results
- **WHEN** a search matches a heading-level node's title
- **THEN** the result is marked as a heading and shows which file it is in

#### Scenario: Search while offline
- **WHEN** the device has no network connection
- **THEN** search works normally over indexed content

#### Scenario: Diacritics
- **WHEN** the user searches for `cafe` and a note contains `café`
- **THEN** the note is found

#### Scenario: CJK text
- **WHEN** the user searches for `日本語` and a note contains that text
- **THEN** the note is found

#### Scenario: No results
- **WHEN** a search has no matches
- **THEN** the system shows a clear empty state

### Requirement: Reading view
The system SHALL display notes in a readable, mobile-friendly view with headings, paragraphs, lists, emphasis, links, source blocks, and tables. Metadata such as property drawers SHALL be hidden by default. Unsupported syntax SHALL be displayed as literal text and SHALL NOT be dropped. The view SHALL read the current file from the library rather than from the index.

#### Scenario: Supported constructs
- **WHEN** a note with headings, lists, a source block, and a table is opened
- **THEN** each is displayed legibly on a phone screen, and wide content can be viewed without breaking the layout

#### Scenario: Unsupported construct
- **WHEN** a note contains syntax the reader does not support, such as a LaTeX environment or dynamic block
- **THEN** its source text is displayed literally

#### Scenario: Opening a heading-level node
- **WHEN** the user opens a heading-level node from search, a link, or a backlink
- **THEN** its file opens positioned at that heading

#### Scenario: Note not available
- **WHEN** the user opens a note whose file isn't on the device and can't be downloaded
- **THEN** the app explains why it can't be opened, and its backlinks and outgoing links remain viewable where known

### Requirement: Link navigation
The system SHALL navigate to the target note when the user taps a resolved ID link, and SHALL let the user return to the previous note. Links without a description SHALL display the target's title. Web links SHALL open outside the app, and other link types SHALL display without error.

#### Scenario: Following a link
- **WHEN** the user taps `[[id:UUID][description]]` and that node exists
- **THEN** the target note opens, and going back returns to the source note

#### Scenario: Link to a heading-level node
- **WHEN** the user taps a link to a heading-level node
- **THEN** the containing file opens positioned at that heading

#### Scenario: Link types that are not navigable
- **WHEN** a note contains `roam:` or `cite:` links, or other non-ID, non-web links
- **THEN** they are shown as text, and the note's source is unchanged

### Requirement: Backlinks and outgoing links
The system SHALL display, for the open note, the nodes that link to it and the links it contains. Each backlink SHALL open its source note.

#### Scenario: Viewing backlinks
- **WHEN** a note is linked from two other notes
- **THEN** both are listed as backlinks, and tapping one opens that note

#### Scenario: No backlinks
- **WHEN** nothing links to a note
- **THEN** the backlinks section indicates that there are none

### Requirement: Unresolved link handling
The system SHALL visibly distinguish ID links whose target is not in the library. Tapping one SHALL explain that the target is unavailable, without an error or navigation failure, and SHALL NOT alter the link.

#### Scenario: Tapping an unresolved link
- **WHEN** the user taps an ID link whose target does not exist in the library
- **THEN** the app shows that the note is not in this library and remains on the current note

#### Scenario: Target later appears
- **WHEN** a missing target note later syncs into the folder
- **THEN** the link resolves with no change to the linking file
