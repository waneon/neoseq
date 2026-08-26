// The table view.
//
// Column order, width, visibility **and sort** are the reader's, and they persist
// in the saved view so the shape of a table survives a reload and reaches
// everyone on the graph. All four are presentation: they shape an answer that has
// already arrived, and the query's own order is the subject alone — the one thing
// a `LIMIT` has to cut against. A reader on a read-only graph can still sort;
// there is simply nowhere to write the choice, so the block holds it for as long
// as it is mounted.
//
// Which columns exist is not the table's: it is the query's, switched on and off
// from the header's columns panel (`QueryColumnsControl`), which writes the plan
// and this view's hidden flags in one gesture. What arrives here is what this
// view draws.
//
// **A column is dragged where it belongs.** Its heading is its handle, and a
// seam — the same accent rule the tag directory draws between rows, turned on its
// side — marks the gap it is about to occupy. Nothing reflows while the pointer
// travels; `Move left` / `Move right` in the heading's menu is the same move from
// a keyboard, and both hand back the running order rather than a swap.
//
// The order is a **list**. A header press cycles its own column and leaves the
// rest standing, so a second press adds a tie-breaker instead of discarding the
// first choice; each sorted heading states its rank once there is a second term
// for it to come before. The list itself — its precedence, and the buttons that
// move a term through it — lives in the header's sort panel.
//
// Widths are declared once, in a `<colgroup>`, on a `table-layout: fixed` table.
// That is the whole fix for a defect the auto table algorithm caused: `width` on
// a cell is only a *suggestion* to it, so dragging one column's handle made the
// browser redistribute the difference across every other column. A fixed table
// honours the declared width exactly, and a final `<col>` with no width absorbs
// whatever space is left over — which is also what lets the table exceed its
// container and scroll sideways instead of squeezing its columns.
//
// **A drag starts from the width on screen.** Until the reader takes the layout
// over the table declares no width at all, so there is nothing for a resize to
// begin at: the sizes a library would hand it are the fallbacks it was
// configured with, not the widths the fixed algorithm actually shared the block
// into. Beginning there made the first pixel of travel a collapse — the column
// in the reader's hand snapped to the fallback, and every other column snapped
// with it. So a resize measures the row it is about to change, and **taking one
// column over takes the table over**: every column is written at the width it
// was already drawn at, and only the dragged one changes. That is what keeps
// the layout still afterwards, and identical after a reload.
//
// The query projection owns row ordering, and TanStack Table owns the row and
// cell models. Widths are this file's, because the gesture that sets them has to
// start from the pixels on screen — and because the design system, not a
// library's stylesheet, decides what a row looks like.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronsLeftRightIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import {
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import type { QueryViewSort } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import { cycleSort, SORT_LIMIT } from "./QuerySortControl";
import {
  type CellContext,
  type ResultColumn,
  type ResultViewRow,
} from "./cells";
import { EditableCellValue, type QueryResultEditor } from "./edit";
import { QueryTableCellFrame } from "./QueryTableCell";

const MIN_WIDTH = 72;
const DEFAULT_WIDTH = 180;

/** One layout: what every column in it is drawn at. */
type Widths = Record<string, number>;

type ColumnDrag = {
  variable: string;
  /** The column the seam is drawn before, or `null` for the end of the row. */
  seamBefore?: string | null;
} | null;

// Only what this table asks a library for: the row and cell models, and whether
// a column may be ordered. Widths are this file's own, and visibility and column
// order are the saved view's — they persist in the graph, so they arrive here
// already applied in `columns`.
const FEATURES = tableFeatures({ rowSortingFeature });

