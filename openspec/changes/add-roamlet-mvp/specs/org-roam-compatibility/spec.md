## Purpose

Defines the hard end-to-end contract that notes opened, created, edited, or exported by Roamlet stay valid in Emacs Org-roam, with IDs, links, and content intact.

## ADDED Requirements

### Requirement: Unchanged files stay byte-identical
Opening a folder, indexing, browsing, and reading SHALL NOT write to any file in the library. A file the user has not edited SHALL remain byte-identical.

#### Scenario: Opening a folder without edits
- **WHEN** an existing Org-roam folder is opened, indexed, rebuilt, and browsed with no edits
- **THEN** every file in the folder is byte-identical, its modification time is unchanged, and no files have been added

#### Scenario: Export without edits
- **WHEN** a library is exported with no edits
- **THEN** every exported `.org` file is byte-identical to the library file

### Requirement: Stable identity
The system SHALL NOT change any node ID or filename unless the user directly changes that text or explicitly requests a rename.

#### Scenario: IDs after indexing and rebuild
- **WHEN** a library is opened, indexed, and rebuilt
- **THEN** all IDs and filenames are unchanged

#### Scenario: IDs after editing
- **WHEN** the user edits the title or body text of a note, leaving its ID lines untouched
- **THEN** all IDs in the file and the filename are unchanged

### Requirement: Files are valid in Org-roam
Files created or edited by the system SHALL be recognized by Emacs Org-roam without conversion, and Org-roam SHALL find the same nodes and ID links that the system reports for them.

#### Scenario: New note in Org-roam
- **WHEN** a note created by Roamlet reaches the Org-roam directory and the database is synced
- **THEN** Org-roam lists the node with the same ID and title

#### Scenario: Round trip through a sync tool
- **WHEN** a note is edited in Roamlet on a chosen folder, and the user's sync tool carries it to the Emacs machine
- **THEN** Org-roam finds its IDs, links, and content intact, and a later edit made in Emacs appears in Roamlet after it syncs back

#### Scenario: Edited note in Org-roam
- **WHEN** an edited note with heading-level nodes and ID links is synced by Org-roam
- **THEN** all of its nodes and links are present, and its unedited text is unchanged

#### Scenario: Inserted link in Org-roam
- **WHEN** a link inserted by Roamlet is synced by Org-roam
- **THEN** Org-roam reports the backlink on the target node

### Requirement: Heading-level nodes survive file edits
Editing a file SHALL NOT remove, reorder, or alter heading-level nodes outside the user's edited text.

#### Scenario: Editing text above a heading node
- **WHEN** the user edits the file's opening paragraph and saves
- **THEN** every heading-level node keeps its ID, drawer, title, and content

### Requirement: Automated conformance
The project SHALL verify compatibility automatically against real Emacs Org-roam using realistic fixtures, covering headings, property drawers, source blocks, links, metadata, CRLF, Unicode, malformed files, duplicate IDs, sync-conflict copies, and broken links. Any known difference from Org-roam's node and link results SHALL be listed and justified.

#### Scenario: Conformance run
- **WHEN** the conformance suite runs in continuous integration
- **THEN** Roamlet's nodes and links match Org-roam's results for all fixtures, except for listed differences, and any other mismatch fails the build

#### Scenario: Round-trip fixtures
- **WHEN** scripted edits are applied to each fixture
- **THEN** all bytes outside each edited range are unchanged, and the fixture still syncs in Org-roam
