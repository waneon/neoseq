// The list view: entity results in the document's own visual grammar.
//
// A block result resolves its canonical BlockSnapshot and passes through the
// same row/body presentation as the outline. Query columns are not used to
// reconstruct a partial block: direct block fields belong to the native block
// presentation. A page, tag, aggregate, or hand-written row keeps the generic
// result fallback, but table-only column choices never supplement a block.

import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { findBlock, findOutline, stringValue } from "../../core-port/snapshot";
import { useI18n } from "../../i18n";
import { elementAnchor, snapshotAnchor } from "@/ui/anchored";
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
  rows,
  context,
  editor,
  pinnedRowKey,
  compact,
}: {
  rows: ResultViewRow[];
  context: CellContext;
  editor: QueryResultEditor;
  pinnedRowKey?: string;
  compact: boolean;
}) {
  const { message } = useI18n();

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
        const outline = entity?.kind === "block"
          ? findOutline(context.snapshot, entity.owner)
          : undefined;
        const block = entity?.kind === "block" && outline
          ? findBlock(outline, entity.id)
          : undefined;
        if (!entity || entity.kind !== "block") return null;
        if (!block) {
          return (
            <BlockRowFrame
              key={row.key}
              className="query-list-row"
              role="treeitem"
              aria-level={1}
              aria-busy="true"
              aria-label={message("graph.loading")}
              data-testid="query-list-row"
              gutterClassName="outline-gutter"
              gutter={<span className="outline-bullet" aria-hidden />}
            >
              <BlockBody className="query-list-text" />
            </BlockRowFrame>
          );
        }
        const canonicalStatus = stringValue(block.properties, TASK_STATUS_KEY);
        const canonicalPriority = stringValue(block.properties, TASK_PRIORITY_KEY);
        // Presence in the canonical block is authoritative. A table projecting
        // an empty task field must not create an affordance in this renderer.
        const taskStatus = canonicalStatus;
        const taskPriority = canonicalPriority;
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
          if (binding) editor.begin(binding, row, snapshotAnchor(elementAnchor(anchor)));
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
                      context={context}
                      editor={editor}
                    />
                  )}
                  {taskPriority !== undefined && (
                    <EditableBlockTaskMark
                      kind="priority"
                      value={taskPriority}
                      row={row}
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
                  <TagChips owner={entity.owner} block={block} variant="reference" />
                </div>
              )}
              <BlockChips
                block={block}
                representedKeys={representedTaskKeys}
                onEdit={(key, anchor) => beginDirect({ kind: "property", key }, anchor)}
              />
            </BlockBody>
          </BlockRowFrame>
        );
      })}
    </div>
  );
}

/** A non-block or aggregate SELECT keeps the query-shaped list fallback. */
export function QueryGenericListView({
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
  const facts = columns.filter((column) => column !== lead && column !== status);
  return (
    <div
      className="query-list"
      role="tree"
      aria-label={message("query.resultList")}
      data-compact={compact}
      data-testid="query-list"
    >
      {rows.map((row) => (
        <GenericResultRow
          key={row.key}
          row={row}
          lead={lead}
          status={status}
          facts={facts}
          context={context}
          editor={editor}
          pinned={row.key === pinnedRowKey}
        />
      ))}
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
            <CellValue
              term={row.values[column.variable]}
              column={column}
              context={context}
              row={row.values}
            />
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
