import { addDays } from "../../entities/calendar";
// Settings is a dialog with two explicit scopes. Browser preferences apply to
// every graph; graph settings travel with the current graph. Keeping the active
// section in the URL makes sections linkable and lets Back close the dialog
// without losing editor context.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import {
  deleteGraph,
  graphConnection,
  graphName,
  renameGraph,
  subscribeGraphDirectory,
} from "../../core-port/directory";
import {
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
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CopyIcon,
  DatabaseIcon,
  HardDriveIcon,
  KeyboardIcon,
  LanguagesIcon,
  ListFilterIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import { useConfiguredTimezone, useDueTiers } from "./preferences";
import { AccentField } from "./AccentField";
import { ThemePreview } from "./ThemePreview";
import { DefaultQueriesSection } from "./DefaultQueries";
import { ToneChoice } from "./ToneChoice";
import { tonePresentation } from "../tasks/tone-presentation";
import { Callout, ConfirmDialog, Dialog } from "../../ui/components";
import { setTheme, storedTheme, subscribeTheme, type Theme } from "../../ui/theme";
import { LOCAL_REPOSITORY_ID } from "../repositories/directory";
import { readAuthSession } from "../sync/auth";
import { deleteRemoteGraph, RemoteApiError } from "../sync/api";
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
import { writeClipboardText } from "@/lib/clipboard";

const THEMES = [
  { value: "light", label: "settings.themeLight", icon: SunIcon },
  { value: "dark", label: "settings.themeDark", icon: MoonIcon },
  { value: "system", label: "settings.themeSystem", icon: MonitorIcon },
] as const;

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

/** Navigation, page identity, and scope share one definition. URL ids stay stable. */
const SETTINGS_GROUPS = [
  {
    label: "settings.scopeApp",
    sections: [
      {
        id: "appearance",
        label: "settings.appearance",
        description: "settings.appearanceIntro",
        mobileDescription: "settings.mobileAppearance",
        icon: PaletteIcon,
      },
      {
        id: "language",
        label: "language.label",
        description: "settings.languageDescription",
        mobileDescription: "settings.mobileLanguage",
        icon: LanguagesIcon,
      },
      {
        id: "journal",
        label: "settings.journal",
        description: "settings.journalDescription",
        mobileDescription: "settings.mobileJournal",
        icon: CalendarIcon,
      },
      {
        id: "tasks",
        label: "settings.tasks",
        description: "settings.dueTonesDescription",
        mobileDescription: "settings.mobileTasks",
        icon: CircleCheckIcon,
      },
      {
        id: "keyboard",
        label: "settings.keyboard",
        description: "settings.keyboardDescription",
        mobileDescription: "settings.mobileKeyboard",
        icon: KeyboardIcon,
      },
      {
        id: "storage",
        label: "settings.storage",
        description: "settings.storageDescription",
        mobileDescription: "settings.mobileStorage",
        icon: HardDriveIcon,
      },
    ],
  },
  {
    label: "settings.scopeGraph",
    sections: [
      {
        id: "graph",
        label: "settings.graph",
        description: "settings.graphDescription",
        mobileDescription: "settings.mobileGraph",
        icon: DatabaseIcon,
      },
      {
        id: "queries",
        label: "settings.defaultQueries",
        description: "settings.defaultQueriesDescription",
        mobileDescription: "settings.mobileQueries",
        icon: ListFilterIcon,
      },
      {
        id: "danger",
        label: "settings.danger",
        description: "settings.dangerDescription",
        mobileDescription: "settings.mobileDanger",
        icon: Trash2Icon,
      },
    ],
  },
] as const;

const SETTINGS_SECTIONS = SETTINGS_GROUPS.flatMap((group) => [...group.sections]);
export type SettingsSection = "index" | (typeof SETTINGS_SECTIONS)[number]["id"];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return value === "index" || SETTINGS_SECTIONS.some((section) => section.id === value);
}

const COMPACT_SETTINGS = "(max-width: 600px)";

