// Inline block panel: first-class tag chips plus the generic property editor.
// Adding a tag materializes that tag's defaults onto the block transactionally.
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
  pageId,
  block,
  onClose,
}: {
  pageId: string;
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
        <TagChips pageId={pageId} block={block} />
        {!readonly && (
          <div className="inspector-tag-input">
            <PageAutocomplete
              kind="tag"
              placeholder="Add tag…"
              allowCreate
              onPick={(tagId) =>
                void session
                  .execute({
                    type: "add_tag",
                    entity: { kind: "block", page_id: pageId, id: block.id },
                    tag_id: tagId,
                  })
                  .catch(() => undefined)
              }
            />
          </div>
        )}
      </div>
      <PropertyBagEditor
        kind="block"
        pageId={pageId}
        targetId={block.id}
        bag={block.properties}
        title="Properties"
      />
    </div>
  );
}
