// The table view.
//
// Column order, width, and visibility are the reader's, and they persist in the
// saved view so the shape of a table survives a reload and reaches everyone on
// the graph. Sorting is not: a header click reorders what is already on screen
// (DESIGN.md § Query block — switching views changes only presentation), while
// the query's own order lives in the builder's Sort row.
//
// TanStack Table owns the models — order, sizing, visibility, sorting — and this
// file owns every pixel, because the design system, not a library's stylesheet,
// decides what a row looks like.

import { useMemo, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsLeftRightIcon,
  EyeOffIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import {
  columnResizingFeature,
  columnSizingFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { useI18n } from "../../i18n";
import {
  cellText,
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
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});

export function QueryTableView({
  columns,
  rows,
  context,
  editor,
  pinnedRowKey,
  compact,
  wrap,
  onResize,
  onHide,
  onMove,
}: {
  columns: ResultColumn[];
  rows: ResultViewRow[];
  context: CellContext;
  editor: QueryResultEditor;
  pinnedRowKey?: string;
  compact: boolean;
  wrap: boolean;
  /** Persist a dragged width. Absent while the graph is read-only. */
  onResize?: (variable: string, width: number) => void;
  onHide?: (variable: string) => void;
  onMove?: (variable: string, delta: -1 | 1) => void;
}) {
  const { message } = useI18n();
  const [sorting, setSorting] = useState<SortingState>([]);

  const definitions = useMemo<ColumnDef<typeof FEATURES, ResultViewRow, unknown>[]>(
    () =>
      columns.map((column) => ({
        id: column.variable,
        // Sorting runs on the words the reader sees, not on the raw lexical form
        // of the term underneath them.
        accessorFn: (row: ResultViewRow) => cellText(row.values[column.variable], column, context),
        header: column.label,
        size: column.width ?? DEFAULT_WIDTH,
        minSize: MIN_WIDTH,
        enableSorting: true,
        sortFn: "alphanumeric",
      })),
    [columns, context],
  );

  const table = useTable({
    features: FEATURES,
    data: rows,
    columns: definitions,
    getRowId: (row) => row.key,
    state: { sorting },
    onSortingChange: setSorting,
    columnResizeMode: "onChange",
    enableColumnResizing: Boolean(onResize),
  });

  const byVariable = new Map(columns.map((column) => [column.variable, column]));

  return (
    <div className="query-table-wrap" data-testid="query-table">
      <table className="query-table" data-compact={compact} data-wrap={wrap}>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header, index) => {
                const column = byVariable.get(header.column.id);
                const direction = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    style={{ width: header.getSize() }}
                    data-numeric={column?.numeric || undefined}
                    aria-sort={
                      direction === "asc"
                        ? "ascending"
                        : direction === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <div className="query-th">
                      <button
                        type="button"
                        className="query-th-sort"
                        onClick={header.column.getToggleSortingHandler()}
                        title={message("query.sortBy", { column: column?.label ?? header.column.id })}
                      >
                        <span>{column?.label ?? header.column.id}</span>
                        {direction === "asc" && <ArrowUpIcon aria-hidden />}
                        {direction === "desc" && <ArrowDownIcon aria-hidden />}
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
                            <DropdownMenuItem
                              onSelect={() => header.column.toggleSorting(false)}
                            >
                              <ArrowUpIcon aria-hidden />
                              {message("query.sortAscending")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => header.column.toggleSorting(true)}>
                              <ArrowDownIcon aria-hidden />
                              {message("query.sortDescending")}
                            </DropdownMenuItem>
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
                              <DropdownMenuItem onSelect={() => onResize(header.column.id, 0)}>
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
                            header.getResizeHandler()(event);
                            const commit = () => {
                              window.removeEventListener("pointerup", commit);
                              onResize?.(header.column.id, Math.round(header.column.getSize()));
                            };
                            window.addEventListener("pointerup", commit);
                          }}
                          onKeyDown={(event) => {
                            const step = event.shiftKey ? 32 : 8;
                            const current = header.column.getSize();
                            if (event.key === "ArrowLeft") {
                              event.preventDefault();
                              onResize?.(header.column.id, Math.max(MIN_WIDTH, current - step));
                            } else if (event.key === "ArrowRight") {
                              event.preventDefault();
                              onResize?.(header.column.id, current + step);
                            }
                          }}
                        />
                      )}
                    </div>
                  </th>
                );
              })}
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
                    style={{ width: cell.column.getSize() }}
                    data-numeric={column?.numeric || undefined}
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
