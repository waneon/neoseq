import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DiagnosticsCoordinator } from "../../src/diagnostics/coordinator";
import type { DiagnosticStore } from "../../src/diagnostics/store";
import type {
  DiagnosticRecord,
  PersistedDiagnosticSession,
  SensitiveDiagnosticPayload,
} from "../../src/diagnostics/types";
import { DiagnosticsProvider, useDiagnostics } from "../../src/features/diagnostics/context";
import { RecordingStatus } from "../../src/features/diagnostics/RecordingStatus";
import { LocaleProvider } from "../../src/i18n";

class MemoryStore implements DiagnosticStore {
  async saveSession(_session: PersistedDiagnosticSession): Promise<void> {}
  async appendRecords(_id: string, _records: readonly DiagnosticRecord[]): Promise<void> {}
  async appendSensitivePayloads(_id: string, _payloads: readonly SensitiveDiagnosticPayload[]): Promise<void> {}
  async loadRecoverable(): Promise<null> { return null; }
  async deleteRecording(_id: string): Promise<void> {}
}

function StartControl() {
  const coordinator = useDiagnostics();
  return <button onClick={() => coordinator.requestStart()}>Open diagnostics</button>;
}

describe("diagnostic recording UI", () => {
  it("discloses collection before recording and keeps active recording visible", async () => {
    const coordinator = new DiagnosticsCoordinator(new MemoryStore());
    const user = userEvent.setup();
    render(
      <LocaleProvider initialPreference="en">
        <DiagnosticsProvider coordinator={coordinator}>
          <StartControl />
          <RecordingStatus />
        </DiagnosticsProvider>
      </LocaleProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Open diagnostics" }));
    expect(screen.getByRole("dialog", { name: "Record diagnostic evidence" })).toHaveTextContent(
      "Never recorded",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Note text and names");

    await user.click(screen.getByTestId("diagnostics-confirm-start"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("diagnostics-recording-status")).toHaveTextContent("Recording");

    await user.click(screen.getByTestId("diagnostics-recording-status"));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Review diagnostic artifact" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Standard capture excludes note content",
    );
    expect(screen.getByRole("button", { name: "Save artifact" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard recording" })).toBeInTheDocument();
  });

  it("requires scoped consent and a second confirmation for Enhanced export", async () => {
    const coordinator = new DiagnosticsCoordinator(new MemoryStore());
    coordinator.registerGraphContext({
      graph_id: "graph-one",
      active_page_id: "page-one",
      read: () => ({
        revision: 1,
        snapshot: {
          schema_version: 4,
          graph_id: "graph-one",
          tags: [],
          quarantined: [],
          pages: [{
            id: "page-one",
            title: "Page one",
            properties: [],
            tags: [],
            blocks: [],
          }],
        },
      }),
    });
    const user = userEvent.setup();
    render(
      <LocaleProvider initialPreference="en">
        <DiagnosticsProvider coordinator={coordinator}>
          <StartControl />
          <RecordingStatus />
        </DiagnosticsProvider>
      </LocaleProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Open diagnostics" }));
    await user.click(screen.getByText("Enhanced", { selector: "button" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Sensitive evidence");
    expect(screen.getByRole("dialog")).toHaveTextContent("Active page");
    await user.click(screen.getByTestId("diagnostics-confirm-start"));
    expect(screen.getByTestId("diagnostics-recording-status")).toHaveTextContent(
      "Enhanced recording",
    );

    await user.click(screen.getByTestId("diagnostics-recording-status"));
    await user.click(screen.getByTestId("diagnostics-download"));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "This file will contain user-authored graph content",
    );
    expect(screen.getByRole("button", { name: "Save sensitive artifact" })).toBeInTheDocument();
  });
});
