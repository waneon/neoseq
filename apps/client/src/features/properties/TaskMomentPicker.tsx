import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { parseDate, parseTime, Time } from "@internationalized/date";
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DateSegment,
  Heading,
  I18nProvider,
  Switch,
  TimeField,
} from "react-aria-components";
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  RepeatIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { addDays, nowLocalTime, todayLocalDate } from "../../entities/journal";
import {
  advanceDate,
  DEFAULT_REPEAT,
  formatRepeat,
  parseRepeat,
  REPEAT_UNITS,
  type RepeatInterval,
  type RepeatUnit,
} from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { parseMomentQuery } from "../commands/dates";
import { repeatLabel, repeatUnitLabel } from "../tasks/labels";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { MenuSelect } from "@/ui/menu-select";

interface TaskMomentPickerProps {
  date: string;
  time?: string;
  repeat?: string;
  hasValue: boolean;
  readonly: boolean;
  busy: boolean;
  onApply: (date: string, time: string | null, repeat: string | null | undefined) => void;
  onClear: () => void;
  onCancel: () => void;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A task moment is edited as the one thing a reader means: a day with an
 * optional clock. Its task-level cadence belongs beside that moment, so it joins
 * the same local draft. Persistence happens only through Apply, giving pointer,
 * keyboard, and natural-language routes one command and one undo boundary.
 */
export function TaskMomentPicker({
  date: initialDate,
  time: initialTime,
  repeat: initialRepeat,
  hasValue,
  readonly,
  busy,
  onApply,
  onClear,
  onCancel,
}: TaskMomentPickerProps) {
  const { locale, message, formatJournalDate, formatTimeOfDay } = useI18n();
  const today = todayLocalDate();
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState<string | null>(initialTime ?? null);
  const [rememberedTime, setRememberedTime] = useState(initialTime ?? "09:00");
  const [repeat, setRepeat] = useState<RepeatInterval | null>(() =>
    initialRepeat ? parseRepeat(initialRepeat) : null);
  const [repeatChanged, setRepeatChanged] = useState(false);
  const [activePane, setActivePane] = useState<"date" | "rules">("date");
  const [query, setQuery] = useState("");
  const timeControlsRef = useRef<HTMLDivElement>(null);
  const paneId = useId();
  const parsed = useMemo(
    () => parseMomentQuery(query, today, locale),
    [locale, query, today],
  );
  const calendarDate = parseDate(date);
  const quick = [
    { id: "today", label: message("properties.today"), value: today },
    { id: "tomorrow", label: message("properties.tomorrow"), value: addDays(today, 1) },
    { id: "next-week", label: message("properties.nextWeek"), value: addDays(today, 7) },
  ];
  const disabled = readonly || busy;
  const repeatChange = repeatChanged ? (repeat ? formatRepeat(repeat) : null) : undefined;

  useEffect(() => {
    if (time === null) return;
    const frame = requestAnimationFrame(() => {
      timeControlsRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [time]);

  const selectParsed = () => {
    if (!parsed) return;
    setDate(parsed.date);
    if (parsed.time) {
      setTime(parsed.time);
      setRememberedTime(parsed.time);
    }
    setQuery("");
  };

  const applyParsed = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !parsed || disabled) return;
    event.preventDefault();
    onApply(parsed.date, parsed.time ?? time, repeatChange);
  };

  const setTimeValue = (value: Time | null) => {
    if (!value) return;
    const nextTime = `${pad(value.hour)}:${pad(value.minute)}`;
    setTime(nextTime);
    setRememberedTime(nextTime);
  };

  const setRepeatValue = (value: RepeatInterval | null) => {
    setRepeat(value);
    setRepeatChanged(true);
  };

  const movePane = (
    event: KeyboardEvent<HTMLButtonElement>,
    nextPane: "date" | "rules",
  ) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setActivePane(nextPane);
    requestAnimationFrame(() =>
      document.getElementById(`${paneId}-${nextPane}-tab`)?.focus({ preventScroll: true }));
  };

  return (
    <I18nProvider locale={locale}>
      <div
        className="moment-picker"
        data-active-pane={activePane}
        data-testid="moment-picker"
      >
        <div className="moment-picker-body">
          <div className="moment-search-block">
            <div className="moment-search">
              <SearchIcon aria-hidden />
              <Input
                className="!ps-10"
                autoFocus
                aria-label={message("task.momentSearch")}
                placeholder={message("task.momentPlaceholder")}
                value={query}
                readOnly={disabled}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={applyParsed}
              />
            </div>

            {query.trim() && parsed && (
              <button
                type="button"
                className="moment-search-result"
                disabled={disabled}
                data-testid="moment-search-result"
                onClick={selectParsed}
              >
                <CalendarIcon aria-hidden />
                <span>{formatJournalDate(parsed.date)}</span>
                {parsed.time && <strong>{formatTimeOfDay(parsed.time)}</strong>}
              </button>
            )}
          </div>

          <div className="moment-mobile-tabs" role="tablist">
            <button
              id={`${paneId}-date-tab`}
              type="button"
              role="tab"
              aria-controls={`${paneId}-date-pane`}
              aria-selected={activePane === "date"}
              data-testid="moment-tab-date"
              tabIndex={activePane === "date" ? 0 : -1}
              onClick={() => setActivePane("date")}
              onKeyDown={(event) => movePane(event, "rules")}
            >
              {message("properties.type.date")}
            </button>
            <button
              id={`${paneId}-rules-tab`}
              type="button"
              role="tab"
              aria-controls={`${paneId}-rules-pane`}
              aria-selected={activePane === "rules"}
              data-testid="moment-tab-rules"
              tabIndex={activePane === "rules" ? 0 : -1}
              onClick={() => setActivePane("rules")}
              onKeyDown={(event) => movePane(event, "date")}
            >
              {message("task.timeOfDay")} · {message("task.repeat")}
            </button>
          </div>

          <div className="moment-picker-columns">
            <section
              id={`${paneId}-date-pane`}
              className="moment-date-pane"
              role="tabpanel"
              aria-labelledby={`${paneId}-date-tab`}
              data-testid="moment-pane-date"
            >
              <div className="moment-quick">
                {quick.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="moment-quick-chip"
                    aria-pressed={date === item.value}
                    disabled={disabled}
                    onClick={() => {
                      setDate(item.value);
                      setQuery("");
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <Calendar
                aria-label={message("properties.pickDate")}
                className="moment-calendar"
                value={calendarDate}
                defaultFocusedValue={calendarDate}
                firstDayOfWeek="mon"
                isDisabled={disabled}
                onChange={(value) => {
                  setDate(value.toString());
                  setQuery("");
                }}
              >
                <header className="moment-calendar-head">
                  <AriaButton slot="previous" className="moment-calendar-nav">
                    <ChevronLeftIcon aria-hidden />
                  </AriaButton>
                  <Heading className="moment-calendar-title" />
                  <AriaButton slot="next" className="moment-calendar-nav">
                    <ChevronRightIcon aria-hidden />
                  </AriaButton>
                </header>
                <CalendarGrid className="moment-calendar-grid" weekdayStyle="short">
                  <CalendarGridHeader>
                    {(day) => (
                      <CalendarHeaderCell className="moment-calendar-weekday">
                        {day}
                      </CalendarHeaderCell>
                    )}
                  </CalendarGridHeader>
                  <CalendarGridBody>
                    {(value) => <CalendarCell date={value} className="moment-calendar-cell" />}
                  </CalendarGridBody>
                </CalendarGrid>
              </Calendar>
            </section>

            <section
              id={`${paneId}-rules-pane`}
              className="moment-rules-pane"
              role="tabpanel"
              aria-labelledby={`${paneId}-rules-tab`}
              data-testid="moment-pane-rules"
            >
              <div className="moment-rule-section">
                <Switch
                  className="moment-time-switch"
                  data-testid="moment-time-toggle"
                  isSelected={time !== null}
                  isDisabled={disabled}
                  onChange={(selected) => setTime(selected ? rememberedTime : null)}
                >
                  <span>{time === null ? message("task.addTime") : message("task.timeOfDay")}</span>
                  <span className="moment-switch-track" aria-hidden>
                    <span />
                  </span>
                </Switch>
                {time !== null && (
                  <div ref={timeControlsRef} className="moment-time-controls">
                    <ClockIcon aria-hidden />
                    <TimeField
                      aria-label={message("task.timeOfDay")}
                      className="moment-time-field"
                      value={parseTime(time)}
                      granularity="minute"
                      hourCycle={24}
                      isDisabled={disabled}
                      onChange={setTimeValue}
                    >
                      <DateInput className="moment-time-input">
                        {(segment) => (
                          <DateSegment
                            segment={segment}
                            className={segment.type === "literal"
                              ? "moment-time-segment moment-time-literal"
                              : "moment-time-segment"}
                          />
                        )}
                      </DateInput>
                    </TimeField>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => {
                        const nextTime = nowLocalTime();
                        setTime(nextTime);
                        setRememberedTime(nextTime);
                      }}
                    >
                      {message("task.useCurrentTime")}
                    </Button>
                  </div>
                )}
              </div>

              <div className="moment-rule-section moment-repeat">
                <Switch
                  className="moment-time-switch"
                  data-testid="moment-repeat-toggle"
                  isSelected={repeat !== null}
                  isDisabled={disabled}
                  onChange={(selected) => setRepeatValue(selected ? DEFAULT_REPEAT : null)}
                >
                  <span>{message("task.repeat")}</span>
                  <span className="moment-switch-track" aria-hidden>
                    <span />
                  </span>
                </Switch>
                {repeat !== null && (
                  <div className="moment-repeat-controls">
                    <RepeatIcon aria-hidden />
                    <Input
                      type="number"
                      min={1}
                      max={999}
                      inputMode="numeric"
                      aria-label={message("task.repeatCount")}
                      data-testid="moment-repeat-count"
                      value={String(repeat.count)}
                      readOnly={disabled}
                      onChange={(event) => {
                        const count = Number(event.target.value);
                        if (Number.isInteger(count) && count >= 1 && count <= 999) {
                          setRepeatValue({ ...repeat, count });
                        }
                      }}
                    />
                    <MenuSelect
                      className="moment-repeat-unit"
                      label={message("task.repeatUnitLabel")}
                      testId="moment-repeat-unit"
                      value={repeat.unit}
                      disabled={disabled}
                      options={REPEAT_UNITS.map((unit) => ({
                        value: unit,
                        label: repeatUnitLabel(unit, message),
                      }))}
                      onValueChange={(unit) =>
                        setRepeatValue({ ...repeat, unit: unit as RepeatUnit })}
                    />
                    <p className="moment-repeat-preview">{repeatLabel(repeat, message)}</p>
                  </div>
                )}
              </div>

              {repeat !== null && (
                <div className="moment-next-occurrence" aria-live="polite">
                  {message("task.repeatRolled", {
                    date: formatJournalDate(advanceDate(date, repeat)),
                  })}
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="moment-footer">
          <div className="moment-preview" aria-live="polite">
            <CalendarIcon aria-hidden />
            <span>{formatJournalDate(date)}</span>
            {time !== null && (
              <>
                <span aria-hidden>·</span>
                <strong>{formatTimeOfDay(time)}</strong>
              </>
            )}
            {repeat !== null && (
              <>
                <span aria-hidden>·</span>
                <strong className="moment-preview-repeat">{repeatLabel(repeat, message)}</strong>
              </>
            )}
          </div>
          <div className="moment-actions">
            {hasValue && (
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={message("properties.clear")}
                data-testid="moment-clear"
                onClick={onClear}
              >
                <Trash2Icon aria-hidden />
                {message("properties.clear")}
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              {message("common.cancel")}
            </Button>
            <Button
              disabled={disabled}
              data-testid="moment-apply"
              onClick={() => onApply(date, time, repeatChange)}
            >
              {message("common.done")}
            </Button>
          </div>
        </div>
      </div>
    </I18nProvider>
  );
}
