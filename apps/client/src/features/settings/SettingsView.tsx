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
import { LOCALE_DEFINITIONS, useI18n, type LocalePreference } from "../../i18n";

const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_MESSAGE = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
} as const;

export function SettingsView() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const state = useSessionState();
  const notify = useNotify();
  const {
    message,
    preference,
    setPreference,
    compare,
    formatBytes,
  } = useI18n();
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
  const bytes = (value: number | null | undefined) =>
    typeof value === "number" ? formatBytes(value) : message("common.unknown");

  // A blocked clipboard costs the shortcut, not the value: the id stays on
  // screen and selectable. The button going nowhere still needs explaining.
  const copyGraphId = () => {
    try {
      void navigator.clipboard
        ?.writeText(graphId)
        .then(() => setCopied(true))
        .catch((error: unknown) => {
          notify.failure(message("failure.copyGraphId"), error);
        });
    } catch (error) {
      notify.failure(message("failure.copyGraphId"), error);
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
          title: message("settings.persistDeclinedTitle"),
          detail: message("settings.persistDeclinedDetail"),
        });
      })
      .catch((error: unknown) => {
        notify.failure(message("failure.requestPersistence"), error);
      });
  };

  return (
    <div className="page-scroll">
      <main className="settings-body">
        <h1>{message("settings.title")}</h1>

        <section className="settings-section">
          <h2>{message("settings.appearance")}</h2>
          <p>{message("settings.appearanceDescription")}</p>
          <div
            className="segmented"
            role="group"
            aria-label={message("settings.appearance")}
            data-testid="settings-appearance"
          >
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={theme === option}
                onClick={() => {
                  setTheme(option);
                  setThemeState(option);
                }}
              >
                {message(THEME_MESSAGE[option])}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h2>{message("language.label")}</h2>
          <p>{message("language.description")}</p>
          <div className="field">
            <NativeSelect
              aria-label={message("language.label")}
              value={preference}
              data-testid="settings-language"
              onChange={(event) => setPreference(event.target.value as LocalePreference)}
            >
              <option value="system">{message("language.system")}</option>
              {LOCALE_DEFINITIONS.map((locale) => (
                <option key={locale.tag} value={locale.tag}>
                  {message(locale.labelKey)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </section>

        <section className="settings-section">
          <h2>{message("settings.graph")}</h2>
          <div className="field">
            <Input
              aria-label={message("graph.graphName")}
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
          <h2>{message("settings.timezone")}</h2>
          <p>{message("settings.timezoneDescription")}</p>
          <div className="field">
            <NativeSelect
              aria-label={message("settings.timezoneLabel")}
              value={timezone}
              data-testid="settings-timezone"
              onChange={(event) => {
                setTimezone(event.target.value);
                setConfiguredTimezone(event.target.value);
              }}
            >
              {[...availableTimezones()].sort(compare).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </NativeSelect>
          </div>
        </section>

        <section className="settings-section">
          <h2>{message("settings.storage")}</h2>
          {/* Only the two facts a user can act on. Everything that is merely
              informative moved into the Diagnostics disclosure below. */}
          <dl className="settings-grid">
            <dt>{message("settings.saveState")}</dt>
            <dd data-testid="settings-save-state">
              {state.save.kind === "saved"
                ? message("settings.saveStateSaved")
                : state.save.kind === "saving"
                  ? message("settings.saveStateSaving")
                  : message("settings.saveStateUnsaved")}
            </dd>
            <dt>{message("settings.persistentStorage")}</dt>
            <dd data-testid="settings-persisted">
              {persisted === null
                ? message("settings.persistUnknown")
                : persisted
                  ? message("settings.persistGranted")
                  : message("settings.persistNotGranted")}
            </dd>
          </dl>
          {persisted === false && (
            <Callout>
              {message("settings.storageEviction")}
              <button type="button" className="btn" onClick={requestPersistence}>
                {message("settings.requestPersistence")}
              </button>
            </Callout>
          )}
          {state.recovery && state.recovery.quarantined_records.length > 0 && (
            <Callout tone="danger">
              {message("settings.quarantined", {
                records: state.recovery.quarantined_records.join(", "),
              })}
            </Callout>
          )}
          <details className="settings-details">
            <summary>{message("settings.diagnostics")}</summary>
            <dl className="settings-grid">
              <dt>{message("settings.backend")}</dt>
              <dd>{capabilities?.durable ? "IndexedDB" : message("common.unavailable")}</dd>
              <dt>{message("settings.usage")}</dt>
              <dd>{bytes(capabilities?.usage_bytes)}</dd>
              <dt>{message("settings.quota")}</dt>
              <dd>{bytes(capabilities?.quota_bytes)}</dd>
              <dt>{message("settings.graphId")}</dt>
              <dd>
                <button
                  type="button"
                  aria-label={message("settings.graphId")}
                  onClick={copyGraphId}
                >
                  {copied ? message("common.copied") : graphId}
                </button>
              </dd>
            </dl>
          </details>
        </section>

        <section className="settings-section settings-danger">
          <h2>{message("settings.danger")}</h2>
          <p>{message("settings.deleteDescription")}</p>
          {deleteError && <p className="field-error">{deleteError}</p>}
          <button
            type="button"
            className="btn btn-danger"
            data-testid="settings-delete-graph"
            onClick={() => setConfirmDelete(true)}
          >
            {message("settings.deleteGraph")}
          </button>
        </section>

        {confirmDelete && (
          <Dialog title={message("graph.deleteTitle")} onClose={() => setConfirmDelete(false)}>
            <p>
              {message("graph.deleteConfirm", { name: graphName(graphId) })}
            </p>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                {message("common.cancel")}
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
                {message("common.deleteForever")}
              </button>
            </div>
          </Dialog>
        )}
      </main>
    </div>
  );
}
