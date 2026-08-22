// The table view.
//
// Column order, width, visibility **and sort** are the reader's, and they persist
// in the saved view so the shape of a table survives a reload and reaches
// everyone on the graph. Sort is presentation like the rest of them: it reorders
// what is already on screen, while the query's own order — the one a `LIMIT` cuts
// against — lives in the builder's Sort row. A reader on a read-only graph can
// still sort; there is simply nowhere to write the choice, so the block holds it
// for as long as it is mounted.
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
// The query projection owns row ordering so every renderer consumes the same
// result. TanStack Table owns column sizing and row/cell models here; this file
// owns every pixel, because the design system, not a library's stylesheet,
// decides what a row looks like.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronsLeftRightIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import {
  columnResizingFeature,
  columnSizingFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnSizingState,
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

const MIN_WIDTH = 72;
const DEFAULT_WIDTH = 180;

// Only what this table actually does: order rows, size columns, drag that size.
// Visibility and column order are the saved view's, not the table's — they
// persist in the graph, so they arrive already applied in `columns`.
const FEATURES = tableFeatures({
  rowSortingFeature,
  columnSizingFeature,
  columnResizingFeature,
});

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
  /** Persist a dragged width. Resolves after the authoritative view reconciles. */
  onResize?: (variable: string, width: number) => Promise<boolean>;
  onHide?: (variable: string) => void;
  /** The columns in the order the reader just dragged them into. */
  onReorder?: (order: string[]) => void;
  onMove?: (variable: string, delta: -1 | 1) => void;
}) {
  const { message } = useI18n();
  const rankOf = (variable: string) => sorts.findIndex((sort) => sort.variable === variable);
  const canonicalSizing = useMemo<ColumnSizingState>(
    () => Object.fromEntries(
      columns.map((column) => [column.variable, column.width ?? DEFAULT_WIDTH]),
    ),
    [columns],
  );
  // Column identities and saved widths are the complete canonical sizing
  // boundary. Result rows and unrelated graph revisions may rebuild `columns`,
  // but they must not interrupt a live drag when those values did not change.
  const canonicalSizingKey = JSON.stringify(
    columns.map((column) => [column.variable, column.width ?? DEFAULT_WIDTH]),
  );
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(canonicalSizing);
  const canonicalSizingRef = useRef(canonicalSizing);
  const canonicalSizingKeyRef = useRef(canonicalSizingKey);
  const resizeCommitPending = useRef(false);
  const [dragging, setDragging] = useState<string | null>(null);
  /** The column the seam is drawn before, or `null` for past the last one. */
  const [seamBefore, setSeamBefore] = useState<string | null | undefined>(undefined);
  canonicalSizingRef.current = canonicalSizing;

  const definitions = useMemo<ColumnDef<typeof FEATURES, ResultViewRow, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.variable,
        accessorFn: (row: ResultViewRow) => row.values[column.variable],
        header: column.label,
        size: column.width ?? DEFAULT_WIDTH,
        minSize: MIN_WIDTH,
        enableSorting: column.sortable,
      })),
    [columns],
  );

  const table = useTable({
    features: FEATURES,
    data: rows,
    columns: definitions,
    getRowId: (row) => row.key,
    // Rows already carry the shared Table/List order. Saved widths are
    // canonical; this controlled slice is only the live drag overlay. Without
    // it TanStack retains an uncontrolled size override after undo, so
    // `columnDef.size` changes while `header.getSize()` stays stale.
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    enableMultiSort: true,
    maxMultiSortColCount: SORT_LIMIT,
    columnResizeMode: "onChange",
    enableColumnResizing: Boolean(onResize),
  });

  useLayoutEffect(() => {
    if (canonicalSizingKeyRef.current === canonicalSizingKey) return;
    canonicalSizingKeyRef.current = canonicalSizingKey;
    // Undo, redo, a remote edit, and an ordinary local command all reconcile
    // through the same saved view. An authoritative change also cancels a drag
    // based on the superseded width.
    table.resetHeaderSizeInfo(true);
    setColumnSizing(canonicalSizing);
  }, [canonicalSizing, canonicalSizingKey, table]);

  const restoreCanonicalSizing = () => {
    table.resetHeaderSizeInfo(true);
    setColumnSizing(canonicalSizingRef.current);
  };

  const commitSize = (variable: string, width: number) => {
    if (!onResize || resizeCommitPending.current) return;
    setColumnSizing((current) => ({
      ...current,
      [variable]: width || DEFAULT_WIDTH,
    }));
    resizeCommitPending.current = true;
    void onResize(variable, width)
      .then((saved) => {
        if (!saved) restoreCanonicalSizing();
      })
      .catch(restoreCanonicalSizing)
      .finally(() => {
        resizeCommitPending.current = false;
      });
  };

  const byVariable = new Map(columns.map((column) => [column.variable, column]));
  const headers = table.getHeaderGroups();
  const order = columns.map((column) => column.variable);
  /**
   * Whether the reader has taken the widths over — by having sized a column, or
   * by dragging one right now. Until then the table is free to fill its block.
   */
  const sized = columns.some((column) => column.width !== null)
    // A drag in flight: the controlled overlay has left the canonical widths
    // behind, and the columns have to hold the size the handle is giving them.
    || columns.some((column) =>
      columnSizing[column.variable] !== (column.width ?? DEFAULT_WIDTH));

  /** Which side of a column the seam falls on, if it falls on this one at all. */
  const seamOf = (variable: string): "before" | "after" | undefined => {
    if (seamBefore === variable) return "before";
    if (seamBefore === null && variable === order[order.length - 1]) return "after";
    return undefined;
  };

  /** Commit a dropped heading: the running order the reader now reads. */
  const commitDrop = () => {
    const moved = dragging;
    const before = seamBefore;
    setDragging(null);
    setSeamBefore(undefined);
    if (!onReorder || moved === null || before === undefined) return;
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
            // the columns. Declaring 180px each instead cut every cell short
            // while half the table stood empty — a column of clipped text beside
            // five hundred pixels of nothing.
            <col key={header.id} style={{ width: sized ? header.getSize() : undefined }} />
          ))}
          {/* Only once the reader owns the widths: it takes whatever they did not,
              so a sized column keeps exactly the width it was given. Without one,
              the fixed algorithm would hand the slack back to the sized columns
              and the drag would not hold. */}
          {sized && <col className="query-col-filler" />}
        </colgroup>
        <thead>
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
                    data-numeric={column?.numeric || undefined}
                    data-dragging={dragging === header.column.id || undefined}
                    data-seam={dragging === null ? undefined : seamOf(header.column.id)}
                    draggable={Boolean(onReorder) && order.length > 1}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", label);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(header.column.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setSeamBefore(undefined);
                    }}
                    onDragOver={(event) => {
                      if (dragging === null || dragging === header.column.id) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const box = event.currentTarget.getBoundingClientRect();
                      const before = event.clientX < box.left + box.width / 2;
                      setSeamBefore(before
                        ? header.column.id
                        : (order[index + 1] ?? null));
                    }}
                    onDrop={(event) => {
                      if (dragging === null) return;
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
                              <DropdownMenuItem onSelect={() => commitSize(header.column.id, 0)}>
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
                      {header.column.getCanResize() && (
                        // A separator with a value, so the width is reachable
                        // from the keyboard as well as by dragging.
                        <div
                          role="separator"
                          aria-orientation="vertical"
                          tabIndex={0}
                          aria-label={message("query.resizeColumn", {
                            column: column?.label ?? header.column.id,
                          })}
                          aria-valuenow={Math.round(header.getSize())}
                          className="query-resize"
                          data-resizing={header.column.getIsResizing() || undefined}
                          onPointerDown={(event) => {
                            if (resizeCommitPending.current) return;
                            header.getResizeHandler()(event);
                            const commit = () => {
                              window.removeEventListener("pointerup", commit);
                              commitSize(header.column.id, Math.round(header.column.getSize()));
                            };
                            window.addEventListener("pointerup", commit);
                          }}
                          onKeyDown={(event) => {
                            if (resizeCommitPending.current) return;
                            const step = event.shiftKey ? 32 : 8;
                            const current = header.column.getSize();
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              commitSize(header.column.id, Math.max(MIN_WIDTH, current - step));
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              commitSize(header.column.id, current + step);
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
                return (
                  <td
                    key={cell.id}
                    aria-colindex={cellIndex + 1}
                    data-numeric={column?.numeric || undefined}
                    // The seam runs the height of the column, because a column is
                    // what is being placed. Every cell draws its own two pixels
                    // and they stack into one line, which costs nothing and needs
                    // no measurement of a table that is still being laid out.
                    data-seam={dragging === null ? undefined : seamOf(cell.column.id)}
                  >
                    {cellIndex === 0 && row.original.key === pinnedRowKey && (
                      <span className="query-result-stale" role="status">
                        {message("query.noLongerMatches")}
                      </span>
                    )}
                    {column && (
                      <EditableCellValue
                        term={row.original.values[cell.column.id]}
                        column={column}
                        context={context}
                        row={row.original}
                        editor={editor}
                        showOpen
                      />
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
