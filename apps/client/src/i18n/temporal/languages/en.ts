import type { TemporalDateIntent } from "../../../entities/temporal";
import {
  extractTrailing24HourTime,
  recognizeMomentParts,
  type ExtractedRecurrence,
  type ExtractedTime,
} from "../shared";
import {
  NO_TEMPORAL_MATCH,
  temporalMatch,
  type TemporalLanguagePack,
  type TemporalRecognition,
} from "../types";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

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
] as const;

function recognizeDate(input: string): TemporalRecognition<TemporalDateIntent> {
  if (input === "today" || input === "now") {
    return temporalMatch({ kind: "relative", unit: "day", amount: 0 });
  }
  if (input === "tomorrow") {
    return temporalMatch({ kind: "relative", unit: "day", amount: 1 });
  }
  if (input === "yesterday") {
    return temporalMatch({ kind: "relative", unit: "day", amount: -1 });
  }

  const relative =
    /^(?:in\s+)?(\d{1,4})\s*(day|days|week|weeks|month|months)(?:\s+(ago|from now))?$/.exec(
      input,
    );
  if (relative) {
    const unit = relative[2].startsWith("week")
      ? "week"
      : relative[2].startsWith("month")
        ? "month"
        : "day";
    const amount = Number(relative[1]) * (relative[3] === "ago" ? -1 : 1);
    return temporalMatch({ kind: "relative", unit, amount });
  }

  const weekday = /^(?:(next|last|this)\s+)?([a-z]+)$/.exec(input);
  if (weekday) {
    const index = WEEKDAYS.findIndex(
      (name) => weekday[2].length >= 3 && name.startsWith(weekday[2]),
    );
    if (index >= 0) {
      return temporalMatch({
        kind: "weekday",
        weekday: index,
        direction: weekday[1] === "last" ? "past" : "future",
      });
    }
  }

  const words = input.replace(/,/g, " ").split(/\s+/).filter(Boolean);
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  for (const word of words) {
    const monthIndex = MONTHS.findIndex(
      (name) => word.length >= 3 && name.startsWith(word),
    );
    if (monthIndex >= 0 && month === undefined) {
      month = monthIndex + 1;
    } else if (/^\d{4}$/.test(word) && year === undefined) {
      year = Number(word);
    } else if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(word) && day === undefined) {
      day = Number(word.replace(/\D/g, ""));
    } else {
      return NO_TEMPORAL_MATCH;
    }
  }
  return month !== undefined && day !== undefined
    ? temporalMatch({ kind: "calendar", ...(year === undefined ? {} : { year }), month, day })
    : NO_TEMPORAL_MATCH;
}

function extractEnglishTime(input: string): ExtractedTime | null {
  const match = /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(input);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const hour = rawHour < 1 || rawHour > 12
    ? 24
    : (rawHour % 12) + (match[3] === "pm" ? 12 : 0);
  return {
    rest: input.slice(0, match.index).trim(),
    time: { hour, minute: Number(match[2] ?? 0) },
  };
}

function extractEnglishRecurrence(input: string): ExtractedRecurrence | null {
  const shorthand = /(?:^|\s)(daily|weekly|monthly|yearly|annually)$/.exec(input);
  if (shorthand) {
    const unit = shorthand[1] === "daily"
      ? "day"
      : shorthand[1] === "weekly"
        ? "week"
        : shorthand[1] === "monthly"
          ? "month"
          : "year";
    return {
      rest: input.slice(0, shorthand.index).trim(),
      recurrence: { count: 1, unit },
    };
  }
  const every = /(?:^|\s)every\s+(?:(\d{1,3})\s+)?(day|days|week|weeks|month|months|year|years)$/.exec(
    input,
  );
  if (!every) return null;
  const unit = every[2].startsWith("week")
    ? "week"
    : every[2].startsWith("month")
      ? "month"
      : every[2].startsWith("year")
        ? "year"
        : "day";
  return {
    rest: input.slice(0, every.index).trim(),
    recurrence: { count: Number(every[1] ?? 1), unit },
  };
}

function recognizeMoment(input: string) {
  return recognizeMomentParts(
    input,
    recognizeDate,
    (value) => extractEnglishTime(value) ?? extractTrailing24HourTime(value),
    extractEnglishRecurrence,
  );
}

const englishTemporalPack: TemporalLanguagePack = {
  support: "full",
  examples: {
    dates: ["today", "tomorrow", "3 days ago", "next friday", "aug 5"],
    moments: ["tomorrow 14:30", "next friday 3:05 pm", "tomorrow every 2 weeks"],
  },
  recognizeDate,
  recognizeMoment,
};

export default englishTemporalPack;
