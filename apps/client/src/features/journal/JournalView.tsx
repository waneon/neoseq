// Daily journal. "Today" is computed in the configured timezone; the idempotent
// EnsureJournal command creates the page on first visit. The page is then located
// by its builtin.journal-date property, so identity stays with the core (deterministic
// PageId), not with the client.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { findJournalPage } from "../../core-port/snapshot";
import {
  addDays,
  todayLocalDate,
} from "../../entities/journal";
import { useI18n } from "../../i18n";
import { isValidLocalDate } from "../../entities/properties";
import { useNotify } from "../notify/context";
import { PageBody, Tombstone } from "../page/PageView";
import { useSession, useSessionState } from "../shell/session-context";

export function JournalView() {
  const { graphId = "", date: routeDate } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, formatJournalDate } = useI18n();
  const [today] = useState(todayLocalDate);
  const date = routeDate ?? today;
  const ensured = useRef<string | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);

  const valid = isValidLocalDate(date);
  const page = valid ? findJournalPage(state.snapshot, date) : undefined;

  // Without a report this failure parks the view on "Preparing this journal
  // day…" forever, with no way to tell a slow open from a dead one.
  const ensure = useCallback<() => void>(() => {
    ensured.current = date;
    void session.execute({ type: "ensure_journal", date }).catch((error: unknown) => {
      ensured.current = null;
      notify.failure(message("failure.openJournal"), error, {
        label: message("common.retry"),
        run: ensure,
      });
    });
  }, [date, message, notify, session]);

  useEffect(() => {
    if (!valid || state.status !== "ready" || state.mode === "readonly") return;
    // A newly connected remote replica must apply its Welcome delta before it
    // decides that today's journal is missing. Otherwise two clients opening
    // the same remote graph can race and create distinct journal pages.
    if (state.live === "connecting") return;
    if (page || ensured.current === date) return;
    ensure();
  }, [ensure, valid, state.status, state.mode, state.live, page, date]);

  useEffect(() => {
    if (!page || state.status !== "ready" || state.hydratedPages.has(page.id)) return;
    void session.hydratePage(page.id).catch((error: unknown) => {
      notify.failure(message("failure.loadJournal"), error);
    });
  }, [message, notify, page, session, state.hydratedPages, state.status]);

  if (!valid) {
    return (
      <Tombstone
        title={message("journal.invalidDate")}
        detail={message("journal.invalidDateDetail", { date })}
        graphId={graphId}
      />
    );
  }

  const go = (target: string) => navigate(`/g/${graphId}/journal/${target}`);

  // One title row. The heading is the date; the stepper is summoned on hover or
  // focus; `Today` appears only when the answer is not "today". The native date
  // input stays mounted, focusable and value-synced but clipped — it is a real
  // keyboard tab stop and the target of showPicker(), without restating the date
  // a third time in the platform's own locale format. Right-clicking the row
  // reaches the page's own verbs, exactly as it does on a regular page.
  const header = (menu: ReactNode, onContextMenu: (event: React.MouseEvent) => void) => (
    <div className="title-row" onContextMenu={onContextMenu}>
      <h1 data-testid="journal-title">{formatJournalDate(date)}</h1>
      <div className="title-actions">
        {date !== today && (
          <button className="today-pill" onClick={() => go(today)}>
            {message("journal.today")}
          </button>
        )}
        <div className="revealed">
          <button
            className="icon-btn"
            aria-label={message("journal.previousDay")}
            onClick={() => go(addDays(date, -1))}
          >
            <ChevronLeftIcon aria-hidden />
          </button>
          <button
            className="icon-btn"
            aria-label={message("journal.calendarOpen")}
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
            aria-label={message("journal.nextDay")}
            onClick={() => go(addDays(date, 1))}
          >
            <ChevronRightIcon aria-hidden />
          </button>
        </div>
        <input
          ref={dateInput}
          className="clipped-control"
          type="date"
          aria-label={message("journal.jumpToDate")}
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
          {header(null, (event) => event.preventDefault())}
          <p className="page-note" aria-busy={state.mode !== "readonly"}>
            {state.mode === "readonly"
              ? message("journal.emptyReadonly")
              : message("journal.preparing")}
          </p>
        </article>
      </div>
    );
  }

  return <PageBody page={page} header={header} />;
}
