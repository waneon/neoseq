// The journal continues below the day on screen: every earlier day with
// writing follows as its own editable outline, newest first, loaded as the
// reader scrolls toward it.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link } from "react-router";
import type { PageSnapshot } from "../../core-port/snapshot";
import { isDeleted, journalDate, outlineOwnerKey, pageKind } from "../../core-port/snapshot";
import { dayDifference } from "../../entities/calendar";
import { useI18n } from "../../i18n";
import { graphPath } from "../graphs/routing";
import { Outliner } from "../outline/Outliner";
import { useSession, useSessionSelector } from "../shell/session-context";

/** Days added each time the reader nears the end of the journal. */
const BATCH = 5;

export function JournalDays({
  before,
  today,
  scrollElement,
}: {
  before: string;
  today: string;
  scrollElement: HTMLElement | null;
}) {
  const session = useSession();
  const snapshot = useSessionSelector((state) => state.snapshot);
  const hydrated = useSessionSelector((state) => state.hydratedOutlines);
  const [wanted, setWanted] = useState(BATCH);
  const failed = useRef(new Set<string>());
  const [, skipped] = useReducer((count: number) => count + 1, 0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => setWanted(BATCH), [before]);

  const days = useMemo(
    () =>
      snapshot.pages
        .flatMap((page) => {
          const date = pageKind(page) === "journal" && !isDeleted(page) ? journalDate(page) : null;
          return date && date < before ? [{ page, date }] : [];
        })
        .sort((left, right) => right.date.localeCompare(left.date)),
    [before, snapshot],
  );

  // Days render in order: stop at the first one whose outline has not arrived,
  // and load it with the next few behind it.
  const shown: { page: PageSnapshot; date: string }[] = [];
  const loading: string[] = [];
  for (const day of days) {
    if (shown.length >= wanted) break;
    if (failed.current.has(day.page.id)) continue;
    if (!hydrated.has(outlineOwnerKey({ kind: "page", id: day.page.id }))) {
      loading.push(day.page.id);
      if (loading.length >= BATCH) break;
      continue;
    }
    if (loading.length > 0) break;
    if (day.page.blocks.length > 0) shown.push(day);
  }
  const exhausted = shown.length < wanted && loading.length === 0;
  const loadingKey = loading.join(" ");

  useEffect(() => {
    for (const id of loadingKey ? loadingKey.split(" ") : []) {
      void session.hydratePage(id).catch(() => {
        // The day's own route reports the failure; the journal skips past it.
        failed.current.add(id);
        skipped();
      });
    }
  }, [loadingKey, session]);

  useEffect(() => {
    const sentinel = end.current;
    if (!sentinel || !scrollElement || exhausted || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setWanted((count) => count + BATCH);
      },
      { root: scrollElement, rootMargin: "0px 0px 800px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [exhausted, scrollElement, shown.length]);

  return (
    <div className="journal-days">
      {shown.map(({ page, date }) => (
        <JournalDay
          key={page.id}
          page={page}
          date={date}
          today={today}
          scrollElement={scrollElement}
        />
      ))}
      {!exhausted && <div ref={end} className="journal-days-end" aria-hidden />}
    </div>
  );
}

function JournalDay({
  page,
  date,
  today,
  scrollElement,
}: {
  page: PageSnapshot;
  date: string;
  today: string;
  scrollElement: HTMLElement | null;
}) {
  const session = useSession();
  const { message, formatJournalDate } = useI18n();
  const label = formatJournalDate(date);
  const distance = dayDifference(date, today);
  return (
    <section className="journal-day" aria-label={label} data-testid="journal-day">
      <header className="document-header" data-scroll-title={label}>
        <h2 className="journal-day-title">
          <Link to={graphPath(session.repositoryId, session.graphId, `journal/${date}`)}>
            <time dateTime={date}>{label}</time>
          </Link>
        </h2>
        <p className="document-caption">
          {message("journal.distance", {
            direction: distance === 0 ? "today" : distance < 0 ? "past" : "future",
            count: Math.abs(distance),
          })}
        </p>
      </header>
      <Outliner
        owner={{ kind: "page", id: page.id }}
        blocks={page.blocks}
        scrollElement={scrollElement}
      />
    </section>
  );
}
