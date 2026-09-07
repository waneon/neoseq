import { useMemo, useSyncExternalStore } from "react";
import { nowLocalTime, todayLocalDate } from "../../entities/journal";
import { subscribeAppSettings } from "../../entities/settings";
import { useConfiguredTimezone } from "../settings/preferences";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const currentMinute = () => Math.floor(Date.now() / MINUTE_MS);

function tick() {
  clearTimeout(timer);
  for (const listener of listeners) listener();
  if (listeners.size > 0) timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
}

/** All mounted time-sensitive surfaces share one clock, including after a suspended tab resumes. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS));
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    }
  };
}

const idleSubscribe = () => () => {};

export function useLocalClock(active: boolean) {
  const minute = useSyncExternalStore(
    active ? subscribe : idleSubscribe,
    currentMinute,
    currentMinute,
  );
  const timezone = useConfiguredTimezone();
  return useMemo(() => {
    const instant = new Date(minute * MINUTE_MS);
    return { today: todayLocalDate(instant), now: nowLocalTime(instant) };
  }, [minute, timezone]);
}

function subscribeToday(listener: () => void) {
  const unsubscribeClock = subscribe(listener);
  const unsubscribeSettings = subscribeAppSettings(listener);
  return () => {
    unsubscribeClock();
    unsubscribeSettings();
  };
}

/** Date consumers only render when their local calendar day actually changes. */
export function useToday(): string {
  return useSyncExternalStore(subscribeToday, todayLocalDate, todayLocalDate);
}
