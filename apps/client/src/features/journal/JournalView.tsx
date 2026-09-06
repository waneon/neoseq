// Daily journal. "Today" is computed in the configured timezone; the idempotent
// EnsureJournal command creates the page on first visit. The page is then located
// by its builtin.journal-date property, so identity stays with the core (deterministic
// PageId), not with the client.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useNavigate, useParams } from "react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/ui/shadcn/button";
import { findJournalPage, outlineOwnerKey } from "../../core-port/snapshot";
import { todayLocalDate } from "../../entities/journal";
import { addDays } from "../../entities/calendar";
import { useI18n } from "../../i18n";
import { isValidLocalDate } from "../../entities/calendar";
import { useNotify } from "../notify/context";
import { PageBody, Tombstone } from "../page/PageView";
import { JournalCalendar } from "./JournalCalendar";
import { JournalQueries } from "./JournalQueries";
import { useSession, useSessionSelector } from "../shell/session-context";
import { graphPath } from "../graphs/routing";

export function JournalView() {
  const { graphId = "", date: routeDate } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) =>
      left.snapshot === right.snapshot &&
      left.status === right.status &&
      left.hydratedOutlines === right.hydratedOutlines &&
      left.mode === right.mode &&
      left.live === right.live,
  );
  const notify = useNotify();
  const { message, formatJournalDate } = useI18n();
  const [today] = useState(todayLocalDate);
  const date = routeDate ?? today;
  const ensured = useRef<string | null>(null);
  const calendarTrigger = useRef<HTMLButtonElement>(null);
  const previousTrigger = useRef<HTMLButtonElement>(null);
  const nextTrigger = useRef<HTMLButtonElement>(null);
  const navigationFocus = useRef<{
    date: string;
    control: RefObject<HTMLButtonElement | null>;
  } | null>(null);

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
    if (
      !page ||
      state.status !== "ready" ||
      state.hydratedOutlines.has(outlineOwnerKey({ kind: "page", id: page.id }))
    )
      return;
    void session.hydratePage(page.id).catch((error: unknown) => {
      notify.failure(message("failure.loadJournal"), error);
    });
  }, [message, notify, page, session, state.hydratedOutlines, state.status]);

  // A new day replaces the page body, including its controls. Restore the
  // navigation control only when the destination page has actually arrived.
  useLayoutEffect(() => {
    const pending = navigationFocus.current;
    if (!page || pending?.date !== date || !pending.control.current) return;
    pending.control.current.focus({ preventScroll: true });
    navigationFocus.current = null;
  }, [date, page]);

  if (!valid) {
    return (
      <Tombstone
        title={message("journal.invalidDate")}
        detail={message("journal.invalidDateDetail", { date })}
        graphId={graphId}
      />
    );
  }

  const go = (target: string, control = calendarTrigger) => {
    if (target !== date) navigationFocus.current = { date: target, control };
    navigate(graphPath(session.repositoryId, graphId, `journal/${target}`));
  };

  // Standing questions belong to the day they are standing in: their relative
  // operands resolve against the reader's real today, so asked from last March
  // they would answer about now and caption themselves as if they were about
  // March. Today's journal is the only day they are true on.
  const foot = date === today ? <JournalQueries /> : null;

  // Date navigation stays visible; its popup owns date entry and focus return.
  const header = (menu: ReactNode, onContextMenu: (event: React.MouseEvent) => void) => (
    <div className="title-row journal-header" onContextMenu={onContextMenu}>
      <h1 data-testid="journal-title">{formatJournalDate(date)}</h1>
      <div className="title-actions">
        {date !== today && (
          <button className="today-pill" onClick={() => go(today)}>
            {message("journal.today")}
          </button>
        )}
        {/* Moving through the days is what a journal *is*, so the stepper is
            permanent and reads as one control with three keys rather than as
            three glyphs that appear when the pointer happens to pass. It was
            hover-gated, which meant the primary verb of the primary surface was
            invisible until you already knew it was there. */}
        <div className="date-stepper">
          <Button
            size="icon"
            disabled={date === "0001-01-01"}
            ref={previousTrigger}
            aria-label={message("journal.previousDay")}
            onClick={() => go(addDays(date, -1), previousTrigger)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <JournalCalendar date={date} today={today} onSelect={go} trigger={calendarTrigger} />
          <Button
            size="icon"
            disabled={date === "9999-12-31"}
            ref={nextTrigger}
            aria-label={message("journal.nextDay")}
            onClick={() => go(addDays(date, 1), nextTrigger)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </div>
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
          {/* A read-only graph may never get today's page written at all, and the
              answers do not depend on one existing. */}
          {foot}
        </article>
      </div>
    );
  }

  return <PageBody page={page} header={header} foot={foot} />;
}
