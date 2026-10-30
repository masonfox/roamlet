## Purpose

Defines how Roamlet recognizes Org-roam nodes, metadata, and links in `.org` text, and how it tolerates input it does not fully understand.

## ADDED Requirements

### Requirement: File-level node recognition
The system SHALL treat a file as a file-level node when a property drawer containing a non-empty `ID` property appears before any content other than blank lines and comment lines. Drawer and keyword names SHALL be matched case-insensitively.

#### Scenario: Standard Org-roam file header
- **WHEN** a file starts with a property drawer containing `:ID: 6f1b9c1e-3a7d-4e0b-9a51-2c0f6a1d7e11`, followed by `#+title: Zettel`
- **THEN** the system recognizes one file-level node with that ID and the title `Zettel`

#### Scenario: Drawer after other content
- **WHEN** a property drawer with an `ID` appears after a paragraph, with no heading above it
- **THEN** the system does not treat the file as a file-level node

#### Scenario: Comments before the drawer
- **WHEN** only blank lines and comment lines appear before the property drawer
- **THEN** the system recognizes the file-level node

### Requirement: Heading-level node recognition
The system SHALL treat a heading as a heading-level node when its own property drawer contains a non-empty `ID` property. A heading without an `ID` SHALL NOT be a node. The heading title SHALL exclude stars, TODO keyword, priority cookie, and trailing tags.

#### Scenario: Heading with an ID
- **WHEN** a file contains `* TODO [#A] Heading node :tag1:` with a property drawer holding an `ID`
- **THEN** the system recognizes a heading-level node titled `Heading node` with its level and source position

#### Scenario: Heading without an ID
- **WHEN** a heading has no `ID` property
- **THEN** the system does not create a node, and its text belongs to the nearest enclosing node, if any

#### Scenario: File with heading nodes but no file-level ID
- **WHEN** a file has no file-level `ID` but contains headings with `ID` properties
- **THEN** the system recognizes each such heading as a node

### Requirement: Node exclusion
The system SHALL NOT treat an entry as a node when the entry has a non-nil `ROAM_EXCLUDE` property.

#### Scenario: Excluded heading
- **WHEN** a heading has both an `ID` and `:ROAM_EXCLUDE: t`
- **THEN** the system does not list it as a node, and its source text remains unchanged

### Requirement: File metadata extraction
The system SHALL extract the title from the first `#+title` keyword and tags from `#+filetags`. When no title keyword exists, the title SHALL fall back to the filename without its extension.

#### Scenario: Keyword case and tag format
- **WHEN** a file contains `#+FILETAGS: :a:b:` and `#+TITLE: Example`
- **THEN** the tags are `a` and `b`, and the title is `Example`

#### Scenario: Missing title
- **WHEN** a file `20260101120000-foo.org` has no title keyword
- **THEN** the title is `20260101120000-foo`

### Requirement: ID link recognition
The system SHALL recognize `[[id:TARGET]]` and `[[id:TARGET][description]]` as links from the nearest enclosing node to `TARGET`. It SHALL NOT recognize links inside source blocks, example blocks, comment lines, fixed-width lines, or inline verbatim and code markup.

#### Scenario: Link with a description
- **WHEN** a body contains `[[id:1111][a link]]`
- **THEN** the system records a link to `1111` with the description `a link` and its source position

#### Scenario: Link inside a source block
- **WHEN** a terminated source block contains the text `[[id:1111]]`
- **THEN** the system records no link

#### Scenario: Link inside inline verbatim markup
- **WHEN** a paragraph contains `=[[id:1111]]=`
- **THEN** the system records no link

#### Scenario: Link outside any node
- **WHEN** a link appears in a file's text with no enclosing node
- **THEN** the system does not record it as a backlink source

### Requirement: Org block and heading precedence
The system SHALL follow Org's rule that a line beginning with stars and a space is a heading, even inside a block. A block without a matching end line before the next heading SHALL be treated as ordinary text. Comma-escaped lines inside blocks SHALL NOT be treated as headings.

#### Scenario: Comma-escaped heading in a source block
- **WHEN** a source block contains the line `,* not a heading`
- **THEN** the system does not recognize a heading, and the block remains intact

#### Scenario: Unterminated block
- **WHEN** a `#+begin_src` line has no matching end line before the next heading
- **THEN** the lines following it are treated as ordinary text, including any links they contain

### Requirement: Tolerant parsing
Parsing SHALL complete without error for any text input. Unrecognized or malformed syntax SHALL be treated as text and SHALL NOT prevent the rest of the file from being recognized.

#### Scenario: Malformed drawer
- **WHEN** a file contains a `:PROPERTIES:` line with no matching `:END:`
- **THEN** parsing completes, no ID is taken from that drawer, and later valid headings are still recognized

#### Scenario: Line endings
- **WHEN** the same content is parsed with LF line endings and with CRLF line endings
- **THEN** the system recognizes the same nodes, metadata, and links in both cases