export function QueryTableView({
  columns,
  rows,
  context,
  editor,
  pinnedRowKey,
  compact,
  wrap,
  sorts,
  onSort,
  onResize,
  onHide,
  onReorder,
  onMove,
}: {
  columns: ResultColumn[];
  rows: ResultViewRow[];
  context: CellContext;
  editor: QueryResultEditor;
  pinnedRowKey?: string;
  compact: boolean;
  wrap: boolean;
  /** The ordering terms in force, most significant first. */
  sorts: QueryViewSort[];
  /** Where a header press goes. Never absent: reading is never read-only. */
  onSort: (sorts: QueryViewSort[]) => void;
  /**
   * Persist the widths the reader now owns — the dragged column, and every other
   * column at the width it was already drawn at. `null` withdraws a column's
   * width. Resolves after the authoritative view reconciles.
   */
  onResize?: (widths: Record<string, number | null>) => Promise<boolean>;
  onHide?: (variable: string) => void;
  /** The columns in the order the reader just dragged them into. */
  onReorder?: (order: string[]) => void;
  onMove?: (variable: string, delta: -1 | 1) => void;
}) {
  const { message } = useI18n();
  const rankOf = (variable: string) => sorts.findIndex((sort) => sort.variable === variable);
  /**
   * The widths in the reader's hands: the layout under a live drag, and the one
   * waiting for its write to land. `null` while the saved view is the only truth
   * there is.
   */
  const [drafted, setDrafted] = useState<Widths | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  // Column identities and saved widths are the complete canonical sizing
  // boundary. Result rows and unrelated graph revisions may rebuild `columns`,
  // but they must not interrupt a live drag when those values did not change.
  const canonicalKey = JSON.stringify(columns.map((column) => [column.variable, column.width]));
  const canonicalKeyRef = useRef(canonicalKey);
  const resizeCommitPending = useRef(false);
  /** The heading row, which is the only place a width can be measured. */
  const head = useRef<HTMLTableSectionElement>(null);
  // A heading is two handles in one place: the whole of it moves the column, and
  // the nine pixels at its trailing edge size it. HTML drag claims a press
  // anywhere inside a draggable element, so the smaller, deliberate target lost
  // every time — the column travelled instead of widening. The separator's own
  // pointerdown runs first and says so, and `dragstart` stands down.
  const resizingFrom = useRef(false);
  const [drag, setDrag] = useState<ColumnDrag>(null);

  const definitions = useMemo<ColumnDef<typeof FEATURES, ResultViewRow, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.variable,
        accessorFn: (row: ResultViewRow) => row.values[column.variable],
        header: column.label,
        enableSorting: column.sortable,
      })),
    [columns],
  );

  const table = useTable({
    features: FEATURES,
    data: rows,
    columns: definitions,
    getRowId: (row) => row.key,
    // Rows already carry this table view's order. Widths are managed by the
    // measured draft above rather than TanStack's column-sizing state.
    enableMultiSort: true,
    maxMultiSortColCount: SORT_LIMIT,
  });

  const byVariable = new Map(columns.map((column) => [column.variable, column]));
  const headers = table.getHeaderGroups();
  const order = columns.map((column) => column.variable);
  /**
   * Whether the reader has taken the widths over — by having sized a column, or
   * by holding a handle right now. Until then the table is free to fill its
   * block.
   */
  const sized = drafted !== null || columns.some((column) => column.width !== null);
  /** What one column is drawn at, once anything is drawn at anything. */
  const widthOf = (variable: string): number =>
    drafted?.[variable] ?? byVariable.get(variable)?.width ?? DEFAULT_WIDTH;

  // Undo, redo, a remote edit, and the reader's own committed drag all arrive as
  // a change to the saved view, and each of them supersedes a draft rather than
  // merging with it.
  useLayoutEffect(() => {
    if (canonicalKeyRef.current === canonicalKey) return;
    canonicalKeyRef.current = canonicalKey;
    setDrafted(null);
  }, [canonicalKey]);

  /**
   * The widths as the browser has actually laid them out, which is where every
   * resize begins. A table nobody has sized declares no width at all, so the
   * only honest starting point is the row itself; a zero measurement is a table
   * that is not on screen rather than a width anybody chose.
   */
  const onScreenWidths = (): Widths => {
    const widths: Widths = {};
    const cells = head.current?.querySelectorAll<HTMLElement>("th[data-variable]") ?? [];
    for (const cell of cells) {
      const variable = cell.dataset.variable;
      const width = Math.round(cell.getBoundingClientRect().width);
      if (variable && width > 0) widths[variable] = Math.max(MIN_WIDTH, width);
    }
    for (const column of columns) widths[column.variable] ??= widthOf(column.variable);
    return widths;
  };

  /**
   * The layout the reader now owns, written whole: a column left with no width
   * of its own would be drawn at `DEFAULT_WIDTH` the moment a neighbour was
   * dragged, which is a table jumping to a shape nobody asked for.
   */
  const commitWidths = (widths: Widths) => {
    if (!onResize || resizeCommitPending.current) return;
    setDrafted(widths);
    resizeCommitPending.current = true;
    void onResize(widths)
      .then((saved) => {
        // A refusal leaves the saved view untouched, so the reconcile above has
        // nothing to notice and the draft has to stand down by itself.
        if (!saved) setDrafted(null);
      })
      .catch(() => setDrafted(null))
      .finally(() => {
        resizeCommitPending.current = false;
      });
  };

  /** One column, back to having no width of its own. */
  const resetWidth = (variable: string) => {
    if (!onResize || resizeCommitPending.current) return;
    resizeCommitPending.current = true;
    void onResize({ [variable]: null }).finally(() => {
      resizeCommitPending.current = false;
    });
  };

  /**
   * A width, dragged. The gesture is held from the window rather than from the
   * handle, so a pointer that outruns the column it is sizing keeps sizing it.
   */
  const startResize = (variable: string, event: React.PointerEvent<HTMLElement>) => {
    if (!onResize || resizeCommitPending.current || event.button !== 0) return;
    // No text selection under the pointer, and no native drag of the heading the
    // handle sits in — but the handle still takes focus, so the arrow keys can
    // finish what the pointer started.
    event.preventDefault();
    event.currentTarget.focus();
    const baseline = onScreenWidths();
    const from = event.clientX;
    const start = baseline[variable] ?? DEFAULT_WIDTH;
    let width = start;
    resizingFrom.current = true;
    setResizing(variable);
    setDrafted(baseline);
    const move = (moved: PointerEvent) => {
      width = Math.max(MIN_WIDTH, Math.round(start + moved.clientX - from));
      setDrafted({ ...baseline, [variable]: width });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      resizingFrom.current = false;
      setResizing(null);
      // A press that never travelled is not a resize, and writing the layout for
      // one would leave a command nobody asked for in the graph's history.
      if (width === start) setDrafted(null);
      else commitWidths({ ...baseline, [variable]: width });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** The same width, from the keyboard: one step against what is on screen. */
  const nudgeWidth = (variable: string, delta: number) => {
    const baseline = onScreenWidths();
    const width = Math.max(MIN_WIDTH, (baseline[variable] ?? DEFAULT_WIDTH) + delta);
    if (width === baseline[variable]) return;
    commitWidths({ ...baseline, [variable]: width });
  };

  /** Which side of a column the seam falls on, if it falls on this one at all. */
  const seamOf = (variable: string): "before" | "after" | undefined => {
    if (drag?.seamBefore === variable) return "before";
    if (drag?.seamBefore === null && variable === order[order.length - 1]) return "after";
    return undefined;
  };

  /** Commit a dropped heading: the running order the reader now reads. */
  const commitDrop = () => {
    const moved = drag?.variable;
    const before = drag?.seamBefore;
    setDrag(null);
    if (!onReorder || moved === undefined || before === undefined) return;
    const rest = order.filter((variable) => variable !== moved);
    const found = before === null ? -1 : rest.indexOf(before);
    const at = found < 0 ? rest.length : found;
    const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
    if (next.every((variable, position) => variable === order[position])) return;
    onReorder(next);
  };

  return (
    <div className="query-table-wrap" data-testid="query-table">
      <table
        className="query-table"
        data-compact={compact}
        data-wrap={wrap}
        // The filler column, when there is one, is layout rather than data: it
        // carries no heading and holds no value, so the count of real columns is
        // stated for assistive technology rather than counted off the DOM.
        aria-colcount={columns.length}
        data-sized={sized || undefined}
      >
        <colgroup>
          {headers[0]?.headers.map((header) => (
            // Until the reader takes the layout over, the table lays itself out:
            // no declared width, so the fixed algorithm shares the block between
            // the columns. Declaring a default width each instead cut every cell
            // short while half the table stood empty — a column of clipped text
            // beside five hundred pixels of nothing — which is also why the drag
            // that hands the layout over declares the widths it measures.
            <col
              key={header.id}
              style={{ width: sized ? widthOf(header.column.id) : undefined }}
            />
          ))}
          {/* Only once the reader owns the widths: it takes whatever they did not,
              so a sized column keeps exactly the width it was given. Without one,
              the fixed algorithm would hand the slack back to the sized columns
              and the drag would not hold. */}
          {sized && <col className="query-col-filler" />}
        </colgroup>
        <thead ref={head}>
          {headers.map((group) => (
            <tr key={group.id}>
              {group.headers.map((header, index) => {
                const column = byVariable.get(header.column.id);
                const label = column?.label ?? header.column.id;
                const rank = rankOf(header.column.id);
                const canSort = header.column.getCanSort();
                const term = !canSort || rank < 0 ? null : sorts[rank];
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-colindex={index + 1}
                    // What a width is measured through, and how a heading names
                    // its column to the gesture that sizes it.
                    data-variable={header.column.id}
                    data-numeric={column?.numeric || undefined}
                    data-dragging={drag?.variable === header.column.id || undefined}
                    data-seam={drag === null ? undefined : seamOf(header.column.id)}
                    draggable={Boolean(onReorder) && order.length > 1}
                    onDragStart={(event) => {
                      if (resizingFrom.current) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.setData("text/plain", label);
                      event.dataTransfer.effectAllowed = "move";
                      setDrag({ variable: header.column.id });
                    }}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={(event) => {
                      if (drag === null || drag.variable === header.column.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const box = event.currentTarget.getBoundingClientRect();
                      const before = event.clientX < box.left + box.width / 2;
                      setDrag({
                        ...drag,
                        seamBefore: before ? header.column.id : (order[index + 1] ?? null),
                      });
                    }}
                    onDrop={(event) => {
                      if (drag === null) return;
                      event.preventDefault();
                      commitDrop();
                    }}
                    aria-sort={
                      term === null
                        ? "none"
                        : term.descending
                          ? "descending"
                          : "ascending"
                    }
                  >
                    <div className="query-th">
                      <button
                        type="button"
                        className="query-th-sort"
                        disabled={!canSort}
                        onClick={() => canSort && onSort(cycleSort(sorts, header.column.id))}
                        title={message("query.sortBy", { column: label })}
                      >
                        <span>{label}</span>
                        {term && (term.descending
                          ? <ArrowDownIcon aria-hidden />
                          : <ArrowUpIcon aria-hidden />)}
                        {/* Rank, not decoration: with a second term in the list,
                            an arrow alone cannot say which column wins. */}
                        {term && sorts.length > 1 && (
                          <span className="query-th-rank">{rank + 1}</span>
                        )}
                      </button>
                      {(onHide || onMove) && (
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="query-th-menu"
                              aria-label={message("query.columnActions", {
                                column: column?.label ?? header.column.id,
                              })}
                              data-testid={`query-col-menu-${header.column.id}`}
                            >
                              <MoreHorizontalIcon aria-hidden />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            {/* A direction chosen here joins the list at the end
                                if it is not already in it, and changes in place
                                if it is — the same rule the header press keeps. */}
                            <DropdownMenuItem
                              disabled={!canSort}
                              onSelect={() => onSort(withDirection(sorts, header.column.id, false))}
                            >
                              <ArrowUpIcon aria-hidden />
                              {message("query.sortAscending")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!canSort}
                              onSelect={() => onSort(withDirection(sorts, header.column.id, true))}
                            >
                              <ArrowDownIcon aria-hidden />
                              {message("query.sortDescending")}
                            </DropdownMenuItem>
                            {term && (
                              <DropdownMenuItem
                                onSelect={() => onSort(
                                  sorts.filter((sort) => sort.variable !== header.column.id))}
                              >
                                <ArrowUpDownIcon aria-hidden />
                                {message("query.stopSorting")}
                              </DropdownMenuItem>
                            )}
                            {onMove && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={index === 0}
                                  onSelect={() => onMove(header.column.id, -1)}
                                >
                                  {message("query.moveColumnLeft")}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  disabled={index === group.headers.length - 1}
                                  onSelect={() => onMove(header.column.id, 1)}
                                >
                                  {message("query.moveColumnRight")}
                                </DropdownMenuItem>
                              </>
                            )}
                            {onResize && (
                              <DropdownMenuItem onSelect={() => resetWidth(header.column.id)}>
                                <ChevronsLeftRightIcon aria-hidden />
                                {message("query.resetWidth")}
                              </DropdownMenuItem>
                            )}
                            {onHide && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={columns.length <= 1}
                                  onSelect={() => onHide(header.column.id)}
                                >
                                  <EyeOffIcon aria-hidden />
                                  {message("query.hideColumn")}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                      {onResize && (
                        // A separator with a value, so the width is reachable
                        // from the keyboard as well as by dragging.
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          tabIndex={0}
                          aria-label={message("query.resizeColumn", {
                            column: column?.label ?? header.column.id,
                          })}
                          aria-valuenow={Math.round(widthOf(header.column.id))}
                          className="query-resize"
                          data-resizing={resizing === header.column.id || undefined}
                          onPointerDown={(event) => startResize(header.column.id, event)}
                          onKeyDown={(event) => {
                            if (resizeCommitPending.current) return;
                            const step = event.shiftKey ? 32 : 8;
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              nudgeWidth(header.column.id, -step);
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              nudgeWidth(header.column.id, step);
                            }
                          }}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
              {sized && <td className="query-cell-filler" aria-hidden />}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              data-testid="query-row"
              data-pinned={row.original.key === pinnedRowKey || undefined}
            >
              {row.getAllCells().map((cell, cellIndex) => {
                const column = byVariable.get(cell.column.id);
                const term = row.original.values[cell.column.id];
                const binding = column
                  ? editor.bindingFor(row.original.subject, column)
                  : null;
                const active = binding
                  ? editor.isActive(binding, row.original)
                  : false;
                const canOpen = binding?.kind === "markdown"
                  && row.original.subject !== undefined
                  && context.onOpen !== undefined;
                return (
                  <td
                    key={cell.id}
                    aria-colindex={cellIndex + 1}
                    data-numeric={column?.numeric || undefined}
                    data-interactive={binding ? true : undefined}
                    data-active={active || undefined}
                    // The seam runs the height of the column, because a column is
                    // what is being placed. Every cell draws its own two pixels
                    // and they stack into one line, which costs nothing and needs
                    // no measurement of a table that is still being laid out.
                    data-seam={drag === null ? undefined : seamOf(cell.column.id)}
                  >
                    {cellIndex === 0 && row.original.key === pinnedRowKey && (
                      <span className="query-result-stale" role="status">
                        {message("query.noLongerMatches")}
                      </span>
                    )}
                    {column && (
                      <QueryTableCellFrame
                        action={canOpen ? (
                          <button
                            type="button"
                            className="query-cell-open"
                            aria-label={message("query.openResult", {
                              name: term?.kind === "literal" && term.value
                                ? term.value
                                : column.label,
                            })}
                            onClick={() => context.onOpen?.(row.original.subject!)}
                          >
                            <ArrowUpRightIcon aria-hidden />
                          </button>
                        ) : undefined}
                      >
                        <EditableCellValue
                          term={term}
                          column={column}
                          context={context}
                          row={row.original}
                          editor={editor}
                          className="query-cell-control"
                        />
                      </QueryTableCellFrame>
                    )}
                  </td>
                );
              })}
              {sized && <td className="query-cell-filler" aria-hidden />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The list after a column is given an explicit direction: it keeps its place if
 * it already has one and joins the end if it does not, so choosing `Ascending`
 * from a heading's menu never silently discards the terms before it.
 */
function withDirection(
  sorts: QueryViewSort[],
  variable: string,
  descending: boolean,
): QueryViewSort[] {
  if (sorts.some((sort) => sort.variable === variable)) {
    return sorts.map((sort) => (sort.variable === variable ? { variable, descending } : sort));
  }
  if (sorts.length >= SORT_LIMIT) return sorts;
  return [...sorts, { variable, descending }];
}
