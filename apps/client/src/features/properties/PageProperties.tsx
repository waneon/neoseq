// Page properties, relocated.
//
// Both property bags used to be mounted unconditionally BELOW the outline, each
// with a permanently-visible four-control add form. On a journal page at
// 1440x900 that gave 401px of database chrome to 30px of the user's own writing.
//
// They now live in one disclosure between the title and the writing:
// - closed, empty bag  → nothing renders at all; the page ⋯ menu is the route in
// - closed, non-empty  → a strip of `key: value` chips, so the data stays visible
//                        and the panel is discoverable without being open
// - open               → the same page property editor as before
//
// Three routes in: the strip, the page ⋯ menu, and ⌘⇧P. System keys are filtered
// out — they are facts about the page (page ⋯ → Page info), not data on it.

import { useEffect, useMemo } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { PageSnapshot, PropertyEntry, PropertyValue } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { isSystemKey } from "../../entities/properties";
import { useCommands } from "../commands/context";
import { useSessionState } from "../shell/session-context";
import { PropertyBagEditor } from "./PropertyBagEditor";
import { useI18n } from "../../i18n";

const STRIP_LIMIT = 4;

export function PageProperties({
  page,
  open,
  onOpenChange,
}: {
  page: PageSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commands = useCommands();
  const { message } = useI18n();

  // ⌘⇧P is a shell-level binding, so the shell holds a slot it can fill to reach
  // this panel. The pointer route (the page ⋯ menu) is wired locally in PageView
  // and works with or without a shell — which is also what keeps the component
  // test harness, which mounts PageView on its own, able to open the panel.
  useEffect(() => {
    commands.setPageProperties(() => onOpenChange(true));
    return () => commands.setPageProperties(null);
  }, [commands, onOpenChange]);

  const visible = useMemo(
    () => page.properties.filter((entry) => !isSystemKey(entry.key)),
    [page.properties],
  );

  if (!open) {
    if (visible.length === 0) return null;
    return (
      <div className="prop-strip">
        {visible.slice(0, STRIP_LIMIT).map((entry, index) => (
          <StripChip
            key={`${entry.key}:${index}`}
            entry={entry}
            onOpen={() => onOpenChange(true)}
          />
        ))}
        {visible.length > STRIP_LIMIT && (
          <button
            className="prop-strip-chip"
            onClick={() => onOpenChange(true)}
            data-testid="props-strip-more"
          >
            {message("properties.more", { count: visible.length - STRIP_LIMIT })}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="props-panel" data-testid="props-panel">
      <button
        className="props-disclosure"
        aria-expanded
        onClick={() => onOpenChange(false)}
        data-testid="props-page-toggle"
      >
        <ChevronDownIcon aria-hidden />
        {message("properties.title")}
      </button>
      <PropertyBagEditor
        kind="page"
        targetId={page.id}
        bag={visible}
        title={message("page.properties")}
        showHeading={false}
      />
    </div>
  );
}

/** One `key: value` chip. The key carries the mono voice: it is an identifier. */
function StripChip({ entry, onOpen }: { entry: PropertyEntry; onOpen: () => void }) {
  const state = useSessionState();
  const { message } = useI18n();
  const value = describe(entry.value, state, message);
  return (
    <button className="prop-strip-chip" onClick={onOpen} title={`${entry.key}: ${value}`}>
      <span className="key">{entry.key}</span>
      <span className="value">{value}</span>
    </button>
  );
}

function describe(
  value: PropertyValue,
  state: ReturnType<typeof useSessionState>,
  message: ReturnType<typeof useI18n>["message"],
): string {
  if (value.type === "checkbox") {
    return value.value ? message("common.yes") : message("common.no");
  }
  if (value.type === "page") {
    const target = findPage(state.snapshot, value.value);
    if (!target) return value.value;
    return isDeleted(target)
      ? message("properties.deleted", { name: pageTitle(target) })
      : pageTitle(target);
  }
  return String(value.value);
}
