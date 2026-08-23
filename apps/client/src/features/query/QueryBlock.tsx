// A query, embedded in the outline.
//
// The block is the smaller of the query surface's two grounds: it is a paragraph
// that answers itself, so it states one caption and its result and keeps
// everything else behind the sentence and the two revealed menus. Its views stay
// in a menu rather than becoming a tab strip — a row of tabs inside a line of
// writing is a second interface growing out of a bullet.
//
// Everything the surface does lives in `QueryPanel`; this is the block's half of
// the contract: where the document is written, and the one verb a block's query
// has that a tag's does not — removing it.

import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { outlineOwnerKey } from "../../core-port/snapshot";
import { queryDocument } from "../../core-port/snapshot";
import { useNotify } from "../notify/context";
import { useSession } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { QueryPanel } from "./QueryPanel";

export function QueryBlock({ owner: outlineOwner, block }: { owner: OutlineOwner; block: BlockSnapshot }) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const document = queryDocument(block.properties);
  const owner = { kind: "block", owner: outlineOwner, id: block.id } as const;

  if (!document) return null;

  return (
    <QueryPanel
      owner={owner}
      executionKey={JSON.stringify([outlineOwnerKey(outlineOwner), block.id])}
      document={document}
      variant="inline"
      label={message("query.section")}
      onRemove={() => {
        void session
          .execute({ type: "remove_property", owner, key: "builtin.query" })
          .catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause));
      }}
    />
  );
}
