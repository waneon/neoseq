import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { graphName, renameGraph, schedulePendingDelete } from "../../core-port/directory";
import {
  availableTimezones,
  configuredTimezone,
  setConfiguredTimezone,
} from "../../entities/journal";
import { Callout, Dialog } from "../../ui/components";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect } from "@/ui/shadcn/native-select";
import { useSessionState } from "../shell/session-context";

export function SettingsView() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const state = useSessionState();
  const [timezone, setTimezone] = useState(configuredTimezone);
  const [name, setName] = useState(() => graphName(graphId));
  const [persisted, setPersisted] = useState<boolean | null>(state.capabilities?.persisted ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void navigator.storage?.persisted?.().then((value) => {
      if (!cancelled) setPersisted(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const capabilities = state.capabilities;
  const formatBytes = (bytes: number | null | undefined) =>
    typeof bytes === "number" ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : "unknown";

  return (
    <div className="page-scroll">
      <main className="settings-body">
        <h1>Settings</h1>

        <section className="card" aria-label="Graph">
          <span className="eyebrow">Graph</span>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Input
              aria-label="Graph name"
              value={name}
              data-testid="settings-graph-name"
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                if (name.trim()) renameGraph(graphId, name);
              }}
            />
          </div>
          <p className="page-subtitle">Graph id: {graphId}</p>
        </section>

        <section className="card" aria-label="Journal timezone">
          <span className="eyebrow">Journal timezone</span>
          <p className="page-subtitle" style={{ margin: "4px 0 12px" }}>
            “Today” for journals is resolved in this IANA timezone.
          </p>
          <NativeSelect
            aria-label="Timezone"
            value={timezone}
            data-testid="settings-timezone"
            onChange={(event) => {
              setTimezone(event.target.value);
              setConfiguredTimezone(event.target.value);
            }}
          >
            {availableTimezones().map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </NativeSelect>
        </section>

        <section className="card" aria-label="Local storage">
          <span className="eyebrow">Local storage</span>
          <dl className="settings-grid" style={{ marginTop: 12 }}>
            <dt>Saved locally</dt>
            <dd data-testid="settings-save-state">
              {state.save.kind === "saved" ? "up to date" : state.save.kind}
            </dd>
            <dt>Durable backend</dt>
            <dd>{capabilities?.durable ? "IndexedDB" : "unavailable"}</dd>
            <dt>Persistent storage granted</dt>
            <dd data-testid="settings-persisted">
              {persisted === null ? "unknown" : persisted ? "yes" : "no"}
            </dd>
            <dt>Usage</dt>
            <dd>{formatBytes(capabilities?.usage_bytes)}</dd>
            <dt>Quota</dt>
            <dd>{formatBytes(capabilities?.quota_bytes)}</dd>
          </dl>
          {persisted === false && (
            <div style={{ marginTop: 12 }}>
              <Callout>
                The browser may evict this graph under storage pressure.
                <button
                  className="btn btn-utility"
                  onClick={() =>
                    void navigator.storage?.persist?.().then((granted) => setPersisted(granted))
                  }
                >
                  Request persistent storage
                </button>
              </Callout>
            </div>
          )}
          {state.recovery && state.recovery.quarantined_records.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Callout tone="danger">
                Quarantined records: {state.recovery.quarantined_records.join(", ")} — damaged
                bytes are kept for export and never silently dropped.
              </Callout>
            </div>
          )}
        </section>

        <section className="card" aria-label="Danger zone">
          <span className="eyebrow" style={{ color: "var(--color-danger)" }}>
            Danger zone
          </span>
          <p className="page-subtitle" style={{ margin: "4px 0 12px" }}>
            Deleting removes this graph's data from this browser permanently.
          </p>
          {deleteError && <p className="field-error">{deleteError}</p>}
          <button
            className="btn btn-danger"
            data-testid="settings-delete-graph"
            onClick={() => setConfirmDelete(true)}
          >
            Delete this graph…
          </button>
        </section>

        {confirmDelete && (
          <Dialog title="Delete graph" onClose={() => setConfirmDelete(false)}>
            <p>
              Permanently delete <strong>{graphName(graphId)}</strong> and all of its notes from
              this browser? This cannot be undone.
            </p>
            <div className="dialog-actions">
              <button className="btn btn-utility" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                data-testid="settings-confirm-delete"
                onClick={() => {
                  // The shell owns the open session; the picker performs the
                  // deletion once the graph lease is released by the close.
                  schedulePendingDelete(graphId);
                  navigate("/");
                }}
              >
                Delete forever
              </button>
            </div>
          </Dialog>
        )}
      </main>
    </div>
  );
}
