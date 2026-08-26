import type { TemporalDateIntent, TemporalTimeIntent } from "../../entities/temporal";
import {
  NO_TEMPORAL_MATCH,
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

export function normalizeTemporalInput(input: string, locale: string): string {
  let normalized = input.normalize("NFKC").trim();
  const number = new Intl.NumberFormat(locale, { useGrouping: false });
  for (let digit = 0; digit <= 9; digit += 1) {
    normalized = normalized.replaceAll(number.format(digit), String(digit));
  }
  return normalized.toLocaleLowerCase(locale).replace(/\s+/g, " ");
}

export function recognizeInvariantDate(
  input: string,
): TemporalRecognition<TemporalDateIntent> {
  return ISO_DATE.test(input)
    ? temporalMatch({ kind: "absolute", date: input })
    : NO_TEMPORAL_MATCH;
}

export function recognizeInvariantMoment(input: string) {
  const moment = ISO_MOMENT.exec(input);
  if (moment) {
    return temporalMatch({
      date: { kind: "absolute", date: moment[1] } as const,
      ...(moment[2]
        ? { time: { hour: Number(moment[2]), minute: Number(moment[3]) } }
        : {}),
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
