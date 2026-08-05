// Settings, as a dialog with two scopes.
//
// The split is the point. Half of what used to be on this page belongs to the
// browser — appearance, language, how a date is written, which keys do what —
// and applies to every graph the user opens. The other half belongs to *this*
// graph and travels with it. Presenting them in one flat column made "Delete
// this graph" look like a sibling of "Language", so each scope is a named group.
//
// The group headings used to carry a sentence each explaining how far the scope
// reached ("These apply to Neoseq in this browser, on every graph."). They are
// gone: two paragraphs of explanation inside a 168px navigation column, restating
// what `Application` and `This graph` already say, in a column whose job is to be
// scanned rather than read. The distinction now rests on the two headings and on
// the typography that separates a heading from a row (app.css § The group label),
// which is where it belonged.
//
// It is a dialog rather than a route because settings are an aside: you open
// them from wherever you are, change one thing, and come back to the same block
// with the same caret. The open section still lives in the URL, so the browser's
// own Back closes it and a link can point at one section.

import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { graphName, renameGraph, schedulePendingDelete } from "../../core-port/directory";
import {
  availableTimezones,
  configuredTimezone,
  setConfiguredTimezone,
  setJournalDateFormat,
  todayLocalDate,
} from "../../entities/journal";
import { JOURNAL_DATE_FORMATS, type JournalDateFormat } from "../../entities/settings";
import { Callout, Dialog } from "../../ui/components";
import { setTheme, storedTheme, type Theme } from "../../ui/theme";
import { Input } from "@/ui/shadcn/input";
import { MenuSelect } from "@/ui/menu-select";
import { Button } from "@/ui/shadcn/button";
import { useDiagnostics, useDiagnosticsState } from "../diagnostics/context";
import { useNotify } from "../notify/context";
import { useSessionState } from "../shell/session-context";
import { ShortcutEditor } from "./ShortcutEditor";
import {
  LOCALE_DEFINITIONS,
  journalDateOptions,
  useI18n,
  type LocalePreference,
  type MessageKey,
} from "../../i18n";

const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_MESSAGE = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
} as const;

const DATE_FORMAT_MESSAGE = {
  full: "settings.dateFormatFull",
  long: "settings.dateFormatLong",
  medium: "settings.dateFormatMedium",
  short: "settings.dateFormatShort",
  iso: "settings.dateFormatIso",
} as const satisfies Record<JournalDateFormat, MessageKey>;

/** The two scopes, in the order the dialog lists them. Sections come from here. */
const APP_SECTIONS = ["appearance", "language", "journal", "keyboard", "storage"] as const;
const GRAPH_SECTIONS = ["graph", "danger"] as const;

export const SETTINGS_SECTIONS = [...APP_SECTIONS, ...GRAPH_SECTIONS];

export type SettingsSection = (typeof APP_SECTIONS)[number] | (typeof GRAPH_SECTIONS)[number];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

const SECTION_MESSAGE = {
  appearance: "settings.appearance",
  language: "language.label",
  journal: "settings.journal",
  keyboard: "settings.keyboard",
  storage: "settings.storage",
  graph: "settings.graph",
  danger: "settings.danger",
} as const satisfies Record<SettingsSection, MessageKey>;

