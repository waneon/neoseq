// Daily journal. "Today" is computed in the configured IANA timezone; the
// idempotent EnsureJournal command creates the page on first visit. The
// page is then located by its journal.date property, so identity stays
// with the core (deterministic PageId), not with the client.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
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

  const valid = isValidLocalDate(date);
  const page = valid ? findJournalPage(state.snapshot, date) : undefined;

  useEffect(() => {
    if (!valid || state.status !== "ready" || state.mode === "readonly") return;
    if (page || ensured.current === date) return;
    ensured.current = date;
    void session.execute({ type: "ensure_journal", date }).catch(() => undefined);
  }, [valid, state.status, state.mode, page, date, session]);

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

  const header = (
    <div>
      <div className="journal-nav">
        <span className="eyebrow">Journal</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" aria-label="Previous day" onClick={() => go(addDays(date, -1))}>
          ←
        </button>
        <input
          type="date"
          aria-label="Jump to date"
          value={date}
          data-testid="journal-date"
          onChange={(event) => {
            if (event.target.value) go(event.target.value);
          }}
        />
        <button className="icon-btn" aria-label="Next day" onClick={() => go(addDays(date, 1))}>
          →
        </button>
        {date !== today && (
          <button className="btn btn-utility" onClick={() => go(today)}>
            Today
          </button>
        )}
      </div>
      <h1 className="page-title" data-testid="journal-title">
        {formatJournalTitle(date)}
      </h1>
      <p className="page-subtitle">{date}</p>
    </div>
  );

  if (!page) {
    return (
      <div className="page-scroll">
        <article className="page-body">
          {header}
          <p className="outline-empty" aria-busy={state.mode !== "readonly"}>
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
