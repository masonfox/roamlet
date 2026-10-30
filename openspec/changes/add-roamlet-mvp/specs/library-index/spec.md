## Purpose

Defines the disposable local index of notes, metadata, and relationships: how it stays current with the files and how it is rebuilt without any possibility of data loss.

## ADDED Requirements

### Requirement: Index is derived and disposable
The system SHALL derive all indexed data from library files and SHALL store the index outside the library folder. Losing or deleting the index SHALL NOT lose user data, and index operations SHALL NOT modify library files. Any index data that disagrees with the files SHALL be corrected to match the files.

#### Scenario: Index missing
- **WHEN** the app launches and the index does not exist or is unreadable
- **THEN** the system rebuilds it from the files without user action

#### Scenario: Index format change
- **WHEN** an app update changes the index format
- **THEN** the system rebuilds the index from the files, and no user data is lost

#### Scenario: Files untouched by indexing
- **WHEN** indexing or rebuilding completes
- **THEN** every library file is byte-identical to its state before the operation, and no index data exists in the library folder

#### Scenario: Switching library
- **WHEN** the user switches the active library
- **THEN** the index reflects only the newly active library

### Requirement: Indexed content
The index SHALL record every `.org` file in the library, every node, each node's title, tags, level, and position, every recognized ID link, and searchable text.

#### Scenario: Note and relationship data
- **WHEN** a file containing a file-level node, a heading-level node, and ID links is indexed
- **THEN** both nodes and all links can be queried, including backlinks for each node

#### Scenario: File without nodes
- **WHEN** a file contains no nodes
- **THEN** the file is still indexed and searchable

#### Scenario: File not yet downloaded
- **WHEN** a listed file has never been on the device
- **THEN** it appears in the library by filename, its content isn't searchable yet, and it is counted in diagnostics

### Requirement: Change detection
The system SHALL detect files added, changed, or removed by sync tools or other apps, and SHALL refresh only the affected index entries. Detection SHALL run at launch, when the app returns to the foreground, after switching library, and on user request.

#### Scenario: File changed externally
- **WHEN** a sync tool or another app modifies a library file and the user returns to Roamlet
- **THEN** the index reflects the new content

#### Scenario: File removed externally
- **WHEN** a library file is deleted outside the app
- **THEN** its nodes and outgoing links leave the index, and links pointing to it become unresolved

#### Scenario: File renamed externally
- **WHEN** a library file is renamed or moved outside the app with its content unchanged
- **THEN** its node IDs remain the same, and links to it still resolve

#### Scenario: Timestamp changed without a content change
- **WHEN** a file's modification time changes but its bytes do not
- **THEN** the file's nodes and links are not reprocessed

### Requirement: Index survives loss of access
The system SHALL remove index entries only after a successful listing shows that the files are gone. A failed or partial listing SHALL NOT remove entries for anything it could not list.

#### Scenario: Folder access lost
- **WHEN** the library folder can't be listed
- **THEN** existing index entries are kept, and the app shows the reconnect state

#### Scenario: One subfolder fails
- **WHEN** one subfolder can't be listed during a refresh
- **THEN** entries under that subfolder are kept, and the other folders are refreshed

#### Scenario: Local copy removed by a provider
- **WHEN** a file is still listed but its local copy was removed by the provider
- **THEN** its index entries are kept

### Requirement: Full rebuild
The system SHALL let the user rebuild the entire index from the files. An interrupted rebuild SHALL complete on the next launch. The app SHALL remain usable and show progress during a rebuild.

#### Scenario: Requested rebuild
- **WHEN** the user runs Rebuild Index in Settings
- **THEN** the index is regenerated from every file on the device, and the folder tree, search, and backlinks match the files

#### Scenario: Rebuild equivalence
- **WHEN** an index built incrementally is compared to one built by a full rebuild of the same files
- **THEN** they contain the same notes, nodes, links, and searchable text

#### Scenario: Interrupted rebuild
- **WHEN** the app is terminated during a rebuild
- **THEN** the rebuild resumes on next launch and completes correctly

### Requirement: Data problem reporting
The system SHALL detect duplicate IDs, unresolved links, files without IDs, invalid UTF-8, files not yet downloaded, and files that could not be read. It SHALL report them without modifying any file and without blocking access to the rest of the library.

#### Scenario: Duplicate IDs
- **WHEN** two nodes share the same ID
- **THEN** both remain accessible, the duplicate is reported, IDs are left unchanged, and links to that ID resolve to the same node every time

#### Scenario: Sync conflict copy of a note
- **WHEN** a sync tool creates a conflict copy ending in `.org`, duplicating a note's IDs
- **THEN** both files stay accessible, the duplicate is reported, and neither file is changed

#### Scenario: Unreadable file
- **WHEN** a file cannot be read during indexing
- **THEN** the file is reported, and all other files are indexed
