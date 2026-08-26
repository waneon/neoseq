// Test-build-only visual fixture. Production routing never imports it.
import { TaskMomentPicker } from "../properties/TaskMomentPicker";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { TaskMoment } from "../tasks/TaskMoment";
import type { TaskMomentPresentation } from "../tasks/moment-presentation";
import { TaskStatusGlyph } from "../tasks/glyphs";
import { QueryTableCellFrame } from "../query/QueryTableCell";
import "./visual-verification.css";

const moment: TaskMomentPresentation = {
  kind: "scheduled",
  label: "Scheduled",
  dateLabel: "August 28, 2026",
  timeLabel: "14:30",
  due: { tier: "soon", tone: "caution" },
  repeating: true,
  title: "August 28, 2026 · 14:30",
};

export function VisualVerificationPage() {
  return (
    <main className="visual-verification">
      <section aria-label="Focused controls" className="visual-verification-section">
        <div
          className="property-picker visual-property-picker"
          data-testid="visual-focus-picker"
        >
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
          <BlockMarkdown markdown={"## Shared meaning — **compact** projection"} variant="compact" />
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
                {["Status", "Scheduled", "Text", "Markdown"].map((label) => (
                  <th key={label} scope="col">
                    <div className="query-th"><span>{label}</span></div>
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
                </tr>
              ))}
            </tbody>
          </table>
        </article>
      </section>
    </main>
  );
}
