// The list view: results as outline rows.
//
// A query over blocks answers with blocks, so it renders in the grammar the
// document already uses — the same bullet in the same gutter, the same 15px
// line, the status shape at the head of it, tags gathered right, and the
// remaining facts as the same chips that sit under a block in the outline. The
// difference is that these rows are a lens, not the document: they are
// read-only, and the bullet opens the block where it actually lives.

import { TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { TaskStatusGlyph } from "../tasks/glyphs";
import {
  CellValue,
  cellText,
  entityName,
  rowSubject,
  type CellContext,
  type ResultColumn,
  type ResultRow,
} from "./cells";

export function QueryListView({
  columns,
  rows,
  context,
  compact,
}: {
  columns: ResultColumn[];
  rows: ResultRow[];
  context: CellContext;
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
      {rows.map((row, index) => {
        const entity = rowSubject(row, context);
        const statusValue = status ? row[status.variable] : undefined;
        // A block with nothing written in it renders as the empty line it is,
        // exactly as the outline draws one. A page or a tag always has a name.
        const text = (lead ? cellText(row[lead.variable], lead, context) : "")
          || (entity && entity.kind !== "block" ? entityName(entity, context) : "");
        return (
          <div
            key={index}
            className="query-list-row"
            role="treeitem"
            aria-level={1}
            aria-selected={false}
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
              {statusValue?.kind === "literal" && (
                <span className="query-list-status">
                  <TaskStatusGlyph status={statusValue.value} />
                </span>
              )}
              <span className="query-list-line" dir="auto">
                {text}
              </span>
              {facts.length > 0 && (
                <div className="query-list-facts">
                  {facts.map((column) => (
                    <span key={column.variable} className="query-fact">
                      <span className="query-fact-key">{column.label}</span>
                      <CellValue term={row[column.variable]} column={column} context={context} />
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
