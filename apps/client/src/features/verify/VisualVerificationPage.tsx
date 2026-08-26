// Test-build-only visual fixture. Production routing never imports it.
import { TaskMomentPicker } from "../properties/TaskMomentPicker";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { TaskMoment } from "../tasks/TaskMoment";
import type { TaskMomentPresentation } from "../tasks/moment-presentation";
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
      </section>
    </main>
  );
}