export function SettingsDialog({
  graphId,
  section,
  onSection,
  onClose,
}: {
  graphId: string;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const { message } = useI18n();

  return (
    <Dialog title={message("settings.title")} onClose={onClose} size="settings">
      <div className="settings-shell" data-testid="settings-dialog">
        <nav className="settings-nav" aria-label={message("settings.sections")}>
          <div className="settings-group">
            <h3>{message("settings.scopeApp")}</h3>
            {APP_SECTIONS.map((entry) => (
              <SectionTab
                key={entry}
                section={entry}
                current={section}
                onSelect={onSection}
              />
            ))}
          </div>
          <div className="settings-group">
            <h3>{message("settings.scopeGraph")}</h3>
            {GRAPH_SECTIONS.map((entry) => (
              <SectionTab
                key={entry}
                section={entry}
                current={section}
                onSelect={onSection}
              />
            ))}
          </div>
        </nav>
        {/* Keyed by section, so switching sections is a mount rather than a
            re-render and the pane can say that one thing replaced another. A
            settings section is a small amount of content arriving in a box that
            is already on screen and already the right size; with nothing to
            mark the swap, changing sections read as the dialog's contents
            glitching. `--dur-view` is short enough that the text is fully
            opaque before it can be read — or audited. */}
        <div className="settings-pane enter-fade-view" key={section}>
          {section === "appearance" && <AppearanceSection />}
          {section === "language" && <LanguageSection />}
          {section === "journal" && <JournalSection />}
          {section === "keyboard" && <ShortcutEditor />}
          {section === "storage" && <StorageSection onClose={onClose} />}
          {section === "graph" && <GraphSection graphId={graphId} />}
          {section === "danger" && <DangerSection graphId={graphId} onClose={onClose} />}
        </div>
      </div>
    </Dialog>
  );
}

function SectionTab({
  section,
  current,
  onSelect,
}: {
  section: SettingsSection;
  current: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}) {
  const { message } = useI18n();
  return (
    <button
      type="button"
      className="settings-tab"
      aria-current={section === current ? "true" : undefined}
      data-testid={`settings-tab-${section}`}
      onClick={() => onSelect(section)}
    >
      {message(SECTION_MESSAGE[section])}
    </button>
  );
}

function AppearanceSection() {
  const { message } = useI18n();
  const heading = useId();
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  return (
    <section className="settings-section">
      <h2 id={heading}>{message("settings.appearance")}</h2>
      <p>{message("settings.appearanceDescription")}</p>
      {/* Named by the heading it sits under rather than by a duplicate of it. */}
      <div
        className="segmented"
        role="group"
        aria-labelledby={heading}
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
  );
}

function LanguageSection() {
  const { message, preference, setPreference } = useI18n();
  return (
    <section className="settings-section">
      <h2>{message("language.label")}</h2>
      <p>{message("language.description")}</p>
      <div className="field">
        <MenuSelect
          label={message("language.label")}
          testId="settings-language"
          value={preference}
          options={[
            { value: "system", label: message("language.system") },
            ...LOCALE_DEFINITIONS.map((locale) => ({
              value: locale.tag,
              label: message(locale.labelKey),
            })),
          ]}
          onValueChange={(value) => setPreference(value as LocalePreference)}
        />
      </div>
    </section>
  );
}

/**
 * Timezone decides which day "today" is; the format decides how that day is
 * written. They are one section because a user who came here for either is
 * thinking about the same thing, and each option carries a live example so the
 * choice is made by reading it rather than by decoding its name.
 */
function JournalSection() {
  const { message, compare, formatLocalDate, journalDateFormat } = useI18n();
  const [timezone, setTimezone] = useState(configuredTimezone);
  const today = todayLocalDate();

  const example = (format: JournalDateFormat) => {
    const options = journalDateOptions(format);
    return options ? formatLocalDate(today, options) : today;
  };

  return (
    <>
      <section className="settings-section">
        <h2>{message("settings.dateFormat")}</h2>
        <p>{message("settings.dateFormatDescription")}</p>
        <div className="field">
          <MenuSelect
            label={message("settings.dateFormat")}
            testId="settings-date-format"
            value={journalDateFormat}
            options={JOURNAL_DATE_FORMATS.map((format) => ({
              value: format,
              label: message("settings.dateFormatOption", {
                label: message(DATE_FORMAT_MESSAGE[format]),
                example: example(format),
              }),
            }))}
            onValueChange={(value) => setJournalDateFormat(value as JournalDateFormat)}
          />
        </div>
      </section>
      <section className="settings-section">
        <h2>{message("settings.timezone")}</h2>
        <p>{message("settings.timezoneDescription")}</p>
        <div className="field">
          <MenuSelect
            label={message("settings.timezone")}
            testId="settings-timezone"
            value={timezone}
            options={[...availableTimezones()]
              .sort(compare)
              .map((zone) => ({ value: zone, label: zone }))}
            onValueChange={(value) => {
              setTimezone(value);
              setConfiguredTimezone(value);
            }}
          />
        </div>
      </section>
    </>
  );
}

/**
 * Storage the browser owns, not storage this graph owns: the persistence
 * permission and the origin's usage are the same numbers whichever graph is
 * open, which is why they sit in the application scope.
 */
function StorageSection({ onClose }: { onClose: () => void }) {
  const state = useSessionState();
  const notify = useNotify();
  const diagnostics = useDiagnostics();
  const diagnosticsState = useDiagnosticsState();
  const { message, formatBytes } = useI18n();
  const [persisted, setPersisted] = useState<boolean | null>(
    state.capabilities?.persisted ?? null,
  );

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
  const bytes = (value: number | null | undefined) =>
    typeof value === "number" ? formatBytes(value) : message("common.unknown");

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
    <section className="settings-section">
      <h2>{message("settings.storage")}</h2>
      <dl className="settings-grid">
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
      <details className="settings-details">
        <summary>{message("settings.diagnostics")}</summary>
        <p className="settings-detail-description">
          {message("diagnostics.settingsDescription")}
        </p>
        <div className="settings-diagnostic-actions">
          {diagnosticsState.phase === "recording" ? (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                void diagnostics.stop();
              }}
            >
              {message("diagnostics.stopAndReview")}
            </Button>
          ) : diagnosticsState.phase === "review" ? (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                diagnostics.showReview();
              }}
            >
              {message("diagnostics.review")}
            </Button>
          ) : (
            <Button
              disabled={diagnosticsState.phase !== "idle"}
              onClick={() => {
                onClose();
                diagnostics.requestStart();
              }}
              data-testid="settings-start-diagnostics"
            >
              {message("diagnostics.start")}
            </Button>
          )}
        </div>
        <dl className="settings-grid">
          <dt>{message("settings.backend")}</dt>
          <dd>{capabilities?.durable ? "IndexedDB" : message("common.unavailable")}</dd>
          <dt>{message("settings.usage")}</dt>
          <dd>{bytes(capabilities?.usage_bytes)}</dd>
          <dt>{message("settings.quota")}</dt>
          <dd>{bytes(capabilities?.quota_bytes)}</dd>
        </dl>
      </details>
    </section>
  );
}

