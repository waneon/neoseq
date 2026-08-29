# Block Markdown Rendering Architecture

## Scope

Block Markdown is canonical collaborative text and remains unchanged in Loro,
snapshots, persistence, synchronization, and CorePort. Rendering is a disposable
client projection. Parsed trees and HTML are never stored or sent back through a
domain command.

This boundary covers block content in the outline and in query result views. Page
titles, tag names, property strings, and product messages remain plain text.

## Data and Interaction Flow

```text
Loro Text -> BlockSnapshot.markdown + reference spans -> GraphSession -> block presentation
                                                   |-> Markdown reading projection
                                                   `-> source textarea -> splice_block_content
```

The outline keeps one active source editor, identified by the existing focused
block ID. A block with Markdown syntax renders its reading projection while it is
inactive and switches to the existing textarea when its non-interactive content
is activated. Plain text may keep the textarea fast path because its reading
projection is identical. Pending blocks and IME composition always stay in the
source editor.

Deactivation is therefore the same fact as the outline releasing its focused block
ID, and the editor owns that decision because the row cannot make it: a `blur`
reports only that the textarea lost focus, never where focus went. The outline
answers on the next frame by asking where focus actually is, and treats two
destinations as _not_ leaving — elsewhere inside the same row, and any floating
overlay, both of which hand the caret straight back. Without this, focus leaving the
outline entirely left the block on its raw source until the next reload.

Activation carries a caret offset. The projection derives it from the pressed
point by walking the rendered text and the source together, so the boundary needs
no stored source positions and the parse stays disposable. The projection is also
the row's tab stop while it stands in for the textarea, and hands keyboard focus
over to it. The gestures the outline already owns — range selection, text
selection — are not intercepted: only a press that did not travel activates.

Drafting, debounce, Unicode splice generation, selection transformation, pending
row handoff, and remote reconciliation remain editor responsibilities. A failed
write retains the source draft. Rendering never creates an alternate mutation
path or an optimistic canonical value.

## Markdown Profile

The v1 profile is CommonMark, plus two presentation extensions, with these product
constraints:

- raw HTML and executable content are not interpreted;
- generated elements pass through an explicit sanitation allowlist;
- links allow only user-activated HTTP, HTTPS, mail, and local fragment targets;
- images render as inert alternative text and never issue network requests;
- headings are nested below the page title;
- Markdown syntax alone does not create properties, tags, tasks, pages, or
  backlinks. Explicit page-reference atoms project through `[[current title]]`.

The two extensions are **GFM** (tables, strikethrough, autolink literals, task
list items) and **soft breaks as line breaks**. Both are presentation-only: they
change how the same source is drawn and nothing about what it means. A block is a
line the author broke, so reflowing its newlines would make the reading disagree
with the editor above it. A GFM task list item renders as an inert checkbox — the
block's own task-status property remains the only representation of a task, and
the projection never writes one.

The profile, rather than the parser dependency, is the product contract. Math or
syntax highlighting requires an explicit profile change. Graph references
follow the separate core/domain contract in
[page references](page-references.md); the renderer never infers one from text.

The syntax detector that chooses between projection and fast path answers one
question: would parsing change what the reader sees? It is deliberately
conservative, because a false positive costs a mode switch, a caret to map back,
and a second layout to measure, and buys nothing. Block constructs are anchored
to the start of a line and inline delimiters must be paired, so a hyphen, an
identifier with underscores, or a bare newline stays prose.

## Presentation Consumers

The outline and query list use the full block projection and the typography and
depth language from [`../designs/foundations.md`](../designs/foundations.md).
Query table content uses the same parsing and security policy with a compact
phrasing-only projection. The compact shape prevents Markdown links or block
elements from being nested inside the table cell's edit/open control. These
choices are entries in the shared block-surface policy, not renderer forks.

Virtualized rows measure the rendered result like any other dynamic block.
Parsing occurs only for mounted reading projections and is memoized by the source
string. The active editor does not parse on each keystroke. A bounded client-only
cache may be added only after measurement shows that memoization and windowing are
insufficient.

## Verification

- profile tests cover CommonMark output, the extension set, dangerous URLs, raw
  HTML, inert images and checkboxes, and the detector's fast path;
- caret tests cover mapping a rendered offset back through headings, list
  markers, inline delimiters, and soft breaks;
- outline tests cover reading-to-source activation and its release when focus
  leaves the row, IME, draft retention, and authoritative reconciliation;
- query tests cover compact content and direct-field editing without nested
  interactive elements, block boxes, or a second line;
- browser tests cover the caret landing where the reader pressed, the source
  editor opening unclipped after a cold load, the projection's tab stop, drags
  staying the outline's, dynamic row measurement, light/dark modes, and the
  absence of image requests.
