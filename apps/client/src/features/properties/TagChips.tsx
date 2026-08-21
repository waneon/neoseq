// First-class TagId references rendered as chips. Tag membership is structural
// node data and never appears in the generic property bag.
//
// The chip has two jobs, and it used to do both with the same control. Under a
// block a tag is a *reference* — a name the reader wrote and reads the graph by,
// which is why it is the one thing in the writing that carries the accent
// (DESIGN.md § Where the accent appears at rest). Inside the tag picker it is an
// *entry* in the set being edited, and there removal is the whole point.
//
// Making one button serve both meant a single click on a name in the outline
// silently detached it: the most link-shaped thing on the row was the one control
// whose verb was destructive, and the accent would have made that trap worse
// rather than better. So the reference chip routes to the picker — the product's
// one writing surface for tags — and the picker's chip keeps the `×` swap, where
// "remove" is what the reader came for and an undo is one keystroke away.
//
// A deleted target is struck through AND says so in its accessible name; v1
// carried that state only in a `title`, so assistive technology heard "#Foo" and
// never learned the page was gone.

import { XIcon } from "lucide-react";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { findTag } from "../../core-port/snapshot";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

export function TagChips({
  pageId,
  block,
  variant = "edit",
  onOpen,
}: {
  pageId: string;
  block: BlockSnapshot;
  /**
   * `edit` — the picker's own list: the chip removes the tag.
   * `reference` — a name in the writing: the chip opens the picker on it.
   */
  variant?: "edit" | "reference";
  /** Where a reference chip goes. Required for `reference`, ignored otherwise. */
  onOpen?: (anchor: HTMLElement) => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  return (
    <>
      {block.tags.map((tagId) => {
        const tag = findTag(state.snapshot, tagId);
        const missing = !tag;
        const label = tag?.name ?? tagId;
        const deleted = message("properties.deleted", { name: `#${label}` });
        if (variant === "reference") {
          return (
            <button
              type="button"
              className="chip"
              data-variant="reference"
              data-tombstone={missing}
              key={tagId}
              data-testid="tag-chip"
              aria-label={missing ? deleted : message("properties.openTag", { name: label })}
              onClick={(event) => onOpen?.(event.currentTarget)}
            >
              {/* No glyph swap here: the `#` is part of the name as the reader
                  typed it, and nothing about this control destroys anything. */}
              <span className="hash" aria-hidden>#</span>
              {label}
            </button>
          );
        }
        const glyph = (
          <span className="chip-glyph" aria-hidden>
            <span className="hash">#</span>
            <XIcon className="chip-x" />
          </span>
        );
        if (state.mode === "readonly") {
          return (
            <span
              className="chip"
              data-tombstone={missing}
              key={tagId}
              data-testid="tag-chip"
              aria-label={missing ? deleted : undefined}
            >
              {glyph}
              {label}
            </span>
          );
        }
        return (
          <button
            type="button"
            className="chip"
            data-tombstone={missing}
            key={tagId}
            data-testid="tag-chip"
            aria-label={missing ? deleted : message("properties.removeTag", { name: label })}
            onClick={() =>
              void session
                .execute({
                  type: "remove_tag",
                  entity: { kind: "block", page_id: pageId, id: block.id },
                  tag_id: tagId,
                })
                .catch((error: unknown) => {
                  // The chip stays put on failure, which on its own reads
                  // as a click that did not register.
                  notify.failure(message("failure.removeTag", { name: label }), error);
                })
            }
          >
            {glyph}
            {label}
          </button>
        );
      })}
    </>
  );
}
