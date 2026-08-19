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
Loro Text -> BlockSnapshot.markdown -> GraphSession -> block presentation
                                                   |-> Markdown reading projection
                                                   `-> source textarea -> splice_markdown
```

The outline keeps one active source editor, identified by the existing focused
block ID. A block with Markdown syntax renders its reading projection while it is
inactive and switches to the existing textarea when its non-interactive content
is activated. Plain text may keep the textarea fast path because its reading
projection is identical. Pending blocks and IME composition always stay in the
source editor.

Drafting, debounce, Unicode splice generation, selection transformation, pending
row handoff, and remote reconciliation remain editor responsibilities. A failed
write retains the source draft. Rendering never creates an alternate mutation
path or an optimistic canonical value.

## Markdown Profile

The v1 profile is CommonMark with these product constraints:

- raw HTML and executable content are not interpreted;
- generated elements pass through an explicit sanitation allowlist;
- links allow only user-activated HTTP, HTTPS, mail, and local fragment targets;
- images render as inert alternative text and never issue network requests;
- headings are nested below the page title;
- Markdown syntax does not create properties, tags, tasks, pages, or backlinks.

The profile, rather than the parser dependency, is the product contract. GFM,
math, syntax highlighting, graph references, or other extensions require an
explicit profile change. Any extension that affects graph semantics also requires
a core/domain design rather than a renderer-only plugin.

## Presentation Consumers

The outline uses the full block projection and the typography and depth language
from `DESIGN.md`. Query content columns use the same parsing and security policy
with a compact phrasing-only projection. The compact shape prevents Markdown
links or block elements from being nested inside the query cell's edit/open
control.

Virtualized rows measure the rendered result like any other dynamic block.
Parsing occurs only for mounted reading projections and is memoized by the source
string. The active editor does not parse on each keystroke. A bounded client-only
cache may be added only after measurement shows that memoization and windowing are
insufficient.

## Verification

- profile tests cover CommonMark output, dangerous URLs, raw HTML, and inert images;
- outline tests cover reading-to-source activation, IME, draft retention, and
  authoritative reconciliation;
- query tests cover compact content and direct-field editing without nested
  interactive elements;
- browser tests cover dynamic row measurement, keyboard access, light/dark modes,
  and the absence of image requests.
