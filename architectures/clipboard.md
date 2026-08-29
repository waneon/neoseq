# Outline Clipboard Architecture

## Contract

An outline copy has one versioned semantic source, `neoseq.outline` v2. The
fragment is a bounded, pre-order list of projected Markdown blocks with semantic
page-reference spans, portable property fields, and tag references, plus tag
and page-reference descriptors. It is a
domain DTO, never a Loro snapshot or update. Copying creates new block identity;
core-managed lifecycle fields are regenerated. Readers accept v2 exactly.

The browser derives the fragment synchronously from an authoritative hydrated
outline snapshot so the native `copy` event can be completed without waiting for a
Worker round trip. The core treats every fragment as untrusted input and owns
shape validation, reference resolution, CRDT encoding, and mutation.

## Clipboard Representations

One fragment projects to three representations:

- `application/vnd.neoseq.outline+json` for lossless Neoseq paste;
- `text/html` as a nested readable list with visible tag and property metadata;
- `text/plain` as a portable Markdown list with readable metadata lines.

The HTML root also carries the versioned fragment as a best-effort round-trip
fallback when a browser does not preserve custom formats. External applications
may consume either standard representation without understanding Neoseq.

One clipboard decoder owns representation precedence. Paste prefers the custom
fragment, then its HTML round-trip hint, a standard semantic HTML list, and an
unambiguous plain-text list in that order. Ordinary multiline text remains an
in-field text paste. An HTML fragment containing a list is decoded as one flow:
prose before, between, or after lists becomes root blocks in source order, while
`ul`, `ol`, and `li` alone establish depth. Application wrappers and attributes
do not affect the result, and prose is never inferred to own an adjacent list.

The standard codecs obey structural invariants. Each block emits exactly one
`li`; a nested list exists if and only if the block has children; empty list
containers are forbidden. Decoding any recognized representation produces
either a rich fragment or the same bounded pre-order `{ depth, markdown }`
shape accepted by `insert_outline`. Format selection does not live in an editor
surface.

## Paste Semantics

`paste_outline` is one domain command, Loro transaction, undo item, durable
update, and semantic event. It creates new blocks and writes their portable
fields and tag references without re-materializing target tag defaults.

Within the source graph, live page and tag IDs resolve directly. Across graphs,
tags resolve by normalized name, journals by local date, and regular pages by
normalized title; missing referenced entities are created in the same
transaction with target-local IDs. Core validation rejects unsupported fragment
versions, excessive payloads, invalid properties, missing descriptors, and
skipped hierarchy depths before mutation.

An existing destination block is reused only when it has empty Markdown, no
children or tags, and no portable property fields. Its identity and created time
remain stable; its updated time advances with the paste.

## Property Policy

The property registry declares `portable`, `regenerate`, or `omit` for each
known field. User properties default to portable and unknown built-ins default
to omit. Unsupported document values are not projected by an older client;
current schema-owned documents use their structured snapshot and are rebuilt by
the core into their mergeable storage layout.
