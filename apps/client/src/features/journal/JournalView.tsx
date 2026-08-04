// Daily journal. "Today" is computed in the configured timezone; the idempotent
// EnsureJournal command creates the page on first visit. The page is then located
// by its journal.date property, so identity stays with the core (deterministic
// PageId), not with the client.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { findJournalPage } from "../../core-port/snapshot";
import {
  addDays,
  formatJournalTitle,
  todayLocalDate,
} from "../../entities/journal";
import { isValidLocalDate } from "../../entities/properties";
import { PageBody, Tombstone } from "../page/PageView";
import { useSession, useSessionState } from "../shell/session-context";

export function JournalView() {
  const { graphId = "", date: routeDate } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const state = useSessionState();
  const [today] = useState(todayLocalDate);
  const date = routeDate ?? today;
  const ensured = useRef<string | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);

  const valid = isValidLocalDate(date);
  const page = valid ? findJournalPage(state.snapshot, date) : undefined;

  useEffect(() => {
    if (!valid || state.status !== "ready" || state.mode === "readonly") return;
    if (page || ensured.current === date) return;
    ensured.current = date;
    void session.execute({ type: "ensure_journal", date }).catch(() => undefined);
  }, [valid, state.status, state.mode, page, date, session]);

  useEffect(() => {
    if (!page || state.status !== "ready" || state.hydratedPages.has(page.id)) return;
    void session.hydratePage(page.id).catch(() => undefined);
  }, [page, session, state.hydratedPages, state.status]);

  if (!valid) {
    return (
      <Tombstone
        title="Not a calendar date"
        detail={`“${date}” is not a valid YYYY-MM-DD date.`}
        graphId={graphId}
      />
    );
  }

  const go = (target: string) => navigate(`/g/${graphId}/journal/${target}`);

  // One title row. The heading is the date; the stepper is summoned on hover or
  // focus; `Today` appears only when the answer is not "today". The native date
  // input stays mounted, focusable and value-synced but clipped — it is a real
  // keyboard tab stop and the target of showPicker(), without restating the date
  // a third time in the platform's own locale format.
  const header = (menu: ReactNode) => (
    <div className="title-row">
      <h1 data-testid="journal-title">{formatJournalTitle(date)}</h1>
      <div className="title-actions">
        {date !== today && (
          <button className="today-pill" onClick={() => go(today)}>
            Today
          </button>
        )}
        <div className="revealed">
          <button
            className="icon-btn"
            aria-label="Previous day"
            onClick={() => go(addDays(date, -1))}
          >
            <ChevronLeftIcon aria-hidden />
          </button>
          <button
            className="icon-btn"
            aria-label="Open the calendar"
            onClick={() => {
              const input = dateInput.current;
              if (!input) return;
              input.showPicker?.();
              input.focus();
            }}
          >
            <CalendarIcon aria-hidden />
          </button>
          <button
            className="icon-btn"
            aria-label="Next day"
            onClick={() => go(addDays(date, 1))}
          >
            <ChevronRightIcon aria-hidden />
          </button>
        </div>
        <input
          ref={dateInput}
          className="clipped-control"
          type="date"
          aria-label="Jump to date"
          value={date}
          data-testid="journal-date"
          onChange={(event) => {
            if (event.target.value) go(event.target.value);
          }}
        />
        {menu}
      </div>
    </div>
  );

  if (!page) {
    return (
      <div className="page-scroll">
        <article className="page-body">
          {header(null)}
          <p className="page-note" aria-busy={state.mode !== "readonly"}>
            {state.mode === "readonly"
              ? "This journal day has no entries yet."
              : "Preparing this journal day…"}
          </p>
        </article>
      </div>
    );
  }

  return <PageBody page={page} header={header} />;
}
