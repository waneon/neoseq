// Repeated `tag` properties rendered as page-reference chips. The data stays an
// ordinary property: the generic inspector shows and edits the same entries.
//
// The chip is borderless now — a soft fill plus a hairline plus a pill radius was
// three separators for one small label. A deleted target is struck through AND
// says so in its accessible name; v1 carried that state only in a `title`, so
// assistive technology heard "#Foo" and never learned the page was gone.

import { useNavigate, useParams } from "react-router";
import { XIcon } from "lucide-react";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle, repeatedValues } from "../../core-port/snapshot";
import { useSession, useSessionState } from "../shell/session-context";

export function TagChips({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const navigate = useNavigate();
  const { graphId } = useParams();
  const tags = repeatedValues(block.properties, "tag");

  return (
    <>
      {tags.map((value) => {
        if (value.type !== "page") return null;
        const page = findPage(state.snapshot, value.value);
        const missing = !page || isDeleted(page);
        const label = page ? pageTitle(page) : value.value;
        return (
          <span className="chip" data-tombstone={missing} key={value.value} data-testid="tag-chip">
            <button
              className="chip-link"
              aria-label={missing ? `#${label} (deleted page)` : `Open ${label}`}
              onClick={() => navigate(`/g/${graphId}/p/${value.value}`)}
            >
              <span className="hash" aria-hidden>
                #
              </span>
              {label}
            </button>
            {state.mode !== "readonly" && (
              <button
                className="chip-remove"
                aria-label={`Remove tag ${label}`}
                onClick={() =>
                  void session
                    .execute({
                      type: "remove_repeated_property",
                      entity: { kind: "block", page_id: pageId, id: block.id },
                      key: "tag",
                      value,
                    })
                    .catch(() => undefined)
                }
              >
                <XIcon className="size-3" aria-hidden />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}
