// The order the reader put the rows in.
//
// A result's order is a **list**, not a column. *By status, then by date* is one
// of the most ordinary things to want from a table, and a header that holds one
// order at a time makes the reader give up their first choice to express their
// second. So a header click cycles its own column — ascending, descending, gone —
// and leaves the other terms standing.
//
// A list has precedence, and precedence has to be visible and movable or the
// second term is a guess. That is what this panel is for: the terms in order,
// each with its direction and its place in the queue. Moving is two buttons
// rather than a drag, because a drag is not reachable from a keyboard and this
// list is never longer than a few rows.

import { useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { createPortal } from "react-dom";
import { MenuSelect } from "@/ui/menu-select";
import { useAnchoredPosition } from "@/ui/anchored";
import type { QueryViewSort } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import type { ResultColumn } from "./cells";

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
  columns,
  sorts,
  onChange,
}: {
  columns: ResultColumn[];
  sorts: QueryViewSort[];
  onChange: (sorts: QueryViewSort[]) => void;
}) {
  const { message } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel grows a row per term, so it re-places when the list does.
  const position = useAnchoredPosition(
    open ? triggerRef.current : null,
    { width: 300, maxHeight: 360 },
    sorts.length,
  );

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (!(node instanceof Node)) return;
      if (panelRef.current?.contains(node) || triggerRef.current?.contains(node)) return;
      // A dropdown this panel opened is not outside it: the one dropdown
      // (§ Choice) portals to the body, so a press on one of its rows lands
      // outside `panelRef` in the DOM while being, to the reader, a press inside
      // the editor they are filling in.
      if (node instanceof Element && node.closest('[data-slot="dropdown-menu-content"]')) return;
      setOpen(false);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", closeOnOutsidePress, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      panelRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]),[role=\"button\"]",
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  const nameOf = (variable: string) =>
    columns.find((column) => column.variable === variable)?.label ?? `?${variable}`;

  const remaining = columns.filter(
    (column) => !sorts.some((sort) => sort.variable === column.variable),
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
        // The trigger carries the state, so a sorted table says so without
        // being opened — the same way the view control shows which view is on.
        data-sorted={sorts.length > 0 || undefined}
        data-testid="query-sort-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <ArrowUpDownIcon aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className="query-sort-panel"
          style={position}
          role="dialog"
          aria-label={message("query.sortOrder")}
          data-testid="query-sort-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key !== "Tab") return;
            const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
              "button:not([disabled])",
            );
            if (!focusable || focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <p className="group-label">{message("query.sortOrder")}</p>
          {sorts.length === 0 && (
            <p className="query-sort-empty">{message("query.sortEmpty")}</p>
          )}
          {sorts.length > 0 && (
            <ol className="query-sort-list">
              {sorts.map((sort, index) => (
                <li key={sort.variable} className="query-sort-row">
                  {/* Precedence, stated. A rank only means something once there
                      is a second term for it to come before. */}
                  {sorts.length > 1 && <span className="query-sort-rank">{index + 1}</span>}
                  <span className="query-sort-name">{nameOf(sort.variable)}</span>
                  <MenuSelect
                    className="query-sort-direction"
                    value={sort.descending ? "desc" : "asc"}
                    label={message("query.sortDirectionOf", { column: nameOf(sort.variable) })}
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
                    aria-label={message("query.moveSortUp", { column: nameOf(sort.variable) })}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={index === sorts.length - 1}
                    aria-label={message("query.moveSortDown", { column: nameOf(sort.variable) })}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={message("query.removeSort", { column: nameOf(sort.variable) })}
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
                options={remaining.map((column) => ({
                  value: column.variable,
                  label: column.label,
                }))}
                onValueChange={(variable) =>
                  onChange([...sorts, { variable, descending: false }])}
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
        </div>,
        document.body,
      )}
    </>
  );
}
