import { getDayOfWeek, parseDate } from "@internationalized/date";

/** The domain's Gregorian local dates: exactly YYYY-MM-DD, years 0001–9999. */
export function isValidLocalDate(value: string): boolean {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: string, days: number): string {
  return parseDate(date).add({ days }).toString();
}

/** Month arithmetic constrains the day to the destination month's length. */
export function addMonths(date: string, months: number): string {
  return parseDate(date).add({ months }).toString();
}

export function dayDifference(to: string, from: string): number {
  return parseDate(to).compare(parseDate(from));
}

/** Sunday is zero, matching the language packs' weekday vocabulary. */
export function dayOfWeek(date: string): number {
  return getDayOfWeek(parseDate(date), "en-US", "sun");
}
