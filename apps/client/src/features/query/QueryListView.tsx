// The list view: results as outline rows.
//
// A query over blocks answers with blocks, so it renders in the grammar the
// document already uses — the same bullet in the same gutter, the same 15px
// line, the status shape at the head of it, tags gathered right, and the
// remaining facts as the same chips that sit under a block in the outline. The
// difference is that these rows are a lens, not a second document: direct
// fields issue canonical commands, and the bullet opens the block where it
// actually lives for structural work.

import { TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import {
  CellValue,
  cellText,
  entityName,
  type CellContext,
  type ResultColumn,
  type ResultViewRow,
} from "./cells";
import {
  EditableCellValue,
  EditableStatusValue,
  type QueryResultEditor,
} from "./edit";

export function QueryListView({
  columns,
  rows,
  context,
  editor,
  pinnedRowKey,
  compact,
}: {
  columns: ResultColumn[];
  rows: ResultViewRow[];
  context: CellContext;
  editor: QueryResultEditor;
  pinnedRowKey?: string;
  compact: boolean;
}) {
  const { message } = useI18n();
  // The row's own line is its subject's text; everything else becomes a fact
  // underneath it, exactly as a block's properties do.
  const lead = columns.find((column) => column.source?.kind === "content")
    ?? columns.find((column) => !column.source && !column.numeric);
  const status = columns.find(
    (column) => column.source?.kind === "property" && column.source.key === TASK_STATUS_KEY,
  );
  const facts = columns.filter((column) => column !== lead && column !== status);

  return (
    <div
      className="query-list"
      role="tree"
      aria-label={message("query.resultList")}
      data-compact={compact}
      data-testid="query-list"
    >
      {rows.map((row) => {
        const entity = row.subject;
        const statusValue = status ? row.values[status.variable] : undefined;
        // A block with nothing written in it renders as the empty line it is,
        // exactly as the outline draws one. A page or a tag always has a name.
        const text = (lead ? cellText(row.values[lead.variable], lead, context) : "")
          || (entity && entity.kind !== "block" ? entityName(entity, context) : "");
        return (
          <div
            key={row.key}
            className="query-list-row"
            role="treeitem"
            aria-level={1}
            aria-selected={editor.active?.origin.row.key === row.key}
            data-pinned={row.key === pinnedRowKey || undefined}
            data-testid="query-list-row"
          >
            <span className="outline-gutter">
              {entity && context.onOpen ? (
                <button
                  type="button"
                  className="outline-bullet"
                  aria-label={text
                    ? message("query.openResult", { name: text })
                    : message("query.openEmptyResult")}
                  onClick={() => context.onOpen?.(entity)}
                />
              ) : (
                <span className="outline-bullet" aria-hidden />
              )}
            </span>
            <div
              className="query-list-text"
              data-task-status={
                statusValue?.kind === "literal" ? statusValue.value : undefined
              }
            >
              {status && (
                <EditableStatusValue
                  term={statusValue}
                  column={status}
                  context={context}
                  row={row}
                  editor={editor}
                />
              )}
              {lead && entity ? (
                <EditableCellValue
                  term={row.values[lead.variable]}
                  column={lead}
                  context={context}
                  row={row}
                  editor={editor}
                  className="query-list-line"
                />
              ) : (
                <span className="query-list-line" dir="auto">{text}</span>
              )}
              {row.key === pinnedRowKey && (
                <span className="query-result-stale" role="status">
                  {message("query.noLongerMatches")}
                </span>
              )}
              {facts.length > 0 && (
                <div className="query-list-facts">
                  {facts.map((column) => (
                    <span key={column.variable} className="query-fact">
                      <span className="query-fact-key">{column.label}</span>
                      {entity ? (
                        <EditableCellValue
                          term={row.values[column.variable]}
                          column={column}
                          context={context}
                          row={row}
                          editor={editor}
                        />
                      ) : (
                        <CellValue
                          term={row.values[column.variable]}
                          column={column}
                          context={context}
                        />
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
