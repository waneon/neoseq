import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { useAnchoredPosition, type Anchor } from "@/ui/anchored";
import { useOverlayRoot } from "@/ui/overlay-root";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
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
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(anchor, { width: 340, minWidth: 280, maxHeight: 320 });
  const overlayRoot = useOverlayRoot();

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (
        node instanceof Node &&
        !panelRef.current?.contains(node) &&
        !(node instanceof Element && node.closest(".ac-popover"))
      ) onClose();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", closeOnOutsidePress, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
    };
  }, [onClose]);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      className="tag-picker"
      style={position}
      role="dialog"
      aria-label={message("outline.tags")}
      data-testid="tag-picker"
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
    </div>,
    overlayRoot,
  );
}
