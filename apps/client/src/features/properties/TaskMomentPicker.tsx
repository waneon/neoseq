import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { parseDate, parseTime, Time, type CalendarDate } from "@internationalized/date";
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
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  RepeatIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { nowLocalTime, todayLocalDate } from "../../entities/journal";
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
  clearLabel: string;
  onApply: (date: string, time: string | null, repeat: string | null | undefined) => void;
  onClear: () => void;
  onCancel: () => void;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

interface AdjacentMonthCellProps {
  date: CalendarDate;
  disabled: boolean;
  label: string;
  today: string;
  onSelect: (date: CalendarDate) => void;
}

/**
 * React Aria deliberately disables dates outside a calendar's visible month.
 * Active-month cells retain its roving keyboard model, while these explicit
 * buttons make the adjacent dates that are already visible honest pointer
 * targets. Arrow keys still cross the same month boundary through React Aria.
 */
function AdjacentMonthCell({
  date,
  disabled,
  label,
  today,
  onSelect,
}: AdjacentMonthCellProps) {
  return (
    <td role="gridcell" aria-selected={false}>
      <button
        type="button"
        className="moment-calendar-cell"
        aria-label={label}
        data-disabled={disabled || undefined}
        data-outside-month
        data-today={date.toString() === today || undefined}
        disabled={disabled}
        tabIndex={-1}
        onClick={() => onSelect(date)}
      >
        {date.day}
      </button>
    </td>
  );
}

/**
 * A task moment is one local draft: day, optional clock, and task cadence.
 * Every route edits that draft; only Done persists it. This keeps natural
 * language, pointer, and keyboard changes inside one undo boundary.
 */
