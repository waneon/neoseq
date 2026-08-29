import type {
  TemporalDateIntent,
  TemporalMomentIntent,
  TemporalRecurrenceIntent,
  TemporalTimeIntent,
} from "../../entities/temporal";
import {
  NO_TEMPORAL_MATCH,
  mapTemporalRecognition,
  temporalMatch,
  type TemporalRecognition,
} from "./types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MOMENT = /^(\d{4}-\d{2}-\d{2})(?:[ t]([01]\d|2[0-3]):([0-5]\d))?$/;
const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const TRAILING_CLOCK = /(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)$/;

export interface ExtractedTime {
  readonly rest: string;
  readonly time: TemporalTimeIntent;
}

export interface ExtractedRecurrence {
  readonly rest: string;
  readonly recurrence: TemporalRecurrenceIntent;
}

/**
 * Compose independent trailing clock and recurrence phrases around one localized
 * date. Repeating the extraction permits either suffix order without teaching
 * the shared parser any language-specific words.
 */
export function recognizeMomentParts(
  input: string,
  recognizeDate: (input: string) => TemporalRecognition<TemporalDateIntent>,
  extractTime: (input: string) => ExtractedTime | null,
  extractRecurrence: (input: string) => ExtractedRecurrence | null,
): TemporalRecognition<TemporalMomentIntent> {
  let rest = input;
  let time: TemporalTimeIntent | undefined;
  let recurrence: TemporalRecurrenceIntent | undefined;

  for (let index = 0; index < 2; index += 1) {
    const nextRecurrence = recurrence ? null : extractRecurrence(rest);
    if (nextRecurrence) {
      recurrence = nextRecurrence.recurrence;
      rest = nextRecurrence.rest;
      continue;
    }
    const nextTime = time ? null : extractTime(rest);
    if (nextTime) {
      time = nextTime.time;
      rest = nextTime.rest;
      continue;
    }
    break;
  }

  if (!time && !recurrence) return NO_TEMPORAL_MATCH;
  const parts = {
    ...(time ? { time } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
  if (!rest) return temporalMatch(parts);
  const invariantDate = recognizeInvariantDate(rest);
  const date = invariantDate.kind === "none" ? recognizeDate(rest) : invariantDate;
  return mapTemporalRecognition(date, (recognizedDate) => ({
    date: recognizedDate,
    ...parts,
  }));
}

export function normalizeTemporalInput(input: string, locale: string): string {
  let normalized = input.normalize("NFKC").trim();
  const number = new Intl.NumberFormat(locale, { useGrouping: false });
  for (let digit = 0; digit <= 9; digit += 1) {
    normalized = normalized.replaceAll(number.format(digit), String(digit));
  }
  return normalized.toLocaleLowerCase(locale).replace(/\s+/g, " ");
}

export function recognizeInvariantDate(input: string): TemporalRecognition<TemporalDateIntent> {
  return ISO_DATE.test(input)
    ? temporalMatch({ kind: "absolute", date: input })
    : NO_TEMPORAL_MATCH;
}

export function recognizeInvariantMoment(input: string) {
  const moment = ISO_MOMENT.exec(input);
  if (moment) {
    return temporalMatch({
      date: { kind: "absolute", date: moment[1] } as const,
      ...(moment[2] ? { time: { hour: Number(moment[2]), minute: Number(moment[3]) } } : {}),
    });
  }
  const time = CLOCK.exec(input);
  return time
    ? temporalMatch({ time: { hour: Number(time[1]), minute: Number(time[2]) } })
    : NO_TEMPORAL_MATCH;
}

export function extractTrailing24HourTime(input: string): ExtractedTime | null {
  const match = TRAILING_CLOCK.exec(input);
  if (!match) return null;
  return {
    rest: input.slice(0, match.index).trim(),
    time: { hour: Number(match[1]), minute: Number(match[2]) },
  };
}
