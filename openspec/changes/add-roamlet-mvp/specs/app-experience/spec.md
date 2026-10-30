## Purpose

Defines the app's overall structure and behavior: its three destinations, settings and diagnostics, appearance, accessibility, and offline operation.

## ADDED Requirements

### Requirement: Primary destinations
The system SHALL provide Notes, Capture, and Settings as primary destinations, reachable from a persistent navigation control on iOS and Android.

#### Scenario: Switching destinations
- **WHEN** the user switches between Notes, Capture, and Settings
- **THEN** each destination opens immediately and keeps its state, including unsaved capture text and the current folder in Notes

### Requirement: Offline and private operation
All features SHALL work with no network connection and without an account for files on the device. Files a cloud provider hasn't stored on the device SHALL be shown as unavailable until they can be downloaded. The system SHALL NOT send note content or usage data anywhere itself: file transfer is left to the user's own sync tool or provider, and to files the user explicitly exports.

#### Scenario: Airplane mode with local files
- **WHEN** the device is in airplane mode and the library's files are on the device
- **THEN** browsing, search, reading, capture, editing, rebuild, and export all work

#### Scenario: Airplane mode with cloud-only files
- **WHEN** the device is in airplane mode and some files aren't on the device
- **THEN** those files are marked as unavailable, and everything else keeps working

### Requirement: Library management in Settings
Settings SHALL let the user choose, change, or reconnect the library folder, switch to the app-owned folder, export the library, and rebuild the index. It SHALL show which library is active, where it is, whether it can be written, its access state, and how much space its notes use.

#### Scenario: Choosing a folder from Settings
- **WHEN** the user chooses a folder from Settings
- **THEN** the system shows indexing progress, and the folder's notes then appear in Notes

#### Scenario: Picker failure
- **WHEN** the system folder picker cannot open or fails
- **THEN** the app shows a clear message, including any recovery step such as restarting the app, and the current library is unaffected

#### Scenario: Access state shown
- **WHEN** access to the active folder has been lost
- **THEN** Settings shows that state and offers to reconnect

### Requirement: Library statistics and diagnostics
Settings SHALL show counts of files, nodes, and links, the time of the last index refresh, and the problem categories reported by the index, plus conflict copies created by Roamlet. The user SHALL be able to see the files in each category.

#### Scenario: Viewing problems
- **WHEN** the library has duplicate IDs, unresolved links, files without IDs, or files not yet downloaded
- **THEN** Settings shows each count, and the user can see the affected files

#### Scenario: Healthy library
- **WHEN** no problems exist
- **THEN** diagnostics indicate that no problems were found

### Requirement: Appearance
The system SHALL follow the system light or dark appearance and SHALL update when it changes while the app is running. The interface SHALL be restrained and typography-focused, without extra themes or customization.

#### Scenario: Appearance change
- **WHEN** the system appearance changes while the app is open
- **THEN** the app updates without a restart, and text remains legible

### Requirement: Accessibility of reading and writing
Text SHALL respect the platform's font-size setting, and interactive elements SHALL expose labels to screen readers.

#### Scenario: Larger text
- **WHEN** the user increases the system font size
- **THEN** note text and navigation scale without clipped or overlapping content

#### Scenario: Screen reader
- **WHEN** a screen reader user navigates a note or the folder tree
- **THEN** links, folders, and primary actions are announced with meaningful labels
