// The order the reader put the rows in.
//
// A result's order is a **list**, not one field. *By status, then by date* is one
// of the most ordinary things to want, so adding a second term must not replace
// the first. Table headers additionally cycle their own column — ascending,
// descending, gone — and leave the other terms standing.
//
// A list has precedence, and precedence has to be visible and movable or the
// second term is a guess. That is what this panel is for: the terms in order,
// each with its direction and its place in the queue. Moving is two buttons
// rather than a drag, because a drag is not reachable from a keyboard and this
// list is never longer than a few rows.

import { useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { MenuSelect } from "@/ui/menu-select";
import { AnchoredPanel } from "@/ui/anchored-panel";
import type { QueryViewSort } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";

export interface SortControlOption {
  key: string;
  label: string;
}

export interface SortControlEntry {
  key: string;
  descending: boolean;
}

/** As many terms as the domain will store for one view. */
export const SORT_LIMIT = 8;

/**
 * The next order after a header press: a column joins the end of the list
 * ascending, flips to descending, then leaves. Every other term keeps its place,
 * which is what makes a second header press an addition rather than a reset.
 */
export function cycleSort(sorts: QueryViewSort[], variable: string): QueryViewSort[] {
  const index = sorts.findIndex((sort) => sort.variable === variable);
  if (index < 0) {
    if (sorts.length >= SORT_LIMIT) return sorts;
    return [...sorts, { variable, descending: false }];
  }
  if (!sorts[index].descending) {
    return sorts.map((sort, at) => (at === index ? { variable, descending: true } : sort));
  }
  return sorts.filter((_, at) => at !== index);
}

export function QuerySortControl({
  options,
  sorts,
  onChange,
}: {
  options: SortControlOption[];
  sorts: SortControlEntry[];
  onChange: (sorts: SortControlEntry[]) => void;
}) {
  const { message } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const nameOf = (key: string) =>
    options.find((option) => option.key === key)?.label ?? key;

  const remaining = options.filter(
    (option) => !sorts.some((sort) => sort.key === option.key),
  );

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= sorts.length) return;
    const next = [...sorts];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label={message("query.sortOrder")}
        aria-expanded={open}
        // The trigger carries the state, so an ordered result says so without
        // being opened — the same way the view control shows which view is on.
        data-sorted={sorts.length > 0 || undefined}
        data-testid="query-sort-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowUpDownIcon aria-hidden />
      </button>
      {open && (
        <AnchoredPanel
          anchor={triggerRef.current}
          className="query-sort-panel"
          label={message("query.sortOrder")}
          // The panel grows a row per term, so it re-places when the list does.
          options={{ width: 300, maxHeight: 360 }}
          revision={sorts.length}
          testId="query-sort-panel"
          onClose={() => setOpen(false)}
        >
          <p className="group-label">{message("query.sortOrder")}</p>
          {sorts.length === 0 && (
            <p className="query-sort-empty">{message("query.sortEmpty")}</p>
          )}
          {sorts.length > 0 && (
            <ol className="query-sort-list">
              {sorts.map((sort, index) => (
                <li key={sort.key} className="query-sort-row">
                  {/* Precedence, stated. A rank only means something once there
                      is a second term for it to come before. */}
                  {sorts.length > 1 && <span className="query-sort-rank">{index + 1}</span>}
                  <span className="query-sort-name">{nameOf(sort.key)}</span>
                  <MenuSelect
                    className="query-sort-direction"
                    value={sort.descending ? "desc" : "asc"}
                    label={message("query.sortDirectionOf", { column: nameOf(sort.key) })}
                    options={[
                      { value: "asc", label: message("query.ascending") },
                      { value: "desc", label: message("query.descending") },
                    ]}
                    onValueChange={(value) =>
                      onChange(sorts.map((entry, at) =>
                        at === index ? { ...entry, descending: value === "desc" } : entry))}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={index === 0}
                    aria-label={message("query.moveSortUp", { column: nameOf(sort.key) })}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={index === sorts.length - 1}
                    aria-label={message("query.moveSortDown", { column: nameOf(sort.key) })}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={message("query.removeSort", { column: nameOf(sort.key) })}
                    onClick={() => onChange(sorts.filter((_, at) => at !== index))}
                  >
                    <XIcon aria-hidden />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="query-sort-actions">
            {remaining.length > 0 && sorts.length < SORT_LIMIT && (
              <MenuSelect
                className="query-sort-add"
                value=""
                label={message("query.addSort")}
                placeholder={message("query.addSort")}
                testId="query-sort-add"
                options={remaining.map((option) => ({
                  value: option.key,
                  label: option.label,
                }))}
                onValueChange={(key) =>
                  onChange([...sorts, { key, descending: false }])}
              />
            )}
            {sorts.length > 0 && (
              <button
                type="button"
                className="query-sort-clear"
                onClick={() => onChange([])}
              >
                {message("query.clearSort")}
              </button>
            )}
          </div>
        </AnchoredPanel>
      )}
    </>
  );
}