function subscribeCompactSettings(listener: () => void) {
  const media = window.matchMedia(COMPACT_SETTINGS);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function compactSettingsSnapshot() {
  return window.matchMedia(COMPACT_SETTINGS).matches;
}

export function SettingsDialog({
  repositoryId = "local",
  graphId,
  section,
  onSection,
  onClose,
}: {
  repositoryId?: string;
  graphId: string;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const heading = useId();
  const compact = useSyncExternalStore(
    subscribeCompactSettings,
    compactSettingsSnapshot,
    () => false,
  );
  const showIndex = compact && section === "index";
  const activeSection = section === "index" ? "appearance" : section;
  const activeTab = useRef<HTMLButtonElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const returnSection = useRef(activeSection);
  const navigationSection = compact ? returnSection.current : activeSection;
  const active = SETTINGS_SECTIONS.find((entry) => entry.id === activeSection)!;

  useEffect(() => {
    if (section !== "index") returnSection.current = section;
    if (compact && !showIndex) pageHeading.current?.focus({ preventScroll: true });
  }, [compact, section, showIndex]);

  useEffect(() => {
    const tab = activeTab.current;
    const reveal = () => tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    if (!tab?.parentElement || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(tab.parentElement);
    return () => observer.disconnect();
  }, [compact, section]);

  return (
    <Dialog title={message("settings.title")} onClose={onClose} size="settings">
      <div
        className="settings-shell"
        data-view={showIndex ? "index" : "section"}
        data-testid="settings-dialog"
      >
        {compact && !showIndex && (
          <button
            className="settings-back"
            type="button"
            aria-label={message("settings.mobileBack")}
            data-testid="settings-back"
            onClick={() => onSection("index")}
          >
            <ChevronLeftIcon aria-hidden />
          </button>
        )}
        {(!compact || showIndex) && (
          <nav className="settings-nav" aria-label={message("settings.sections")}>
            {SETTINGS_GROUPS.map((group) => (
              <div className="settings-group" key={group.label}>
                <h3>{message(group.label)}</h3>
                <div className="settings-group-links">
                  {group.sections.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      ref={entry.id === navigationSection ? activeTab : undefined}
                      autoFocus={entry.id === navigationSection}
                      className="settings-tab"
                      aria-current={!compact && entry.id === activeSection ? "page" : undefined}
                      aria-controls={!compact ? `${heading}-pane` : undefined}
                      data-destructive={entry.id === "danger" || undefined}
                      data-testid={`settings-tab-${entry.id}`}
                      onClick={() => onSection(entry.id)}
                    >
                      <span className="settings-tab-icon">
                        <entry.icon aria-hidden />
                      </span>
                      <span className="settings-tab-copy">
                        <span>{message(entry.label)}</span>
                        {compact && (
                          <span className="settings-tab-description">
                            {message(entry.mobileDescription)}
                          </span>
                        )}
                      </span>
                      {compact && <ChevronRightIcon className="settings-tab-chevron" aria-hidden />}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="settings-nav-note">
              <MonitorIcon aria-hidden />
              {message("settings.preferencesHint")}
            </p>
          </nav>
        )}
        {!showIndex && (
          <div
            className="settings-pane"
            id={`${heading}-pane`}
            key={activeSection}
            role="region"
            aria-labelledby={heading}
          >
            <header className="settings-page-header">
              <h2 id={heading} ref={pageHeading} tabIndex={compact ? -1 : undefined}>
                {message(active.label)}
              </h2>
              <p>{message(active.description)}</p>
            </header>
            <div className="settings-page-content">
              {activeSection === "appearance" && <AppearanceSection />}
              {activeSection === "language" && <LanguageSection />}
              {activeSection === "journal" && <JournalSection />}
              {activeSection === "queries" && <DefaultQueriesSection />}
              {activeSection === "tasks" && <TasksSection />}
              {activeSection === "keyboard" && <ShortcutEditor />}
              {activeSection === "storage" && <StorageSection />}
              {activeSection === "graph" && (
                <GraphSection repositoryId={repositoryId} graphId={graphId} />
              )}
              {activeSection === "danger" && (
                <DangerSection repositoryId={repositoryId} graphId={graphId} />
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function AppearanceSection() {
  const { message } = useI18n();
  const heading = useId();
  const theme = useSyncExternalStore<Theme>(subscribeTheme, storedTheme, storedTheme);
  return (
    <>
      <section className="settings-section">
        <h3 id={heading}>{message("settings.theme")}</h3>
        <p>{message("settings.appearanceDescription")}</p>
        {/* Named by the heading it sits under rather than by a duplicate of it. */}
        <div
          className="settings-themes"
          role="group"
          aria-labelledby={heading}
          data-testid="settings-appearance"
        >
          {THEMES.map((option) => (
            <button
              key={option.value}
              type="button"
              className="settings-theme"
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              <ThemePreview theme={option.value} />
              <span className="settings-theme-label">
                <option.icon aria-hidden />
                {message(option.label)}
                <CheckIcon className="settings-theme-check" aria-hidden />
              </span>
            </button>
          ))}
        </div>
      </section>
      <AccentField />
    </>
  );
}

function LanguageSection() {
  const { message, preference, setPreference } = useI18n();
  return (
    <section className="settings-section">
      <h3>{message("language.label")}</h3>
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
      {preference === "system" && <p>{message("settings.languageSystemDescription")}</p>}
      <div className="settings-reading-preview">
        <span className="settings-preview-label">
          <LanguagesIcon aria-hidden />
          {message("settings.preview")}
        </span>
        <p>{message("settings.languagePreview")}</p>
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
      <div className="settings-reading-preview">
        <span className="settings-preview-label">
          <CalendarIcon aria-hidden />
          {message("settings.preview")}
        </span>
        <p data-testid="settings-journal-preview">{example(journalDateFormat)}</p>
      </div>
      <section className="settings-section">
        <h3>{message("settings.dateFormat")}</h3>
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
        <h3>{message("settings.timezone")}</h3>
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
  // Preview each threshold's inclusive calendar end. A zero-width tier has no
  // future date of its own and keeps tomorrow's legible example.
  const exampleDay: Record<DueTier, number> = {
    overdue: -1,
    today: 0,
    soon: Math.max(tiers.soonDays, 1),
    upcoming: Math.max(tiers.upcomingDays, 1),
    later: tiers.upcomingDays + 7,
  };

  return (
    <section className="settings-section">
      <h3>{message("settings.dueSchedule")}</h3>
      <div className="due-tiers" data-testid="settings-due-tiers">
        <div className="due-tiers-heading" aria-hidden>
          <span>{message("settings.dueRange")}</span>
          <span>{message("settings.duePreview")}</span>
          <span>{message("settings.dueColor")}</span>
        </div>
        {DUE_TIERS.map((tier) => {
          const tone = tiers[DUE_TONE_FIELD[tier]] as ToneValue;
          const daysField = DUE_DAYS_FIELD[tier as keyof typeof DUE_DAYS_FIELD];
          return (
            <div className="due-tier" key={tier}>
              <div className="due-tier-detail">
                <span className="due-tier-name">{message(DUE_TIER_MESSAGE[tier])}</span>
                {!daysField && (
                  <span className="due-tier-range">
                    {message(
                      tier === "overdue"
                        ? "settings.dueBeforeToday"
                        : tier === "today"
                          ? "task.due.today"
                          : "settings.dueAfterUpcoming",
                    )}
                  </span>
                )}
                {daysField && (
                  <label className="due-tier-days">
                    {message("settings.dueWithinLead")}
                    <DueDaysInput
                      label={message("settings.dueWithinDays", {
                        tier: message(DUE_TIER_MESSAGE[tier]),
                      })}
                      testId={`due-days-${tier}`}
                      value={tiers[daysField]}
                      onChange={(days) => updateDueTiers({ [daysField]: days })}
                    />
                    {message("settings.dueWithinTrail")}
                  </label>
                )}
              </div>
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
              </span>
              {/* The adjacent date previews the tone at its actual product size. */}
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

/** Keep incomplete typing local while valid thresholds continue to preview live. */
function DueDaysInput({
  value,
  onChange,
  label,
  testId,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  testId: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="due-tier-input"
      type="number"
      min={0}
      max={MAX_DUE_DAYS}
      inputMode="numeric"
      aria-label={label}
      data-testid={testId}
      value={draft ?? String(value)}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const days = Number(next);
        if (next !== "" && Number.isInteger(days) && days >= 0 && days <= MAX_DUE_DAYS) {
          onChange(days);
        }
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
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
  const [persisted, setPersisted] = useState<boolean | null>(state.capabilities?.persisted ?? null);

  useEffect(() => {
    let cancelled = false;
    void session.refreshCapabilities().catch(() => undefined);
    void navigator.storage
      ?.persisted?.()
      .then((value) => {
        if (!cancelled) setPersisted(value);
      })
      .catch(() => undefined);
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
    <>
      <section className="settings-section">
        <h3>{message("settings.persistentStorage")}</h3>
        <p className="settings-storage-status" data-testid="settings-persisted">
          {persisted && <CheckIcon aria-hidden />}
          {persisted === null
            ? message("settings.persistUnknown")
            : persisted
              ? message("settings.persistGranted")
              : message("settings.persistNotGranted")}
        </p>
        {persisted === false && (
          <Callout>
            {message("settings.storageEviction")}
            <Button variant="secondary" onClick={requestPersistence}>
              {message("settings.requestPersistence")}
            </Button>
          </Callout>
        )}
      </section>
      <section className="settings-section">
        <div className="settings-storage-stats">
          <div>
            <span>{message("settings.usage")}</span>
            <strong>{bytes(capabilities?.usage_bytes)}</strong>
            <p>{message("settings.storageUsageDescription")}</p>
          </div>
          <div>
            <span>{message("settings.quota")}</span>
            <strong>{bytes(capabilities?.quota_bytes)}</strong>
            <p>{message("settings.storageQuotaDescription")}</p>
          </div>
        </div>
        <dl className="settings-grid">
          <div>
            <dt>{message("settings.backend")}</dt>
            <dd>{capabilities?.durable ? "IndexedDB" : message("common.unavailable")}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}

function GraphSection({ repositoryId, graphId }: { repositoryId: string; graphId: string }) {
  const state = useSessionState();
  const notify = useNotify();
  const { message } = useI18n();
  const nameId = useId();
  const authoritativeName = useSyncExternalStore(
    subscribeGraphDirectory,
    () => graphName(repositoryId, graphId),
    () => graphName(repositoryId, graphId),
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
    void writeClipboardText(graphId)
      .then(() => setCopied(true))
      .catch((error: unknown) => {
        notify.failure(message("failure.copyGraphId"), error);
      });
  };

  return (
    <section className="settings-section">
      <div className="field">
        <label className="settings-field-label" htmlFor={nameId}>
          {message("graph.graphName")}
        </label>
        <Input
          id={nameId}
          aria-label={message("graph.graphName")}
          value={draftName ?? authoritativeName}
          disabled={repositoryId !== "local"}
          data-testid="settings-graph-name"
          data-escape-cancel={draftName !== null ? "true" : undefined}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape" && draftName !== null) {
              event.preventDefault();
              event.stopPropagation();
              setDraftName(null);
            }
          }}
          onBlur={() => {
            const next = draftName?.trim();
            if (next) renameGraph(repositoryId, graphId, next);
            setDraftName(null);
          }}
        />
      </div>
      {repositoryId !== LOCAL_REPOSITORY_ID && <p>{message("settings.graphNameRemote")}</p>}
      <dl className="settings-grid">
        <div>
          <dt>{message("settings.saveState")}</dt>
          <dd data-testid="settings-save-state">
            {state.save.kind === "saved"
              ? message("settings.saveStateSaved")
              : state.save.kind === "saving"
                ? message("settings.saveStateSaving")
                : message("settings.saveStateUnsaved")}
          </dd>
        </div>
        <div>
          <dt>{message("settings.graphId")}</dt>
          <dd>
            <button type="button" aria-label={message("settings.graphId")} onClick={copyGraphId}>
              <span aria-live="polite">{copied ? message("common.copied") : graphId}</span>
              {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            </button>
          </dd>
        </div>
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

function DangerSection({ repositoryId, graphId }: { repositoryId: string; graphId: string }) {
  const navigate = useNavigate();
  const session = useSession();
  const { message } = useI18n();
  const notify = useNotify();
  const [confirmDelete, setConfirmDelete] = useState<"device" | "server" | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const serverDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteStarted = useRef(false);
  const serverDeleted = useRef(false);
  const local = repositoryId === LOCAL_REPOSITORY_ID;
  const connection = graphConnection(repositoryId, graphId);
  const server = confirmDelete === "server";

  const closeConfirmation = () => {
    setConfirmDelete(null);
    // Once deletion has retired the owning session, the old graph surface is
    // no longer a safe place to return to — whether the storage deletion
    // succeeded or the user abandons a failed attempt.
    if (deleteStarted.current) navigate("/");
  };

  return (
    <section className="settings-section settings-danger">
      <div className="settings-danger-action">
        <Trash2Icon aria-hidden />
        <h3>{message(local ? "graph.deleteTitle" : "graph.removeReplicaTitle")}</h3>
        <p>{message(local ? "settings.deleteDescription" : "settings.removeReplicaDescription")}</p>
        <Button
          ref={deleteButtonRef}
          variant="destructive"
          className="self-start"
          data-testid="settings-delete-graph"
          onClick={() => setConfirmDelete("device")}
        >
          {message(local ? "settings.deleteGraph" : "settings.removeReplica")}
        </Button>
      </div>
      {connection?.role === "owner" && (
        <div className="settings-danger-action">
          <h3>{message("graph.deleteServerTitle")}</h3>
          <p>{message("graph.deleteServerConfirm", { name: graphName(repositoryId, graphId) })}</p>
          <Button
            ref={serverDeleteButtonRef}
            variant="destructive"
            className="self-start"
            data-testid="settings-delete-server-graph"
            disabled={!readAuthSession(repositoryId)}
            onClick={() => setConfirmDelete("server")}
          >
            {message("graph.deleteServer")}
          </Button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={message(
            server
              ? "graph.deleteServerTitle"
              : local
                ? "graph.deleteTitle"
                : "graph.removeReplicaTitle",
          )}
          cancelLabel={message("common.cancel")}
          confirmLabel={message(
            local || server ? "common.deleteForever" : "graph.removeReplicaAction",
          )}
          testId="settings-confirm-delete"
          returnFocus={() => (server ? serverDeleteButtonRef.current : deleteButtonRef.current)}
          onClose={closeConfirmation}
          onConfirm={async () => {
            if (server && !serverDeleted.current) {
              const auth = readAuthSession(repositoryId);
              if (!connection || !auth) throw new RemoteApiError(401, "sign in required");
              await deleteRemoteGraph(connection.server_url, auth, graphId);
              serverDeleted.current = true;
            }
            deleteStarted.current = true;
            // Release the current graph's lease first, then perform the same
            // durable deletion used by the graph picker. ConfirmDialog stays
            // pending across both operations and closes only after success.
            await session.close();
            await deleteGraph(repositoryId, graphId);
          }}
          onConfirmError={(cause) =>
            notify.failure(
              message("failure.deleteGraph", { name: graphName(repositoryId, graphId) }),
              cause,
            )
          }
        >
          {message(
            server
              ? "graph.deleteServerConfirm"
              : local
                ? "graph.deleteConfirm"
                : "graph.removeReplicaConfirm",
            {
              name: graphName(repositoryId, graphId),
            },
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}
