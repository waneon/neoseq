// Settings is a dialog with two explicit scopes. Browser preferences apply to
// every graph; graph settings travel with the current graph. Keeping the active
// section in the URL makes sections linkable and lets Back close the dialog
// without losing editor context.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import {
  graphName,
  renameGraph,
  schedulePendingDelete,
  subscribeGraphDirectory,
} from "../../core-port/directory";
import {
  addDays,
  availableTimezones,
  setConfiguredTimezone,
  setJournalDateFormat,
  todayLocalDate,
} from "../../entities/journal";
import {
  DEFAULT_DUE_TIERS,
  JOURNAL_DATE_FORMATS,
  MAX_DUE_DAYS,
  updateDueTiers,
  type DueTierSettings,
  type JournalDateFormat,
  type ToneValue,
} from "../../entities/settings";
import { DUE_TIERS, type DueTier } from "../../entities/tasks";
import { CalendarIcon } from "lucide-react";
import { useConfiguredTimezone, useDueTiers } from "./preferences";
import { AccentField } from "./AccentField";
import { DefaultQueriesSection } from "./DefaultQueries";
import { ToneChoice } from "./ToneChoice";
import { tonePresentation } from "../tasks/tone-presentation";
import { Callout, ConfirmDialog, Dialog } from "../../ui/components";
import { setTheme, storedTheme, type Theme } from "../../ui/theme";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
import { MenuSelect } from "@/ui/menu-select";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
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

const DUE_TIER_MESSAGE = {
  overdue: "task.due.overdue",
  today: "task.due.today",
  soon: "task.due.soon",
  upcoming: "task.due.upcoming",
  later: "task.due.later",
} as const satisfies Record<DueTier, MessageKey>;

/** Which stored tone field each tier reads, so the row and the chip agree. */
const DUE_TONE_FIELD = {
  overdue: "overdueTone",
  today: "todayTone",
  soon: "soonTone",
  upcoming: "upcomingTone",
  later: "laterTone",
} as const satisfies Record<DueTier, keyof DueTierSettings>;

/** The two tiers whose reach the user sets, and the field each threshold is. */
const DUE_DAYS_FIELD = {
  soon: "soonDays",
  upcoming: "upcomingDays",
} as const satisfies Partial<Record<DueTier, keyof DueTierSettings>>;

/**
 * Where the open section lives. Any surface that has settings of its own points
 * at them through this one parameter, so there is one way in and Back is always
 * the way out.
 */
export const SETTINGS_PARAM = "settings";

/** The two scopes, in the order the dialog lists them. Sections come from here. */
const APP_SECTIONS = [
  "appearance",
  "language",
  "journal",
  "tasks",
  "keyboard",
  "storage",
] as const;
const GRAPH_SECTIONS = ["graph", "queries", "danger"] as const;

const SETTINGS_SECTIONS = [...APP_SECTIONS, ...GRAPH_SECTIONS];

export type SettingsSection = (typeof APP_SECTIONS)[number] | (typeof GRAPH_SECTIONS)[number];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}

const SECTION_MESSAGE = {
  appearance: "settings.appearance",
  language: "language.label",
  journal: "settings.journal",
  queries: "settings.defaultQueries",
  tasks: "settings.tasks",
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
          {section === "queries" && <DefaultQueriesSection />}
          {section === "tasks" && <TasksSection />}
          {section === "keyboard" && <ShortcutEditor />}
          {section === "storage" && <StorageSection />}
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
      <AccentField />
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
  const timezone = useConfiguredTimezone();
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
            onValueChange={setConfiguredTimezone}
          />
        </div>
      </section>
    </>
  );
}

/**
 * How far off a date has to be to read as urgent, and what urgent looks like.
 *
 * Both halves are the user's because neither is knowable from here: "soon" is a
 * week for someone planning a quarter and an hour for someone shipping today,
 * and which tone means "act now" is a habit people bring with them from whatever
 * they used before. What is *not* theirs is the shape — five ordered steps,
 * `overdue` first — because the ordering is what makes the tint readable at all.
 *
 * Each row previews itself with the real chip, in the real tone, at the real
 * size. A colour setting whose result you cannot see until you close the dialog
 * is a setting people change twice and then leave wrong.
 */
