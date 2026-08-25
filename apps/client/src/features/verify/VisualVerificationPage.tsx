// Test-build-only visual fixture. Production routing never imports it.
import { TaskMomentPicker } from "../properties/TaskMomentPicker";
import "./visual-verification.css";

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
              <span>Date · Time · Repeat</span>
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
    </main>
  );
}
