// The list view: entity results in the document's own visual grammar.
//
// A block result resolves its canonical BlockSnapshot and passes through the
// same row/body presentation as the outline. Query columns are not used to
// reconstruct a partial block: direct block fields belong to the native block
// presentation, while genuinely derived fields remain supplemental facts. A
// page, tag, aggregate, or hand-written row keeps the generic result fallback.

import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { findBlock, findPage, stringValue } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import { BlockBody, BlockRowFrame } from "../blocks/BlockPresentation";
import { BlockChips } from "../properties/BlockChips";
import { TagChips } from "../properties/TagChips";
import {
  CellValue,
  cellText,
  entityName,
  type CellContext,
  type ResultColumn,
  type ResultViewRow,
} from "./cells";
import {
  EditableBlockContent,
  EditableBlockTaskMark,
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
  const lead = columns.find((column) => column.source?.kind === "content")
    ?? columns.find((column) => !column.source && !column.numeric);
  const status = columns.find(isStatusColumn);
  const priority = columns.find(isPriorityColumn);
  const genericFacts = columns.filter((column) => column !== lead && column !== status);
  const blockFacts = columns.filter((column) => !isNativeBlockColumn(column));

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
        const page = entity?.kind === "block" ? findPage(context.snapshot, entity.page_id) : undefined;
        const block = entity?.kind === "block" && page ? findBlock(page, entity.id) : undefined;
        if (!block || entity?.kind !== "block") {
          return (
            <GenericResultRow
              key={row.key}
              row={row}
              lead={lead}
              status={status}
              facts={genericFacts}
              context={context}
              editor={editor}
              pinned={row.key === pinnedRowKey}
            />
          );
        }

        const canonicalStatus = stringValue(block.properties, TASK_STATUS_KEY);
        const canonicalPriority = stringValue(block.properties, TASK_PRIORITY_KEY);
        // A selected empty task field remains an affordance, as it was before
        // canonical block rendering: it lets the query create the field when
        // this surface is writable. RDF values never fill a missing canonical
        // field — absence in BlockSnapshot is authoritative too.
        const taskStatus = canonicalStatus ?? (
          status && editor.bindingForDirect(entity, { kind: "property", key: TASK_STATUS_KEY })
            ? ""
            : undefined
        );
        const taskPriority = canonicalPriority ?? (
          priority && editor.bindingForDirect(entity, { kind: "property", key: TASK_PRIORITY_KEY })
            ? ""
            : undefined
        );
        const markCount = Number(taskStatus !== undefined) + Number(taskPriority !== undefined);
        const representedTaskKeys = [
          ...(taskStatus !== undefined ? [TASK_STATUS_KEY] : []),
          ...(taskPriority !== undefined ? [TASK_PRIORITY_KEY] : []),
        ];
        const openLabel = block.markdown
          ? message("query.openResult", { name: block.markdown })
          : message("query.openEmptyResult");
        const openBlock = () => context.onOpen?.(entity);

        const beginDirect = (
          field: Parameters<QueryResultEditor["bindingForDirect"]>[1],
          anchor: HTMLElement,
        ) => {
          const binding = editor.bindingForDirect(entity, field);
          if (binding) editor.begin(binding, row, anchor.getBoundingClientRect());
          else openBlock();
        };

        return (
          <BlockRowFrame
            key={row.key}
            className="query-list-row"
            role="treeitem"
            aria-level={1}
            aria-selected={editor.active?.origin.row.key === row.key}
            data-empty={block.markdown.length === 0}
            data-pinned={row.key === pinnedRowKey || undefined}
            data-block-id={block.id}
            data-testid="query-list-row"
            gutterClassName="outline-gutter"
            gutter={context.onOpen ? (
              <button
                type="button"
                className="outline-bullet"
                aria-label={openLabel}
                onClick={openBlock}
              />
            ) : (
              <span className="outline-bullet" aria-hidden />
            )}
          >
            <BlockBody
              className="query-list-text"
              taskStatus={taskStatus}
              markCount={markCount}
            >
              {markCount > 0 && (
                <span className="task-marks">
                  {taskStatus !== undefined && (
                    <EditableBlockTaskMark
                      kind="status"
                      value={taskStatus}
                      row={row}
                      column={status}
                      context={context}
                      editor={editor}
                    />
                  )}
                  {taskPriority !== undefined && (
                    <EditableBlockTaskMark
                      kind="priority"
                      value={taskPriority}
                      row={row}
                      column={priority}
                      context={context}
                      editor={editor}
                    />
                  )}
                </span>
              )}
              <EditableBlockContent
                markdown={block.markdown}
                row={row}
                context={context}
                editor={editor}
              />
              {row.key === pinnedRowKey && (
                <span className="query-result-stale" role="status">
                  {message("query.noLongerMatches")}
                </span>
              )}
              {block.tags.length > 0 && (
                <div className="outline-tags">
                  <TagChips pageId={entity.page_id} block={block} variant="reference" />
                </div>
              )}
              <BlockChips
                block={block}
                representedKeys={representedTaskKeys}
                onEdit={(key, anchor) => beginDirect({ kind: "property", key }, anchor)}
              />
              <ResultFacts
                columns={blockFacts}
                row={row}
                context={context}
                editor={editor}
              />
            </BlockBody>
          </BlockRowFrame>
        );
      })}
    </div>
  );
}

