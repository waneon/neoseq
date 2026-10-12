import { StarIcon } from "lucide-react";
import type { PropertyOwner } from "../../generated/domain";
import type { PageSnapshot, TagSnapshot } from "../../core-port/snapshot";
import { FAVOURITE_KEY, isFavourite } from "../../entities/favourites";
import { useI18n } from "../../i18n";
import { Button } from "@/ui/shadcn/button";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";

/** Starring is a state of the document, so its control shows the state. */
export function FavouriteToggle({
  entity,
  owner,
}: {
  entity: PageSnapshot | TagSnapshot;
  owner: PropertyOwner;
}) {
  const session = useSession();
  const readonly = useSessionSelector((state) => state.mode === "readonly");
  const notify = useNotify();
  const { message } = useI18n();
  const starred = isFavourite(entity);
  const label = message(starred ? "favourites.remove" : "favourites.add");
  return (
    <Button
      size="icon"
      className="favourite-toggle"
      aria-pressed={starred}
      aria-label={label}
      title={label}
      disabled={readonly}
      data-testid="favourite-toggle"
      onClick={() => {
        void session
          .execute(
            starred
              ? { type: "remove_property", owner, key: FAVOURITE_KEY }
              : {
                  type: "set_property",
                  owner,
                  key: FAVOURITE_KEY,
                  value: { type: "checkbox", value: true },
                },
          )
          .catch((error: unknown) => notify.failure(message("failure.favourite"), error));
      }}
    >
      <StarIcon aria-hidden />
    </Button>
  );
}
