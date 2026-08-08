// First-class TagId references rendered as chips. Tag membership is structural
// node data and never appears in the generic property bag.
//
// The chip is bare text now — no fill, no reserved remove slot. The whole chip
// is one button whose only verb is removal, and it says so in place: hovering
// or focusing it swaps the leading `#` for an `×` in the same glyph slot, so
// nothing shifts and nothing waits in reserved space. A deleted target is
// struck through AND says so in its accessible name; v1 carried that state
// only in a `title`, so assistive technology heard "#Foo" and never learned
// the page was gone.

import { XIcon } from "lucide-react";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { findTag } from "../../core-port/snapshot";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

export function TagChips({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
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
              aria-label={missing ? message("properties.deleted", { name: `#${label}` }) : undefined}
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
            aria-label={
              missing
                ? message("properties.deleted", { name: `#${label}` })
                : message("properties.removeTag", { name: label })
            }
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