function GenericResultRow({
  row,
  lead,
  status,
  facts,
  context,
  editor,
  pinned,
}: {
  row: ResultViewRow;
  lead?: ResultColumn;
  status?: ResultColumn;
  facts: ResultColumn[];
  context: CellContext;
  editor: QueryResultEditor;
  pinned: boolean;
}) {
  const { message } = useI18n();
  const entity = row.subject;
  const statusValue = status ? row.values[status.variable] : undefined;
  const text = (lead ? cellText(row.values[lead.variable], lead, context) : "")
    || (entity && entity.kind !== "block" ? entityName(entity, context) : "");
  return (
    <BlockRowFrame
      className="query-list-row query-list-row-generic"
      role="treeitem"
      aria-level={1}
      aria-selected={editor.active?.origin.row.key === row.key}
      data-pinned={pinned || undefined}
      data-testid="query-list-row"
      gutterClassName="outline-gutter"
      gutter={entity && context.onOpen ? (
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
    >
      <BlockBody className="query-list-text" taskStatus={literalValue(statusValue)}>
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
        {pinned && (
          <span className="query-result-stale" role="status">
            {message("query.noLongerMatches")}
          </span>
        )}
        <ResultFacts columns={facts} row={row} context={context} editor={editor} />
      </BlockBody>
    </BlockRowFrame>
  );
}

function ResultFacts({
  columns,
  row,
  context,
  editor,
}: {
  columns: ResultColumn[];
  row: ResultViewRow;
  context: CellContext;
  editor: QueryResultEditor;
}) {
  if (columns.length === 0) return null;
  return (
    <div className="query-list-facts">
      {columns.map((column) => (
        <span key={column.variable} className="query-fact">
          <span className="query-fact-key">{column.label}</span>
          {row.subject ? (
            <EditableCellValue
              term={row.values[column.variable]}
              column={column}
              context={context}
              row={row}
              editor={editor}
            />
          ) : (
            <CellValue term={row.values[column.variable]} column={column} context={context} />
          )}
        </span>
      ))}
    </div>
  );
}

function literalValue(term: ResultViewRow["values"][string] | undefined): string | undefined {
  return term?.kind === "literal" ? term.value : undefined;
}

function isStatusColumn(column: ResultColumn): boolean {
  return column.source?.kind === "property" && column.source.key === TASK_STATUS_KEY;
}

function isPriorityColumn(column: ResultColumn): boolean {
  return column.source?.kind === "property" && column.source.key === TASK_PRIORITY_KEY;
}

/** Native direct fields come from BlockSnapshot; aggregates and relations stay query facts. */
function isNativeBlockColumn(column: ResultColumn): boolean {
  if (!column.source || (column.aggregate && column.aggregate !== "list")) return false;
  return column.source.kind === "content"
    || column.source.kind === "property"
    || column.source.kind === "tags";
}
