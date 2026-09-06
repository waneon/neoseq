// An outline-owned query. The shared panel owns authoring and result presentation.

import type { BlockSnapshot, OutlineOwner } from "../../core-port/snapshot";
import { outlineOwnerKey } from "../../core-port/snapshot";
import { queryDocument } from "../../core-port/snapshot";
import { useNotify } from "../notify/context";
import { useSession } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { QueryPanel } from "./QueryPanel";

export function QueryBlock({
  owner: outlineOwner,
  block,
}: {
  owner: OutlineOwner;
  block: BlockSnapshot;
}) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const document = queryDocument(block.properties);
  const owner = { kind: "block", owner: outlineOwner, id: block.id } as const;

  if (!document) return null;

  return (
    <QueryPanel
      binding={{ kind: "managed", owner, document }}
      executionKey={JSON.stringify([outlineOwnerKey(outlineOwner), block.id])}
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
