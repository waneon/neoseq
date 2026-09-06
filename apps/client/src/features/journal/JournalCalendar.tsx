import { useId, useRef, useState, type RefObject } from "react";
import { parseDate } from "@internationalized/date";
import { CalendarIcon, XIcon } from "lucide-react";
import { isValidLocalDate } from "@/entities/calendar";
import { useI18n } from "@/i18n";
import { elementAnchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { DateCalendar } from "@/ui/DateCalendar";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";

export function JournalCalendar({
  date,
  today,
  onSelect,
  trigger,
}: {
  trigger: RefObject<HTMLButtonElement | null>;
  date: string;
  today: string;
  onSelect: (date: string) => void;
}) {
  const { message } = useI18n();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(date);
  const [focusedDate, setFocusedDate] = useState(() => parseDate(date));
  const choose = (value: string) => {
    setOpen(false);
    onSelect(value);
  };

  return (
    <>
      <Button
        ref={trigger}
        size="icon"
        aria-label={message("journal.calendarOpen")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid="journal-calendar-trigger"
        data-date={date}
        onClick={() => {
          setDraft(date);
          setFocusedDate(parseDate(date));
          setOpen(!open);
        }}
      >
        <CalendarIcon aria-hidden />
      </Button>
      {open && trigger.current && (
        <AnchoredPanel
          id={id}
          anchor={elementAnchor(trigger.current)}
          label={message("journal.jumpToDate")}
          className="panel journal-calendar"
          options={{ width: 320 }}
          initialFocus={() => input.current}
          trapFocus
          dismissOnExternalScroll
          onClose={() => setOpen(false)}
        >
          <div className="journal-calendar-heading">
            <span>{message("journal.jumpToDate")}</span>
            <Button size="icon" aria-label={message("common.close")} onClick={() => setOpen(false)}>
              <XIcon aria-hidden />
            </Button>
          </div>
          <form
            className="journal-calendar-jump"
            onSubmit={(event) => {
              event.preventDefault();
              if (isValidLocalDate(draft)) choose(draft);
            }}
          >
            <Input
              ref={input}
              type="date"
              min="0001-01-01"
              max="9999-12-31"
              required
              aria-label={message("journal.jumpToDate")}
              data-testid="journal-date"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault();
              }}
            />
            <Button type="submit" variant="secondary" disabled={!isValidLocalDate(draft)}>
              {message("journal.goToDate")}
            </Button>
          </form>
          <DateCalendar
            value={parseDate(date)}
            focusedValue={focusedDate}
            onFocusChange={setFocusedDate}
            onChange={(value) => choose(value.toString())}
          />
          <Button variant="ghost" onClick={() => choose(today)}>
            {message("journal.today")}
          </Button>
        </AnchoredPanel>
      )}
    </>
  );
}
