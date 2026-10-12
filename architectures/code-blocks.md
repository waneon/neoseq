# Code Block Architecture

## Representation

A code block is a block whose whole Markdown source is one fenced code block.
The fence stays in canonical text: synchronization, history, search, copy, and
archives see ordinary Markdown, and the info string's first word is the only
place a language is written. `features/code/fence` recognizes the exact shape;
a block mixing prose and a fence, or whose fence a concurrent edit broke, is
ordinary Markdown and loses nothing. No domain or CRDT schema knows the concept.

## Editing

A code block is edited by the same native textarea and content session as any
block, holding the full source. The textarea is laid transparently over a
highlighted copy of the code with identical metrics, and starts one line above
the visible surface so the fence lines fall outside its clip. Selection is kept
between the fences, so drafts, IME, history, remote mapping, and Vim keep their
existing paths and offsets.

Inside the code, Enter breaks the line with its indentation, Tab and Shift+Tab
indent by the code's own unit, ⌘A selects the code before the block, and the
first and last lines step to neighbouring blocks. Shift+Enter leaves for a new
block, and Backspace in an empty code block unwraps it. Completions and
auto-pairing are off. A typed line that would close the fence lengthens both
fences instead, so the block stays code.

`/code` turns the block's text into a code block and opens its language list;
the block menu also opens that list and switches the block to its Markdown
source, a session state that ends when the caret leaves the block.

## Rendering

`CodeView` draws line numbers, tokens, and the language for both editing and
reading; fenced code inside a Markdown projection uses it as well. Lines do not
wrap; the code scrolls horizontally inside its block. Shiki's JavaScript engine
tokenizes with a CSS-variable theme whose roles the foundation realizes per
mode, without weight or slant so glyph advances match the textarea. Grammars
are a curated list in `features/code/languages`, each a lazy chunk that the
service worker precaches; other languages render as plain text.