export function TaskMomentPicker({
  date: initialDate,
  time: initialTime,
  repeat: initialRepeat,
  hasValue,
  readonly,
  busy,
  clearLabel,
  onApply,
  onClear,
  onCancel,
}: TaskMomentPickerProps) {
  const { locale, message, formatJournalDate } = useI18n();
  const today = todayLocalDate();
  const [date, setDate] = useState(initialDate);
  const [focusedDate, setFocusedDate] = useState(() => parseDate(initialDate));
  const [time, setTime] = useState<string | null>(initialTime ?? null);
  const [rememberedTime, setRememberedTime] = useState(initialTime ?? "09:00");
  const [repeat, setRepeat] = useState<RepeatInterval | null>(() =>
    initialRepeat ? parseRepeat(initialRepeat) : null);
  const [rememberedRepeat, setRememberedRepeat] = useState<RepeatInterval>(() =>
    (initialRepeat ? parseRepeat(initialRepeat) : null) ?? DEFAULT_REPEAT);
  const [repeatChanged, setRepeatChanged] = useState(false);
  const [activePane, setActivePane] = useState<"date" | "rules">("date");
  const [query, setQuery] = useState("");
  const paneId = useId();
  const parsed = useMemo(
    () => parseMomentQuery(query, today, locale),
    [locale, query, today],
  );
  const calendarDate = parseDate(date);
  const disabled = readonly || busy;
  const repeatChange = repeatChanged ? (repeat ? formatRepeat(repeat) : null) : undefined;
  const repeatDraft = repeat ?? rememberedRepeat;

  const chooseDate = (value: CalendarDate) => {
    setDate(value.toString());
    setFocusedDate(value);
    setQuery("");
  };

  const selectParsed = () => {
    if (!parsed) return;
    const nextDate = parseDate(parsed.date);
    setDate(parsed.date);
    setFocusedDate(nextDate);
    if (parsed.time) {
      setTime(parsed.time);
      setRememberedTime(parsed.time);
    }
    setQuery("");
  };

  const applyParsed = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || !parsed || disabled) return;
    event.preventDefault();
    selectParsed();
  };

  const setTimeValue = (value: Time | null) => {
    if (!value) return;
    const nextTime = `${pad(value.hour)}:${pad(value.minute)}`;
    setTime(nextTime);
    setRememberedTime(nextTime);
  };

  const setRepeatValue = (value: RepeatInterval | null) => {
    if (value) setRememberedRepeat(value);
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

              <Calendar
                aria-label={message("properties.pickDate")}
                className="moment-calendar"
                value={calendarDate}
                focusedValue={focusedDate}
                firstDayOfWeek="mon"
                isDisabled={disabled}
                onChange={chooseDate}
                onFocusChange={setFocusedDate}
              >
                {({ state }) => (
                  <>
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
                        {(value) => {
                          const visibleMonth = state.visibleRange.start;
                          const outsideMonth = value.year !== visibleMonth.year
                            || value.month !== visibleMonth.month;
                          return outsideMonth
                            ? (
                                <AdjacentMonthCell
                                  date={value}
                                  disabled={disabled}
                                  label={formatJournalDate(value.toString())}
                                  today={today}
                                  onSelect={chooseDate}
                                />
                              )
                            : <CalendarCell date={value} className="moment-calendar-cell" />;
                        }}
                      </CalendarGridBody>
                    </CalendarGrid>
                  </>
                )}
              </Calendar>
            </section>

            <section
              id={`${paneId}-rules-pane`}
              className="moment-rules-pane"
              role="tabpanel"
              aria-labelledby={`${paneId}-rules-tab`}
              data-testid="moment-pane-rules"
            >
              <div className="moment-rule-section" data-enabled={time !== null}>
                <Switch
                  className="moment-time-switch"
                  data-testid="moment-time-toggle"
                  isSelected={time !== null}
                  isDisabled={disabled}
                  onChange={(selected) => {
                    if (selected) {
                      setTime(rememberedTime);
                    } else {
                      if (time) setRememberedTime(time);
                      setTime(null);
                    }
                  }}
                >
                  <span>{message("task.timeOfDay")}</span>
                  <span className="moment-switch-track" aria-hidden>
                    <span />
                  </span>
                </Switch>
                <div className="moment-time-controls">
                  <ClockIcon aria-hidden />
                  <TimeField
                    aria-label={message("task.timeOfDay")}
                    className="moment-time-field"
                    value={parseTime(time ?? rememberedTime)}
                    granularity="minute"
                    hourCycle={24}
                    isDisabled={disabled || time === null}
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
                    disabled={disabled || time === null}
                    onClick={() => {
                      const nextTime = nowLocalTime();
                      setTime(nextTime);
                      setRememberedTime(nextTime);
                    }}
                  >
                    {message("task.useCurrentTime")}
                  </Button>
                </div>
              </div>

              <div className="moment-rule-section moment-repeat" data-enabled={repeat !== null}>
                <Switch
                  className="moment-time-switch"
                  data-testid="moment-repeat-toggle"
                  isSelected={repeat !== null}
                  isDisabled={disabled}
                  onChange={(selected) => setRepeatValue(selected ? rememberedRepeat : null)}
                >
                  <span>{message("task.repeat")}</span>
                  <span className="moment-switch-track" aria-hidden>
                    <span />
                  </span>
                </Switch>
                <div className="moment-repeat-controls">
                  <RepeatIcon aria-hidden />
                  <Input
                    type="number"
                    min={1}
                    max={999}
                    inputMode="numeric"
                    aria-label={message("task.repeatCount")}
                    data-testid="moment-repeat-count"
                    value={String(repeatDraft.count)}
                    disabled={disabled || repeat === null}
                    onChange={(event) => {
                      const count = Number(event.target.value);
                      if (Number.isInteger(count) && count >= 1 && count <= 999) {
                        setRepeatValue({ ...repeatDraft, count });
                      }
                    }}
                  />
                  <MenuSelect
                    className="moment-repeat-unit"
                    label={message("task.repeatUnitLabel")}
                    testId="moment-repeat-unit"
                    value={repeatDraft.unit}
                    disabled={disabled || repeat === null}
                    options={REPEAT_UNITS.map((unit) => ({
                      value: unit,
                      label: repeatUnitLabel(unit, message),
                    }))}
                    onValueChange={(unit) =>
                      setRepeatValue({ ...repeatDraft, unit: unit as RepeatUnit })}
                  />
                  <p className="moment-repeat-preview">
                    <span>{repeatLabel(repeatDraft, message)}</span>
                    <span>{message("task.repeatNext", {
                      date: formatJournalDate(advanceDate(date, repeatDraft)),
                    })}</span>
                  </p>
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className="moment-footer">
          {hasValue && (
            <Button
              className="moment-clear"
              variant="ghost"
              disabled={disabled}
              data-testid="moment-clear"
              onClick={onClear}
            >
              <Trash2Icon aria-hidden />
              {clearLabel}
            </Button>
          )}
          <div className="moment-actions">
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
