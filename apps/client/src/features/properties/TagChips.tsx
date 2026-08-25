// First-class TagId references rendered as chips. Tag membership is structural
// node data and never appears in the generic property bag.
//
// The chip has two jobs, and it may not do both with the same control. Under a
// block a tag is a *reference* — a name the reader wrote and reads the graph by,
// which is why it is the one thing in the writing that carries the accent
// (designs/foundations.md § Semantic Color). Inside the tag picker it is an
// *entry* in the set being edited, and there removal is the whole point.
//
// Making one button serve both meant a single click on a name in the outline
// silently detached it: the most link-shaped thing on the row was the one control
// whose verb was destructive. The reference now **goes to the tag** — the tag has
// a place of its own, and the one thing on a line that is shaped like a link
// leads there — while the picker that writes tags keeps its own pointer route on
// the bullet's menu, and the picker's chip keeps the `×` swap, where "remove" is
// what the reader came for and an undo is one keystroke away.
//
// A tag that has chosen a colour speaks in it. That is not a second structural
// chroma: a reference has always carried the accent, and this only lets each one
// name which hue of it — at the accent's own lightness and chroma, so every tag
// on offer lands on the measured row of the contrast table in both modes. A tag
// that has chosen nothing is the accent, exactly as before. Its mark is the same:
// the reader's emoji, or the `#` it has always worn.
//
// A deleted target is struck through AND says so in its accessible name; v1
// carried that state only in a `title`, so assistive technology heard "#Foo" and
// never learned the page was gone. It is also no longer a link: a tombstone
// leads nowhere, and it gives up its colour along with its destination.

import { XIcon } from "lucide-react";
import { Link, useParams } from "react-router";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { findTag } from "../../core-port/snapshot";
import { tagColor, tagIcon } from "../../entities/tag-identity";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

export function TagChips({
  owner,
  block,
  variant = "edit",
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  /**
   * `edit` — the picker's own list: the chip removes the tag.
   * `reference` — a name in the writing: the chip opens the tag.
   */
  variant?: "edit" | "reference";
}) {
  const { graphId = "" } = useParams();
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
          // No glyph swap on either shape: the mark is part of the name as the
          // reader reads it, and nothing about a reference destroys anything.
          const icon = tag ? tagIcon(tag) : null;
          const name = (
            <>
              {icon
                ? <span className="chip-icon" aria-hidden>{icon}</span>
                : <span className="hash" aria-hidden>#</span>}
              {label}
            </>
          );
          return missing ? (
            <span
              className="chip"
              data-variant="reference"
              data-tombstone
              key={tagId}
              data-testid="tag-chip"
              aria-label={deleted}
            >
              {name}
            </span>
          ) : (
            <Link
              className="chip"
              data-variant="reference"
              data-hue={(tag && tagColor(tag)) ?? undefined}
              key={tagId}
              to={`/g/${graphId}/t/${tagId}`}
              data-testid="tag-chip"
              aria-label={message("properties.openTag", { name: label })}
            >
              {name}
            </Link>
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
                  entity: { kind: "block", owner, id: block.id },
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