function GraphSection({ graphId }: { graphId: string }) {
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const [name, setName] = useState(() => graphName(graphId));
  const [copied, setCopied] = useState(false);

  // The copy acknowledgement is a plain label swap on a timer — no animation,
  // because this surface is audited the instant it mounts.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

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

  return (
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
      <dl className="settings-grid">
        <dt>{message("settings.saveState")}</dt>
        <dd data-testid="settings-save-state">
          {state.save.kind === "saved"
            ? message("settings.saveStateSaved")
            : state.save.kind === "saving"
              ? message("settings.saveStateSaving")
              : message("settings.saveStateUnsaved")}
        </dd>
        <dt>{message("settings.graphId")}</dt>
        <dd>
          <button type="button" aria-label={message("settings.graphId")} onClick={copyGraphId}>
            {copied ? message("common.copied") : graphId}
          </button>
        </dd>
      </dl>
      {state.recovery && state.recovery.quarantined_records.length > 0 && (
        <Callout tone="danger">
          {message("settings.quarantined", {
            records: state.recovery.quarantined_records.join(", "),
          })}
        </Callout>
      )}
    </section>
  );
}

function DangerSection({ graphId, onClose }: { graphId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const { message } = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <section className="settings-section settings-danger">
      <h2>{message("settings.danger")}</h2>
      <p>{message("settings.deleteDescription")}</p>
      <button
        type="button"
        className="btn btn-danger self-start"
        data-testid="settings-delete-graph"
        onClick={() => setConfirmDelete(true)}
      >
        {message("settings.deleteGraph")}
      </button>
      {confirmDelete && (
        <Dialog title={message("graph.deleteTitle")} onClose={() => setConfirmDelete(false)}>
          <p>{message("graph.deleteConfirm", { name: graphName(graphId) })}</p>
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
                setConfirmDelete(false);
                onClose();
                schedulePendingDelete(graphId);
                navigate("/");
              }}
            >
              {message("common.deleteForever")}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
