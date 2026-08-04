// Inline block panel: tag chips with page autocomplete plus the generic property
// editor over the same bag. Adding a tag routes through AddTag so the target
// page's defaults materialize onto the block in one transaction.
//
// One panel, not three nested frames. v1 was a bordered card containing a
// hairline-ruled section containing a bordered add box, headed by two 12px
// uppercase pseudo-headings — so the panel had no evident subject. It also has no
// entrance animation: it is read the instant it opens, including by the automated
// contrast audit, and a container fading in composites its text at partial alpha.

import { useEffect, useRef } from "react";
import { XIcon } from "lucide-react";
import type { BlockSnapshot } from "../../core-port/snapshot";
import { useSession, useSessionState } from "../shell/session-context";
import { PageAutocomplete } from "./PageAutocomplete";
import { PropertyBagEditor } from "./PropertyBagEditor";
import { TagChips } from "./TagChips";

export function BlockInspector({
  block,
  onClose,
}: {
  block: BlockSnapshot;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const readonly = state.mode === "readonly";
  const panel = useRef<HTMLDivElement>(null);

  // Escape closes the panel. v1 offered only the close button.
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      onClose();
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="inspector" ref={panel} data-testid="block-inspector">
      <header>
        <h2>Block</h2>
        <button className="icon-btn" aria-label="Close block properties" onClick={onClose}>
          <XIcon aria-hidden />
        </button>
      </header>
      <div className="inspector-tags">
        <TagChips block={block} />
        {!readonly && (
          <div className="inspector-tag-input">
            <PageAutocomplete
              placeholder="Add tag…"
              allowCreate
              onPick={(pageId) =>
                void session
                  .execute({ type: "add_tag", block_id: block.id, page_id: pageId })
                  .catch(() => undefined)
              }
            />
          </div>
        )}
      </div>
      <PropertyBagEditor
        kind="block"
        targetId={block.id}
        bag={block.properties}
        title="Properties"
      />
    </div>
  );
}
