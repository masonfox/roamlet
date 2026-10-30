# Org fixture corpus

Hand-written `.org` files for the scanner tests (`test/core/org-fixtures.test.ts`) and, later, the Emacs conformance job (design.md, Decision 8). Every fixture must be listed here; a test enforces it.

`.gitattributes` marks this directory `-text`, so line endings and BOMs survive checkout unchanged on every platform. A test checks that the line-ending fixtures really hold what they claim.

IDs have the form `00000000-0000-4000-8000-0000000000NN` and are unique across the corpus, except in the fixtures that are about duplicates.

Org treats a line starting with stars and a space as a heading even inside a block, and `,*` is the escape (design.md, Decision 1). Escape such lines in block content unless the fixture is about exactly this. The only deliberate unescaped case is in `unterminated-block.org`.

| Fixture | Covers |
|---|---|
| `headings.org` | Levels, TODO, priority, tags, tag inheritance, COMMENT, planning line, non-heading star lines |
| `todo-keywords.org` | Keywords declared through `#+TODO`, `#+SEQ_TODO`, `#+TYP_TODO`, with fast keys and `\|`; undeclared and lowercase words stay in the title |
| `property-drawers.org` | Case-insensitive drawers, planning before a drawer, a blank line before a drawer, a drawer after text, empty `ID`, custom drawer with a link |
| `source-blocks.org` | Links inside src, uppercase src, example, comment, export, and indented blocks are ignored; a link in a quote block counts |
| `comma-escapes.org` | `,*`, `,**`, `,#+`, and `,,*` inside a src block are not headings or block ends |
| `links.org` | Description, no description, emphasis, multi-line description, plain and angle forms, other link types, verbatim, code, comment, fixed-width, keyword, property, `ROAM_REFS`, `#+transclude`, heading title, attribution |
| `links-no-file-node.org` | Links with no enclosing node, and a link inside a heading node in the same file |
| `metadata.org` | Keyword casing, value spacing, first title wins, tags from several `#+filetags`, no node |
| `20260101120000-foo.org` | No title keyword: the title falls back to the file name |
| `comments-before-drawer.org` | Blank and comment lines before the file drawer |
| `drawer-after-content.org` | A drawer after a paragraph is not file-level |
| `keyword-before-drawer.org` | A drawer after a keyword is not file-level |
| `heading-nodes-no-file-id.org` | Heading nodes in a file with no file-level node |
| `excluded.org` | `ROAM_EXCLUDE` on a heading, ownership falling through it, a child with its own ID, a `nil` value |
| `excluded-file.org` | `ROAM_EXCLUDE` in the file drawer, with a heading node inside |
| `exclude-values.org` | Whether descendants inherit `ROAM_EXCLUDE`, and empty, `false`, and lowercase-name forms |
| `link-contexts.org` | Plain and angle `id:` links in drawers, keywords, lists, tables, quotes, captions, and titles; a heading with every title part |
| `multiple-titles.org` | Two `#+title` and two `#+filetags` lines in a file-level node |
| `line-endings-lf.org` | Baseline for the line-ending group |
| `line-endings-crlf.org` | The same content with CRLF on every line |
| `line-endings-mixed.org` | The same content with alternating CRLF and LF |
| `bom.org` | Leading BOM with LF |
| `bom-crlf.org` | Leading BOM with CRLF |
| `unicode.org` | CJK, emoji with joiners, combining marks, right-to-left text, Unicode tags |
| `malformed-drawers.org` | Unterminated file and heading drawers, a stray line inside a drawer, a stray `:END:`, and a valid heading after them |
| `unterminated-block.org` | Blocks ended by a heading or the end of the file, and the deliberate unescaped star line |
| `duplicate-ids-a.org` | The same ID twice in one file, and a file ID shared with `duplicate-ids-b.org` |
| `duplicate-ids-b.org` | The other holder of the shared file ID |
| `note.org` | The original of a sync conflict |
| `note.sync-conflict-20260115-093000-ABCDEFG.org` | Syncthing's conflict copy of `note.org`, with the same IDs |
| `note (Laptop's conflicted copy 2026-01-15).org` | Dropbox's conflict copy of `note.org`, with the same IDs |
| `broken-links.org` | Missing target, empty target, and unclosed and empty-description bracket links, which currently leave a plain `id:` link behind (a best guess for task 3.4) |
