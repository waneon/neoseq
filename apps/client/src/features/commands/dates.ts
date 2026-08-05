// Natural-language date parsing for the command palette.
//
// This is why the journal header does not need a visible date field: "aug 5",
// "next monday" and "3 days ago" all resolve in the same input the user already
// opened to search. Everything here is pure calendar arithmetic on YYYY-MM-DD
// strings so it never disagrees with the configured journal timezone.

import { addDays } from "../../entities/journal";
import type { SupportedLocale } from "../../i18n";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isRealDate(date: string): boolean {
  const match = ISO.exec(date);
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day)
  );
}

/**
 * Resolves a query to a calendar date, or null when it is not a date at all.
 * `today` anchors every relative form, so the result always agrees with the
 * journal's own notion of the current day.
 */
export function parseDateQuery(
  raw: string,
  today: string,
  locale: SupportedLocale = "en",
): string | null {
  const query = raw.trim().toLowerCase();
  if (query.length === 0) return null;

  if (ISO.test(query)) return isRealDate(query) ? query : null;

  if (locale === "ko") return parseKoreanDateQuery(query, today);

  if (query === "today" || query === "now") return today;
  if (query === "tomorrow") return addDays(today, 1);
  if (query === "yesterday") return addDays(today, -1);

  // "3 days ago", "in 2 weeks", "2 weeks ago", "5 days from now"
  const relative =
    /^(?:in\s+)?(\d{1,4})\s*(day|days|week|weeks|month|months)(?:\s+(ago|from now))?$/.exec(
      query,
    );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const backwards = relative[3] === "ago";
    const days =
      unit.startsWith("week") ? amount * 7 : unit.startsWith("month") ? amount * 30 : amount;
    return addDays(today, backwards ? -days : days);
  }

  // "next monday", "last friday", "monday"
  const weekday = /^(?:(next|last|this)\s+)?([a-z]+)$/.exec(query);
  if (weekday) {
    const index = WEEKDAYS.findIndex((name) => name.startsWith(weekday[2]) && weekday[2].length >= 3);
    if (index >= 0) {
      const current = dayOfWeek(today);
      if (weekday[1] === "last") {
        const back = ((current - index + 7 - 1) % 7) + 1;
        return addDays(today, -back);
      }
      const forward = ((index - current + 7 - 1) % 7) + 1;
      return addDays(today, forward);
    }
  }

  // "aug 5", "5 aug", "august 5 2026", "aug 5, 2026"
  const words = query.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  for (const word of words) {
    const monthIndex = MONTHS.findIndex(
      (name) => word.length >= 3 && name.startsWith(word),
    );
    if (monthIndex >= 0 && month === null) {
      month = monthIndex + 1;
      continue;
    }
    if (/^\d{4}$/.test(word)) {
      year = Number(word);
      continue;
    }
    if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(word) && day === null) {
      day = Number(word.replace(/\D/g, ""));
      continue;
    }
    return null;
  }
  if (month === null || day === null) return null;
  const resolvedYear = year ?? Number(today.slice(0, 4));
  const candidate = `${resolvedYear}-${pad(month)}-${pad(day)}`;
  return isRealDate(candidate) ? candidate : null;
}

function parseKoreanDateQuery(query: string, today: string): string | null {
  if (query === "오늘" || query === "지금") return today;
  if (query === "내일") return addDays(today, 1);
  if (query === "어제") return addDays(today, -1);

  const relative = /^(\d{1,4})\s*(일|주|주일|개월|달)\s*(전|후|뒤)$/.exec(query);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const days = unit === "주" || unit === "주일" ? amount * 7 : unit === "개월" || unit === "달" ? amount * 30 : amount;
    return addDays(today, relative[3] === "전" ? -days : days);
  }

  const weekday = /^(?:(다음|지난|이번)\s*)?(일|월|화|수|목|금|토)요일$/.exec(query);
  if (weekday) {
    const index = ["일", "월", "화", "수", "목", "금", "토"].indexOf(weekday[2]);
    const current = dayOfWeek(today);
    if (weekday[1] === "지난") {
      const back = ((current - index + 7 - 1) % 7) + 1;
      return addDays(today, -back);
    }
    const forward = ((index - current + 7 - 1) % 7) + 1;
    return addDays(today, forward);
  }

  const calendar = /^(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일$/.exec(query);
  if (!calendar) return null;
  const year = Number(calendar[1] ?? today.slice(0, 4));
  const candidate = `${year}-${pad(Number(calendar[2]))}-${pad(Number(calendar[3]))}`;
  return isRealDate(candidate) ? candidate : null;
}
