import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { PageAutocomplete } from "./PageAutocomplete";
import { TagChips } from "./TagChips";

export function TagPicker({
  pageId,
  block,
  anchor,
  onClose,
}: {
  pageId: string;
  block: BlockSnapshot;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 24, top: 96, width: 340 });

  const reposition = useCallback(() => {
    const rect = anchor?.getBoundingClientRect();
    const width = Math.min(340, Math.max(280, window.innerWidth - 24));
    const left = Math.max(12, Math.min(rect?.left ?? 24, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min((rect?.bottom ?? 72) + 6, window.innerHeight - 260));
    setPosition({ left, top, width });
  }, [anchor]);

  useLayoutEffect(() => {
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [reposition]);

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
      <TagChips pageId={pageId} block={block} />
      {state.mode !== "readonly" && (
        <PageAutocomplete
          kind="tag"
          autoFocus
          placeholder={message("properties.addTag")}
          onPick={async (tagId) => {
            try {
              await session.execute({
                type: "add_tag",
                entity: { kind: "block", page_id: pageId, id: block.id },
                tag_id: tagId,
              });
            } catch (cause) {
              notify.failure(message("failure.addTag"), cause);
            }
          }}
        />
      )}
    </div>,
    document.body,
  );
}
