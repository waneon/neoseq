import { parseDate, type CalendarDate } from "@internationalized/date";
import {
  Button as AriaButton,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  Heading,
  I18nProvider,
} from "react-aria-components";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { isValidLocalDate } from "@/entities/calendar";
import { todayLocalDate } from "@/entities/journal";
import { useI18n } from "@/i18n";

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
function AdjacentMonthCell({ date, disabled, label, today, onSelect }: AdjacentMonthCellProps) {
  return (
    <td role="gridcell" aria-selected={false}>
      <button
        type="button"
        className="date-calendar-cell"
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

/** One day-selection model for journal navigation and task dates. */
export function DateCalendar({
  value,
  focusedValue,
  disabled = false,
  onChange,
  onFocusChange,
}: {
  value: CalendarDate;
  focusedValue: CalendarDate;
  disabled?: boolean;
  onChange: (date: CalendarDate) => void;
  onFocusChange: (date: CalendarDate) => void;
}) {
  const { locale, message, formatJournalDate } = useI18n();
  const today = todayLocalDate();
  return (
    <I18nProvider locale={locale}>
      <Calendar
        aria-label={message("properties.pickDate")}
        className="date-calendar"
        value={value}
        focusedValue={focusedValue}
        firstDayOfWeek="mon"
        minValue={parseDate("0001-01-01")}
        maxValue={parseDate("9999-12-31")}
        isDisabled={disabled}
        onChange={onChange}
        onFocusChange={onFocusChange}
      >
        {({ state }) => (
          <>
            <header className="date-calendar-head">
              <AriaButton slot="previous" className="date-calendar-nav">
                <ChevronLeftIcon aria-hidden />
              </AriaButton>
              <Heading className="date-calendar-title" />
              <AriaButton slot="next" className="date-calendar-nav">
                <ChevronRightIcon aria-hidden />
              </AriaButton>
            </header>
            <div className="date-calendar-month">
              <CalendarGrid className="date-calendar-grid" weekdayStyle="short">
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell className="date-calendar-weekday">{day}</CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(value) => {
                    if (!isValidLocalDate(value.toString())) {
                      return <td role="gridcell" aria-disabled="true" />;
                    }
                    const visibleMonth = state.visibleRange.start;
                    const outsideMonth =
                      value.year !== visibleMonth.year || value.month !== visibleMonth.month;
                    return outsideMonth ? (
                      <AdjacentMonthCell
                        date={value}
                        disabled={disabled}
                        label={formatJournalDate(value.toString())}
                        today={today}
                        onSelect={onChange}
                      />
                    ) : (
                      <CalendarCell date={value} className="date-calendar-cell" />
                    );
                  }}
                </CalendarGridBody>
              </CalendarGrid>
            </div>
          </>
        )}
      </Calendar>
    </I18nProvider>
  );
}
