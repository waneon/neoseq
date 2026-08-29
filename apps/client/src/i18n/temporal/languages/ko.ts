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

function recognizeDate(input: string): TemporalRecognition<TemporalDateIntent> {
  if (input === "오늘" || input === "지금") {
    return temporalMatch({ kind: "relative", unit: "day", amount: 0 });
  }
  if (input === "내일") {
    return temporalMatch({ kind: "relative", unit: "day", amount: 1 });
  }
  if (input === "어제") {
    return temporalMatch({ kind: "relative", unit: "day", amount: -1 });
  }

  const relative = /^(\d{1,4})\s*(일|주|주일|개월|달)\s*(전|후|뒤)$/.exec(input);
  if (relative) {
    const unit =
      relative[2] === "주" || relative[2] === "주일"
        ? "week"
        : relative[2] === "개월" || relative[2] === "달"
          ? "month"
          : "day";
    const amount = Number(relative[1]) * (relative[3] === "전" ? -1 : 1);
    return temporalMatch({ kind: "relative", unit, amount });
  }

  const weekday = /^(?:(다음|지난|이번)\s*)?(일|월|화|수|목|금|토)요일$/.exec(input);
  if (weekday) {
    return temporalMatch({
      kind: "weekday",
      weekday: ["일", "월", "화", "수", "목", "금", "토"].indexOf(weekday[2]),
      direction: weekday[1] === "지난" ? "past" : "future",
    });
  }

  const calendar = /^(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일$/.exec(input);
  return calendar
    ? temporalMatch({
        kind: "calendar",
        ...(calendar[1] ? { year: Number(calendar[1]) } : {}),
        month: Number(calendar[2]),
        day: Number(calendar[3]),
      })
    : NO_TEMPORAL_MATCH;
}

function extractKoreanTime(input: string): ExtractedTime | null {
  const period = /(?:^|\s)(오전|오후)\s*(\d{1,2})(?:시)?(?:\s*(\d{1,2})분?)?$/.exec(input);
  if (period) {
    const rawHour = Number(period[2]);
    return {
      rest: input.slice(0, period.index).trim(),
      time: {
        hour: rawHour < 1 || rawHour > 12 ? 24 : (rawHour % 12) + (period[1] === "오후" ? 12 : 0),
        minute: Number(period[3] ?? 0),
      },
    };
  }
  const clock = /(?:^|\s)(\d{1,2})시(?:\s*(\d{1,2})분?)?$/.exec(input);
  return clock
    ? {
        rest: input.slice(0, clock.index).trim(),
        time: { hour: Number(clock[1]), minute: Number(clock[2] ?? 0) },
      }
    : null;
}

function extractKoreanRecurrence(input: string): ExtractedRecurrence | null {
  const shorthand = /(?:^|\s)(매일|매주|매월|매년)$/.exec(input);
  if (shorthand) {
    const unit =
      shorthand[1] === "매일"
        ? "day"
        : shorthand[1] === "매주"
          ? "week"
          : shorthand[1] === "매월"
            ? "month"
            : "year";
    return {
      rest: input.slice(0, shorthand.index).trim(),
      recurrence: { count: 1, unit },
    };
  }
  const interval =
    /(?:^|\s)(\d{1,3})\s*(일|주|주일|개월|달|년)마다$/.exec(input) ??
    /(?:^|\s)매\s*(\d{1,3})\s*(일|주|주일|개월|달|년)(?:마다)?$/.exec(input);
  if (!interval) return null;
  const unit =
    interval[2] === "주" || interval[2] === "주일"
      ? "week"
      : interval[2] === "개월" || interval[2] === "달"
        ? "month"
        : interval[2] === "년"
          ? "year"
          : "day";
  return {
    rest: input.slice(0, interval.index).trim(),
    recurrence: { count: Number(interval[1]), unit },
  };
}

function recognizeMoment(input: string) {
  return recognizeMomentParts(
    input,
    recognizeDate,
    (value) => extractKoreanTime(value) ?? extractTrailing24HourTime(value),
    extractKoreanRecurrence,
  );
}

const koreanTemporalPack: TemporalLanguagePack = {
  support: "full",
  examples: {
    dates: ["오늘", "내일", "3일 전", "다음 금요일", "8월 5일"],
    moments: ["내일 오후 3시 5분", "8월 5일 9시", "내일 2주마다"],
  },
  recognizeDate,
  recognizeMoment,
};

export default koreanTemporalPack;
