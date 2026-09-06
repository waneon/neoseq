// Tag names navigate; adjacent remove controls edit membership.

import { XIcon } from "lucide-react";
import { Link, useParams } from "react-router";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { findTag } from "../../core-port/snapshot";
import { tagColor, tagIcon } from "../../entities/tag-identity";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { graphPath } from "../graphs/routing";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";

export function TagChips({
  owner,
  block,
  variant = "edit",
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  /**
   * `edit` — the picker's own list: the chip removes the tag.
   * `reference` — a name in the writing with a separate remove control.
   */
  variant?: "edit" | "reference";
}) {
  const { repositoryId = LOCAL_REPOSITORY_ID, graphId = "" } = useParams();
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
  const notify = useNotify();
  const { message } = useI18n();
  return (
    <>
      {block.tags.map((tagId) => {
        const tag = findTag(state.snapshot, tagId);
        const missing = !tag;
        const label = tag?.name ?? tagId;
        const deleted = message("properties.deleted", { name: `#${label}` });
        const remove = () =>
          void session
            .execute({
              type: "remove_tag",
              entity: { kind: "block", owner, id: block.id },
              tag_id: tagId,
            })
            .catch((error: unknown) => {
              notify.failure(message("failure.removeTag", { name: label }), error);
            });
        if (variant === "reference") {
          const icon = tag ? tagIcon(tag) : null;
          const name = (
            <>
              {icon ? (
                <span className="chip-icon" aria-hidden>
                  {icon}
                </span>
              ) : (
                <span className="hash" aria-hidden>
                  #
                </span>
              )}
              {label}
            </>
          );
          return (
            <span className="tag-chip-reference" key={tagId}>
              {missing ? (
                <span
                  className="chip"
                  data-variant="reference"
                  data-tombstone
                  data-testid="tag-chip"
                  aria-label={deleted}
                >
                  {name}
                </span>
              ) : (
                <Link
                  className="chip"
                  data-variant="reference"
                  data-hue={tagColor(tag) ?? undefined}
                  to={graphPath(repositoryId, graphId, `t/${tagId}`)}
                  data-testid="tag-chip"
                  aria-label={message("properties.openTag", { name: label })}
                >
                  {name}
                </Link>
              )}
              {state.mode !== "readonly" && (
                <button
                  type="button"
                  className="tag-chip-remove"
                  aria-label={message("properties.removeTag", { name: label })}
                  onClick={(event) => {
                    event.stopPropagation();
                    remove();
                  }}
                >
                  <XIcon aria-hidden />
                </button>
              )}
            </span>
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
            onClick={remove}
          >
            {glyph}
            {label}
          </button>
        );
      })}
    </>
  );
}
