// Test-build-only visual fixture. Production routing never imports it.
import { CheckIcon, Settings2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { TaskMomentPicker } from "../properties/TaskMomentPicker";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { TaskMoment } from "../tasks/TaskMoment";
import type { TaskMomentPresentation } from "../tasks/moment-presentation";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { elementAnchor } from "../../ui/anchored";
import { AnchoredPanel } from "../../ui/anchored-panel";
import { Dialog } from "../../ui/components";
import { MenuSelect } from "../../ui/menu-select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/shadcn/dropdown-menu";
import { QueryTableCellFrame } from "../query/QueryTableCell";
import "./visual-verification.css";

const moment: TaskMomentPresentation = {
  kind: "scheduled",
  label: "Scheduled",
  dateLabel: "August 28, 2026",
  timeLabel: "14:30",
  due: { tier: "soon", tone: "caution", distance: { unit: "day", value: 2 } },
  relativeLabel: "In 2 days",
  repeating: true,
  title: "August 28, 2026 · 14:30 · In 2 days",
};

function FocusRestorationControls() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <section aria-label="Focus restoration" className="visual-verification-section">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button className="task-priority-toggle" aria-label="Priority" data-testid="focus-menu">
            <PriorityGlyph priority="low" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Low</DropdownMenuItem>
          <DropdownMenuItem>High</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialogOpen(true)}>Edit details</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        ref={anchor}
        className="icon-btn"
        aria-label="Edit value"
        data-testid="focus-panel"
        onClick={() => setPanelOpen(true)}
      >
        <Settings2Icon aria-hidden />
      </button>
      {panelOpen && (
        <AnchoredPanel
          anchor={elementAnchor(anchor.current)}
          label="Edit value"
          className="context-panel"
          onClose={() => setPanelOpen(false)}
        >
          <input aria-label="Value" />
          <button onClick={() => setPanelOpen(false)}>Apply</button>
        </AnchoredPanel>
      )}
      <MenuSelect
        label="Status"
        testId="focus-select"
        value="todo"
        options={[
          { value: "todo", label: "To-do" },
          { value: "done", label: "Done" },
        ]}
        onValueChange={() => {}}
      />
      {dialogOpen && (
        <Dialog title="Details" onClose={() => setDialogOpen(false)}>
          <input aria-label="Details value" />
          <MenuSelect
            label="Nested status"
            testId="focus-nested-select"
            value="todo"
            options={[
              { value: "todo", label: "To-do" },
              { value: "done", label: "Done" },
            ]}
            onValueChange={() => {}}
          />
        </Dialog>
      )}
    </section>
  );
}

export function VisualVerificationPage() {
  return (
    <main className="visual-verification">
      <section aria-label="Focused controls" className="visual-verification-section">
        <div className="property-picker visual-property-picker" data-testid="visual-focus-picker">
          <header className="property-picker-head">
            <div>
              <strong>Scheduled</strong>
            </div>
          </header>
          <div className="property-picker-value">
            <TaskMomentPicker
              date="2026-08-25"
              time="14:30"
              repeat="1w"
              hasValue
              readonly={false}
              busy={false}
              clearLabel="Clear scheduled date"
              onApply={() => undefined}
              onClear={() => undefined}
              onCancel={() => undefined}
            />
          </div>
        </div>

        <button type="button" className="visual-fallback" data-testid="visual-focus-fallback">
          Unstyled focus fallback
        </button>
      </section>

      <FocusRestorationControls />

      <section
        aria-label="Surface contracts"
        className="visual-contracts"
        data-testid="visual-surface-contracts"
      >
        <article>
          <h2>Moment · outline</h2>
          <TaskMoment value={moment} appearance="chip" />
        </article>
        <article>
          <h2>Moment · table</h2>
          <TaskMoment value={moment} appearance="cell" />
        </article>
        <article>
          <h2>Markdown · outline/list</h2>
          <BlockMarkdown markdown={"## Shared meaning\n\n**Rich** block projection"} />
        </article>
        <article>
          <h2>Markdown · table</h2>
          <BlockMarkdown
            markdown={"## Shared meaning — **compact** projection"}
            variant="compact"
          />
        </article>
        <article className="visual-query-contract">
          <h2>Query table · geometry contract</h2>
          <table
            className="query-table"
            data-compact="false"
            data-wrap="false"
            data-testid="visual-query-table"
          >
            <thead>
              <tr>
                {["Status", "Scheduled", "Text", "Markdown", "Tags", "Check"].map((label) => (
                  <th key={label} scope="col">
                    <div className="query-th">
                      <span>{label}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((row) => (
                <tr key={row}>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <button type="button" className="query-edit-trigger query-cell-control">
                        <span className="query-status">
                          <TaskStatusGlyph status="todo" />
                          To-do
                        </span>
                      </button>
                    </QueryTableCellFrame>
                  </td>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <button type="button" className="query-edit-trigger query-cell-control">
                        <TaskMoment value={moment} appearance="cell" />
                      </button>
                    </QueryTableCellFrame>
                  </td>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <button
                        type="button"
                        className="query-edit-trigger query-cell-control query-contract-plain"
                      >
                        anybridge meeting
                      </button>
                    </QueryTableCellFrame>
                  </td>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <span className="query-cell-control">
                        <BlockMarkdown
                          markdown="**anybridge** meeting"
                          variant="compact"
                          className="query-markdown-preview"
                        />
                      </span>
                    </QueryTableCellFrame>
                  </td>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <span className="query-cell-control">
                        <span className="query-tags">
                          <span className="query-tag-chip">project</span>
                        </span>
                      </span>
                    </QueryTableCellFrame>
                  </td>
                  <td data-interactive="true">
                    <QueryTableCellFrame>
                      <button type="button" className="query-edit-trigger query-cell-control">
                        <span className="query-check" data-checked="true">
                          <CheckIcon aria-hidden />
                          Yes
                        </span>
                      </button>
                    </QueryTableCellFrame>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}
