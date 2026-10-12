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
block, holding the full source. The textarea covers the text column of a
highlighted copy with identical metrics and wrapping, and extends one line
beyond each end so the fence lines fall outside the surface's clip. Selection
is kept between the fences, so drafts, IME, history, remote mapping, and Vim
keep their existing paths and offsets.

Inside the code, Enter keeps the line's indentation and deepens it after an
opening bracket or a line-ending colon, splitting a bracket pair around the new
line. A closer typed on a blank line returns to the opener's indentation, and
Backspace in space indentation removes back to the previous stop. Tab and
Shift+Tab indent by the code's own unit, ⌘A selects the code before the block,
and the first and last lines step to neighbouring blocks. Shift+Enter leaves for
a new block, and Backspace in an empty code block unwraps it. Brackets and quotes
pair as in prose, except that a quote typed after its twin opens no pair, so a
typed fence or triple quote arrives whole. Completions are off. A typed line that
would close the fence lengthens both fences instead, so the block stays code.

`/code` turns the block's text into a code block and opens its language search;
the block menu also opens it and switches the block to its Markdown source, a
session state that ends when the caret leaves the block. A searched name outside
the list can be written as typed.

## Rendering

`CodeView` draws the language, line numbers, and tokens for both editing and
reading; fenced code inside a Markdown projection uses it as well. Each line is
a grid row beside its number, so long lines wrap and keep their number on their
first row. Shiki's JavaScript engine tokenizes with a CSS-variable theme whose
roles the foundation realizes per mode, without weight or slant so glyph
advances match the textarea. Grammars are a curated list in
`features/code/languages`, each a lazy chunk that the service worker precaches;
other languages render as plain text.
