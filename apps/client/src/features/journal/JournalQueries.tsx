// The standing questions, answered under today's writing.
//
// A journal day is where a person looks first, so it is where the answers they
// look for every day belong: what is scheduled, what slipped, what is still
// open. They belong to this graph, travel with it, and are authored in its
// Settings. Every one is an ordinary query document, so the answer and its saved
// presentation use the same surface as a query in a bullet or on a tag's page.
// This module contributes the two things that are only true here: *where* they
// sit, and the route back to the place that authors them.
//
// **Today only.** A relative operand resolves against the reader's own today
// every time it runs, so `due tomorrow` asked on a page dated last March would
// answer about tomorrow and caption itself as if it were about March. A standing
// question belongs to the day it is standing in.
//
// **Below the append zone, never inside it.** The region under the last block is
// the add-a-block affordance (§ Do / Don't), and it keeps its whole reach: these
// are a second body under the writing, not chrome parked at the end of it.

import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { Settings2Icon } from "lucide-react";
import { DropdownMenuItem } from "@/ui/shadcn/dropdown-menu";
import {
  defaultQueryDocument,
  defaultQueryKey,
} from "../../entities/default-queries";
import { QueryPanel } from "../query/QueryPanel";
import { SETTINGS_PARAM } from "../settings/SettingsDialog";
import { useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

export function JournalQueries() {
  const { message } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const queries = useSessionState().snapshot.settings.default_queries;
  // The authoritative summary is identity-stable until GraphSession reconciles
  // a graph change, so one memo keeps panels stable while the journal renders.
  const entries = useMemo(
    () => queries.map((query) => ({ query, document: defaultQueryDocument(query) })),
    [queries],
  );

  if (entries.length === 0) return null;

  // Opening pushes, so the browser's own Back closes the dialog and returns the
  // reader to the day they were reading — the same contract the rail's Settings
  // has, because this is the same dialog.
  const openSettings = () => {
    const next = new URLSearchParams(searchParams);
    next.set(SETTINGS_PARAM, "queries");
    setSearchParams(next);
  };

  return (
    <section
      className="journal-queries"
      aria-label={message("settings.defaultQueries")}
      data-testid="journal-queries"
    >
      {entries.map(({ query, document }) => (
        <QueryPanel
          key={query.id}
          binding={{
            kind: "presented",
            owner: { kind: "graph_default", default_query_id: query.id },
            document,
          }}
          executionKey={defaultQueryKey(query)}
          variant="inline"
          caption={query.title || undefined}
          label={query.title || message("settings.defaultQueries")}
          actions={
            <DropdownMenuItem
              data-testid="journal-query-settings"
              onSelect={openSettings}
            >
              <Settings2Icon aria-hidden />
              {message("settings.editDefaultQueries")}
            </DropdownMenuItem>
          }
        />
      ))}
    </section>
  );
}
