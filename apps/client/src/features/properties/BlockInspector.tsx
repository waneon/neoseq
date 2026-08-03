// Inline block panel: tag chips with page autocomplete plus the generic
// property editor over the same bag. Adding a tag routes through AddTag so
// the target page's defaults materialize onto the block in one transaction.

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

  return (
    <div
      className="card animate-in slide-in-from-top-1 duration-150"
      style={{ margin: "6px 0 12px", padding: "var(--space-md)" }}
      data-testid="block-inspector"
    >
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="eyebrow">Block properties</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="Close block properties" onClick={onClose}>
          <XIcon />
        </button>
      </header>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", marginTop: 8 }}
      >
        <TagChips block={block} />
        {!readonly && (
          <div style={{ minWidth: 220 }}>
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
        title="All properties"
        description="Every non-text feature of this block, in one uniform model."
      />
    </div>
  );
}
