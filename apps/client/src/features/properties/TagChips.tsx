// Repeated `tag` properties rendered as page-reference chips. The data
// stays an ordinary property: the generic inspector shows and edits the
// same entries.

import { useNavigate, useParams } from "react-router";
import { XIcon } from "lucide-react";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle, repeatedValues } from "../../core-port/snapshot";
import { useSession, useSessionState } from "../shell/session-context";

export function TagChips({ block }: { block: BlockSnapshot }) {
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
          <span
            className="chip animate-in fade-in-0 zoom-in-95 duration-150"
            data-tombstone={missing}
            key={value.value}
            data-testid="tag-chip"
          >
            <button
              className="chip-link"
              title={missing ? "This page was deleted" : `Open ${label}`}
              onClick={() => navigate(`/g/${graphId}/p/${value.value}`)}
            >
              #{label}
            </button>
            {state.mode !== "readonly" && (
              <button
                className="chip-remove"
                aria-label={`Remove tag ${label}`}
                onClick={() =>
                  void session
                    .execute({
                      type: "remove_repeated_property",
                      entity: { kind: "block", id: block.id },
                      key: "tag",
                      value,
                    })
                    .catch(() => undefined)
                }
              >
                <XIcon className="size-3" />
              </button>
            )}
          </span>
        );
      })}
    </>
  );
}
