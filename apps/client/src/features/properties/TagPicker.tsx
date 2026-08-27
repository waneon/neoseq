import { useRef } from "react";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import type { Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { PageAutocomplete } from "./PageAutocomplete";
import { TagChips } from "./TagChips";

export function TagPicker({
  owner,
  block,
  anchor,
  onClose,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
  anchor: Anchor;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.mode === right.mode,
  );
  const notify = useNotify();
  const { message } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);

  return (
    <AnchoredPanel
      anchor={anchor}
      label={message("outline.tags")}
      className="tag-picker"
      options={{ width: 340, minWidth: 280, maxHeight: 320 }}
      surfaceRef={panelRef}
      dismissOnExternalScroll
      trapFocus
      initialFocus={() => panelRef.current?.querySelector<HTMLElement>('[data-testid="tag-autocomplete"]') ?? null}
      testId="tag-picker"
      onClose={onClose}
    >
      <strong>{message("outline.tags")}</strong>
      <TagChips owner={owner} block={block} />
      {state.mode !== "readonly" && (
        <PageAutocomplete
          kind="tag"
          autoFocus
          placeholder={message("properties.addTag")}
          onPick={async (tagId) => {
            try {
              await session.execute({
                type: "add_tag",
                entity: { kind: "block", owner, id: block.id },
                tag_id: tagId,
              });
            } catch (cause) {
              notify.failure(message("failure.addTag"), cause);
            }
          }}
        />
      )}
    </AnchoredPanel>
  );
}