function TasksSection() {
  const { message, formatJournalDate } = useI18n();
  const tiers = useDueTiers();
  const today = todayLocalDate();
  // Thresholds count today as their first day, so their inclusive calendar end
  // is one less than the stored count. A zero-width tier has no date of its own
  // and keeps today's legible example.
  const exampleDay: Record<DueTier, number> = {
    overdue: -1,
    today: 0,
    soon: Math.max(tiers.soonDays - 1, 1),
    upcoming: Math.max(tiers.upcomingDays - 1, 1),
    later: tiers.upcomingDays + 7,
  };

  return (
    <section className="settings-section">
      <h2>{message("settings.tasks")}</h2>
      <p>{message("settings.dueTonesDescription")}</p>
      <div className="due-tiers" data-testid="settings-due-tiers">
        {DUE_TIERS.map((tier) => {
          const tone = tiers[DUE_TONE_FIELD[tier]] as ToneValue;
          const daysField = DUE_DAYS_FIELD[tier as keyof typeof DUE_DAYS_FIELD];
          return (
            <div className="due-tier" key={tier}>
              <span className="due-tier-name">{message(DUE_TIER_MESSAGE[tier])}</span>
              {/* Not a control — the row's own controls follow it — so it is a
                  span carrying the chip's appearance and nothing of its verbs. */}
              <span
                className="task-chip"
                data-preview
                data-due={tier}
                {...tonePresentation(tone)}
                data-testid={`due-preview-${tier}`}
                // The preview is the column that gives when four tracks do not fit, so
                // it carries the whole of itself for a reader who lost the end of
                // it (designs/accessibility.md § Perception).
                title={formatJournalDate(addDays(today, exampleDay[tier]))}
              >
                <CalendarIcon aria-hidden />
                <span className="task-chip-value">
                  {formatJournalDate(addDays(today, exampleDay[tier]))}
                </span>
                {tier === "overdue" && (
                  <span className="task-chip-overdue">{message("task.overdue")}</span>
                )}
              </span>
              {daysField && (
                <label className="due-tier-days">
                  {/* Two slots rather than one sentence with a hole in it: the
                      number is a control, and which side of it the unit falls on
                      is the language's choice, not the layout's. */}
                  {message("settings.dueWithinLead")}
                  {/* A number in a sentence, not a field in a form: bespoke
                      rather than shadcn's `Input`, which *is* the inset field
                      this one is deliberately not (app.css § A number that reads
                      as a word). */}
                  <input
                    className="due-tier-input"
                    type="number"
                    min={0}
                    max={MAX_DUE_DAYS}
                    inputMode="numeric"
                    aria-label={message("settings.dueWithinDays", {
                      tier: message(DUE_TIER_MESSAGE[tier]),
                    })}
                    data-testid={`due-days-${tier}`}
                    value={String(tiers[daysField])}
                    onChange={(event) => {
                      const days = Number(event.target.value);
                      if (Number.isInteger(days) && days >= 0 && days <= MAX_DUE_DAYS) {
                        updateDueTiers({ [daysField]: days });
                      }
                    }}
                  />
                  {message("settings.dueWithinTrail")}
                </label>
              )}
              {/* The chip two columns left is already this row's preview at full
                  size, so the swatches need only be the colours themselves. */}
              <ToneChoice
                value={tone}
                defaultValue={DEFAULT_DUE_TIERS[DUE_TONE_FIELD[tier]] as ToneValue}
                onChange={(next) => updateDueTiers({ [DUE_TONE_FIELD[tier]]: next })}
                label={message("settings.dueToneFor", {
                  tier: message(DUE_TIER_MESSAGE[tier]),
                })}
                previewLabel={message(DUE_TIER_MESSAGE[tier])}
                tier={tier}
                testId={`due-tone-${tier}`}
              />
            </div>
          );
        })}
      </div>
      <Button
        variant="secondary"
        className="self-start"
        data-testid="due-tiers-reset"
        onClick={() => updateDueTiers(DEFAULT_DUE_TIERS)}
      >
        {message("settings.restoreDefaults")}
      </Button>
    </section>
  );
}

/**
 * Persistence permission and quota belong to the browser origin. Usage is the
 * logical Base+Tail/outbox/quarantine allocation of the currently open graph.
 */
function StorageSection() {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, formatBytes } = useI18n();
  const [persisted, setPersisted] = useState<boolean | null>(
    state.capabilities?.persisted ?? null,
  );

  useEffect(() => {
    let cancelled = false;
    void session.refreshCapabilities().catch(() => undefined);
    void navigator.storage?.persisted?.().then((value) => {
      if (!cancelled) setPersisted(value);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

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
          <Button variant="secondary" onClick={requestPersistence}>
            {message("settings.requestPersistence")}
          </Button>
        </Callout>
      )}
      <dl className="settings-grid">
        <dt>{message("settings.backend")}</dt>
        <dd>{capabilities?.durable ? "IndexedDB" : message("common.unavailable")}</dd>
        <dt>{message("settings.usage")}</dt>
        <dd>{bytes(capabilities?.usage_bytes)}</dd>
        <dt>{message("settings.quota")}</dt>
        <dd>{bytes(capabilities?.quota_bytes)}</dd>
      </dl>
    </section>
  );
}

function GraphSection({ graphId }: { graphId: string }) {
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const authoritativeName = useSyncExternalStore(
    subscribeGraphDirectory,
    () => graphName(graphId),
    () => graphName(graphId),
  );
  const [draftName, setDraftName] = useState<string | null>(null);
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
          value={draftName ?? authoritativeName}
          data-testid="settings-graph-name"
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => {
            const next = draftName?.trim();
            if (next) renameGraph(graphId, next);
            setDraftName(null);
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
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <section className="settings-section settings-danger">
      <h2>{message("settings.danger")}</h2>
      <p>{message("settings.deleteDescription")}</p>
      <Button
        ref={deleteButtonRef}
        variant="destructive"
        className="self-start"
        data-testid="settings-delete-graph"
        onClick={() => setConfirmDelete(true)}
      >
        {message("settings.deleteGraph")}
      </Button>
      {confirmDelete && (
        <ConfirmDialog
          title={message("graph.deleteTitle")}
          cancelLabel={message("common.cancel")}
          confirmLabel={message("common.deleteForever")}
          testId="settings-confirm-delete"
          returnFocus={() => deleteButtonRef.current}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() => {
            // The shell owns the open session; the picker performs the
            // deletion once the graph lease is released by the close.
            setConfirmDelete(false);
            onClose();
            schedulePendingDelete(graphId);
            navigate("/");
          }}
        >
          {message("graph.deleteConfirm", { name: graphName(graphId) })}
        </ConfirmDialog>
      )}
    </section>
  );
}
