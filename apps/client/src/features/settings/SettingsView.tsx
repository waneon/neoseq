import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { graphName, renameGraph, schedulePendingDelete } from "../../core-port/directory";
import {
  availableTimezones,
  configuredTimezone,
  setConfiguredTimezone,
} from "../../entities/journal";
import { Callout, Dialog } from "../../ui/components";
import { setTheme, storedTheme, type Theme } from "../../ui/theme";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect } from "@/ui/shadcn/native-select";
import { useNotify } from "../notify/context";
import { useSessionState } from "../shell/session-context";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsView() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const state = useSessionState();
  const notify = useNotify();
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [timezone, setTimezone] = useState(configuredTimezone);
  const [name, setName] = useState(() => graphName(graphId));
  const [persisted, setPersisted] = useState<boolean | null>(state.capabilities?.persisted ?? null);
  const [copied, setCopied] = useState(false);
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

  // The copy acknowledgement is a plain label swap on a timer — no animation,
  // because this surface is audited the instant it mounts.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const capabilities = state.capabilities;
  const formatBytes = (bytes: number | null | undefined) =>
    typeof bytes === "number" ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : "unknown";

  // A blocked clipboard costs the shortcut, not the value: the id stays on
  // screen and selectable. The button going nowhere still needs explaining.
  const copyGraphId = () => {
    try {
      void navigator.clipboard
        ?.writeText(graphId)
        .then(() => setCopied(true))
        .catch((error: unknown) => {
          notify.failure("Couldn’t copy the graph id", error);
        });
    } catch (error) {
      notify.failure("Couldn’t copy the graph id", error);
    }
  };

  // `persist()` resolves `false` when the browser declines, which changes
  // nothing on screen — the callout that prompted the request just stays put.
  const requestPersistence = () => {
    void navigator.storage
      ?.persist?.()
      .then((granted) => {
        setPersisted(granted);
        if (granted) return;
        notify.show({
          tone: "danger",
          key: "persist-declined",
          title: "The browser declined persistent storage",
          detail:
            "This graph can still be evicted under storage pressure. Adding NeoSeq to your home screen or bookmarks usually earns the permission.",
        });
      })
      .catch((error: unknown) => {
        notify.failure("Couldn’t request persistent storage", error);
      });
  };

  return (
    <div className="page-scroll">
      <main className="settings-body">
        <h1>Settings</h1>

        <section className="settings-section">
          <h2>Appearance</h2>
          <p>Light or dark. System follows whichever mode your operating system is in.</p>
          <div
            className="segmented"
            role="group"
            aria-label="Appearance"
            data-testid="settings-appearance"
          >
            {THEMES.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={theme === option.value}
                onClick={() => {
                  setTheme(option.value);
                  setThemeState(option.value);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h2>Graph</h2>
          <div className="field">
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
        </section>

        <section className="settings-section">
          <h2>Journal timezone</h2>
          <p>“Today” for journals is resolved in this IANA timezone.</p>
          <div className="field">
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
          </div>
        </section>

        <section className="settings-section">
          <h2>Storage</h2>
          {/* Only the two facts a user can act on. Everything that is merely
              informative moved into the Diagnostics disclosure below. */}
          <dl className="settings-grid">
            <dt>Saved locally</dt>
            <dd data-testid="settings-save-state">
              {state.save.kind === "saved" ? "up to date" : state.save.kind}
            </dd>
            <dt>Persistent storage</dt>
            <dd data-testid="settings-persisted">
              {persisted === null ? "unknown" : persisted ? "granted" : "not granted"}
            </dd>
          </dl>
          {persisted === false && (
            <Callout>
              The browser may evict this graph under storage pressure.
              <button type="button" className="btn" onClick={requestPersistence}>
                Request persistent storage
              </button>
            </Callout>
          )}
          {state.recovery && state.recovery.quarantined_records.length > 0 && (
            <Callout tone="danger">
              Quarantined records: {state.recovery.quarantined_records.join(", ")} — damaged bytes
              are kept for export and never silently dropped.
            </Callout>
          )}
          <details className="settings-details">
            <summary>Diagnostics</summary>
            <dl className="settings-grid">
              <dt>Durable backend</dt>
              <dd>{capabilities?.durable ? "IndexedDB" : "unavailable"}</dd>
              <dt>Usage</dt>
              <dd>{formatBytes(capabilities?.usage_bytes)}</dd>
              <dt>Quota</dt>
              <dd>{formatBytes(capabilities?.quota_bytes)}</dd>
              <dt>Graph id</dt>
              <dd>
                <button type="button" aria-label="Copy graph id" onClick={copyGraphId}>
                  {copied ? "Copied" : graphId}
                </button>
              </dd>
            </dl>
          </details>
        </section>

        <section className="settings-section settings-danger">
          <h2>Danger zone</h2>
          <p>Deleting removes this graph’s data from this browser permanently.</p>
          {deleteError && <p className="field-error">{deleteError}</p>}
          <button
            type="button"
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
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
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
