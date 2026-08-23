// What a table shows.
//
// **A column is a switch, not two of them.** Everything the subject could be
// asked for is one list — its own fields, then the graph's vocabulary, then the
// one column that is a summary rather than a field — and each line is on or off.
// Turning one on puts it in the query and in this table; turning it off takes it
// out of this table, and out of the query too unless another view still asks for
// it. One gesture, one meaning, in both the ordinary case where a query has a
// single table and the case where it has four.
//
// **It belongs to the answer, not to the question.** Which columns a table shows
// is changed while reading it, next to the order it is read in — not by opening
// the editor that says what the query *looks for*. A `Show` row in the builder
// stated the same thing one surface away from where it is used, and stated it
// once for renderers that do not agree: a list of blocks draws the block, so it
// takes every column the query returns and this control never appears over one.
//
// Order and width are the heading's (`QueryTableView`): a column is dragged where
// it belongs, and this list stays in the order the product offers its fields, so
// the same field is always in the same place in it.

import { useMemo, useRef, useState } from "react";
import { Columns3Icon, SearchIcon } from "lucide-react";
import { MenuSelect } from "@/ui/menu-select";
import { AnchoredPanel } from "@/ui/anchored-panel";
import {
  aggregatesFor,
  columnSourceKey,
  type PlanAggregate,
  type PlanColumn,
  type PlanColumnSource,
  type PlanSubject,
} from "../../entities/query-plan";
import { useI18n, type MessageFunction } from "../../i18n";
import { aggregateLabel, columnSourceLabel } from "./labels";

/** Below this many choices the list is read at a glance and a filter is noise. */
const SEARCH_FLOOR = 10;

export interface ColumnChoice {
  key: string;
  source: PlanColumnSource;
  label: string;
  /** The plan's column for this source, when the query already selects it. */
  column: PlanColumn | null;
  /** Whether this table shows it. */
  shown: boolean;
}

/**
 * Every column this table could show, told apart by what it already shows. The
 * offer order is the product's; the plan's own order is the table's, and the
 * heading owns that.
 *
 * A column the query selects always has a line here even when the graph no
 * longer offers its field — the last block carrying a property can be deleted
 * while a query still reads it, and a switch that vanished on would leave the
 * column with no way off.
 */
export function columnChoices(
  sources: PlanColumnSource[],
  columns: PlanColumn[],
  hidden: ReadonlySet<string>,
  subject: PlanSubject,
  message: MessageFunction,
): ColumnChoice[] {
  const selected = new Map(columns.map((column) => [columnSourceKey(column.source), column]));
  const offered = new Set(sources.map(columnSourceKey));
  const orphans = columns
    .filter((column) => !offered.has(columnSourceKey(column.source)))
    .map((column) => column.source);
  return [...sources, ...orphans].map((source) => {
    const key = columnSourceKey(source);
    const column = selected.get(key) ?? null;
    return {
      key,
      source,
      label: columnSourceLabel(source, subject, message),
      column,
      shown: column !== null && !hidden.has(key),
    };
  });
}

export function QueryColumnsControl({
  choices,
  onToggle,
  onAggregate,
}: {
  choices: ColumnChoice[];
  onToggle: (choice: ColumnChoice, shown: boolean) => void;
  onAggregate: (choice: ColumnChoice, aggregate: PlanAggregate | undefined) => void;
}) {
  const { message } = useI18n();
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

  const searchable = choices.length >= SEARCH_FLOOR;
  // The same fold the property picker filters by, because these are the same
  // names read in the same breath.
  const matches = useMemo(() => {
    const trimmed = needle.trim().toLocaleLowerCase();
    if (!trimmed) return choices;
    return choices.filter((choice) => choice.label.toLocaleLowerCase().includes(trimmed));
  }, [choices, needle]);
  // A table with nothing in it is not a table, so the last column standing is
  // not a switch the reader can throw.
  const only = choices.filter((choice) => choice.shown).length <= 1;

  // A filter is a way of reaching one line, not a setting. Kept across a close it
  // would reopen the panel on three of fifteen fields with nothing on screen
  // saying why the rest are missing.
  const close = () => {
    setOpen(false);
    setNeedle("");
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={message("query.columns")}
        aria-expanded={open}
        data-testid="query-columns-trigger"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Columns3Icon aria-hidden />
      </button>
      {open && (
        <AnchoredPanel
          anchor={triggerRef.current}
          className="query-columns-panel"
          label={message("query.columns")}
          options={{ width: 268, maxHeight: 380 }}
          revision={matches.length}
          testId="query-columns-panel"
          onClose={close}
        >
          <p className="group-label">{message("query.columns")}</p>
          {searchable && (
            <div className="query-columns-search">
              <SearchIcon aria-hidden />
              <input
                type="text"
                value={needle}
                placeholder={message("query.findColumn")}
                aria-label={message("query.findColumn")}
                data-testid="query-columns-search"
                onChange={(event) => setNeedle(event.target.value)}
              />
            </div>
          )}
          {matches.length === 0 ? (
            <p className="query-columns-empty">{message("query.noColumnMatches")}</p>
          ) : (
            <ul className="query-columns-list">
              {matches.map((choice) => (
                <ColumnRow
                  key={choice.key}
                  choice={choice}
                  locked={choice.shown && only}
                  onToggle={onToggle}
                  onAggregate={onAggregate}
                />
              ))}
            </ul>
          )}
        </AnchoredPanel>
      )}
    </>
  );
}

function ColumnRow({
  choice,
  locked,
  onToggle,
  onAggregate,
}: {
  choice: ColumnChoice;
  locked: boolean;
  onToggle: (choice: ColumnChoice, shown: boolean) => void;
  onAggregate: (choice: ColumnChoice, aggregate: PlanAggregate | undefined) => void;
}) {
  const { message } = useI18n();
  const aggregates = aggregatesFor(choice.source);
  // How a column arrives — each value, or folded into one — is a property of the
  // column and is asked only of a column that is actually there. A summary the
  // reader cannot see is a question about nothing.
  const summarizable = choice.shown && choice.column !== null && aggregates.length > 0;

  return (
    <li
      className="query-columns-row"
      data-shown={choice.shown || undefined}
      data-summarized={choice.column?.aggregate ? "" : undefined}
    >
      <label className="query-columns-toggle">
        <input
          type="checkbox"
          checked={choice.shown}
          disabled={locked}
          data-testid={`query-column-toggle-${choice.key}`}
          onChange={(event) => onToggle(choice, event.target.checked)}
        />
        <span className="query-columns-name">{choice.label}</span>
      </label>
      {summarizable && (
        <MenuSelect
          className="query-columns-aggregate"
          value={choice.column?.aggregate ?? ""}
          label={message("query.columnMode", { column: choice.label })}
          options={[
            // A subject column has no plain reading — see `decodePlan`.
            ...(choice.source.kind === "subject"
              ? []
              : [{ value: "", label: message("query.aggregate.none") }]),
            ...aggregates.map((aggregate) => ({
              value: aggregate,
              label: aggregateLabel(aggregate, message),
            })),
          ]}
          onValueChange={(value) =>
            onAggregate(choice, (value || undefined) as PlanAggregate | undefined)}
        />
      )}
    </li>
  );
}
