import { FileTextIcon, HashIcon } from "lucide-react";
import { DropdownMenuItem } from "@/ui/shadcn/dropdown-menu";
import { useSession } from "../shell/session-context";
import { useNotify } from "../notify/context";
import { useI18n } from "../../i18n";

export function EntityKindMenuItem({ id, kind }: { id: string; kind: "page" | "tag" }) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  return (
    <DropdownMenuItem
      data-testid={`convert-to-${kind}`}
      onSelect={() => {
        void session
          .execute({ type: "set_entity_kind", id, kind })
          .catch((error) => notify.failure(message("entity.convertFailed"), error));
      }}
    >
      {kind === "tag" ? <HashIcon aria-hidden /> : <FileTextIcon aria-hidden />}
      {message(kind === "tag" ? "entity.convertToTag" : "entity.convertToPage")}
    </DropdownMenuItem>
  );
}
