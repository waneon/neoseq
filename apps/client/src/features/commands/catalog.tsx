import {
  AlarmClockIcon,
  CalendarDaysIcon,
  CalendarIcon,
  CircleCheckIcon,
  FileTextIcon,
  FlagIcon,
  HashIcon,
  InfoIcon,
  KeyboardIcon,
  LayoutGridIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  Redo2Icon,
  Settings2Icon,
  SettingsIcon,
  Trash2Icon,
  Undo2Icon,
  UsersIcon,
} from "lucide-react";
import type { PageSnapshot, TagSnapshot } from "../../core-port/snapshot";
import { pageTitle } from "../../core-port/snapshot";
import { addDays } from "../../entities/journal";
import type { MessageFunction } from "../../i18n";
import { nextTheme, type Theme } from "../../ui/theme";
import type { HistoryActions, HistoryInvocation } from "../history/context";
import type { Notifier } from "../notify/context";
import type { CommandBridge } from "./context";
import type { Command } from "./registry";
import {
  formatBindingParts,
  type Binding,
  type ShortcutId,
} from "./shortcuts";

export interface CommandInputs {
  pages: PageSnapshot[];
  tags: TagSnapshot[];
  graphId: string;
  today: string;
  currentDate: string | null;
  readonly: boolean;
  theme: Theme;
  railCollapsed: boolean;
  navigate: (to: string) => void;
  createPage: (title?: string) => Promise<void>;
  onExit: () => void;
  notify: Notifier;
  bridge: CommandBridge;
  openMembers: (() => void) | null;
  toggleRail: () => void;
  applyTheme: (next: Theme) => void;
  message: MessageFunction;
  formatJournalDate: (date: string) => string;
  bindings: Record<ShortcutId, Binding>;
  history: HistoryActions;
  commandAvailability: ReturnType<CommandBridge["availability"]>;
}

export function runHistory(
  history: HistoryActions,
  notify: Notifier,
  message: MessageFunction,
  redo: boolean,
  invocation: HistoryInvocation,
): Promise<void> {
  return history
    .run(redo ? "redo" : "undo", invocation)
    .then(() => undefined)
    .catch((error: unknown) => {
      notify.failure(redo ? message("failure.redo") : message("failure.undo"), error);
    });
}

const THEME_MESSAGE = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
} as const;

/**
 * The application command catalog. All routes render these same command
 * objects, so label, binding, availability, and execution cannot drift between
 * the palette, shortcuts, and overflow menu.
 */
export function buildCommands(input: CommandInputs): Command[] {
  const {
    pages,
    tags,
    graphId,
    today,
    currentDate,
    readonly,
    theme,
    navigate,
    createPage,
    onExit,
    notify,
    bridge,
    openMembers,
    toggleRail,
    railCollapsed,
    applyTheme,
    message,
    formatJournalDate,
    bindings,
    history,
    commandAvailability,
  } = input;
  const blocked = readonly ? message("commands.readonlyReason") : null;
  const noPropertyTarget = commandAvailability.properties
    ? null
    : message("commands.noPropertyTargetReason");
  const noPageTarget = commandAvailability.pageInfo
    ? null
    : message("commands.noPageTargetReason");
  const noDeletablePage = commandAvailability.pageDelete
    ? null
    : message("commands.noDeletablePageReason");
  const commands: Command[] = [];

  for (const page of pages) {
    const title = pageTitle(page);
    commands.push({
      id: `page-${page.id}`,
      group: "Pages",
      label: title,
      keywords: ["open page", "go to"],
      hint: message("commands.hintPage"),
      icon: <FileTextIcon aria-hidden />,
      pointerRoute: message("shell.pages"),
      run: () => navigate(`/g/${graphId}/p/${page.id}`),
    });
  }

  for (const tag of tags) {
    commands.push({
      id: `tag-${tag.id}`,
      group: "Tags",
      label: `#${tag.name}`,
      keywords: ["open tag", "go to"],
      hint: message("commands.hintTag"),
      icon: <HashIcon aria-hidden />,
      pointerRoute: message("shell.tags"),
      run: () => navigate(`/g/${graphId}/t/${tag.id}`),
    });
  }

  commands.push({
    id: "new-page",
    group: "Pages",
    label: message("commands.label.newPage"),
    keywords: ["create", "add page"],
    icon: <PlusIcon aria-hidden />,
    disabledReason: blocked,
    pointerRoute: message("shortcuts.newPageRoute"),
    run: () => void createPage(),
  });

  commands.push(
    {
      id: "page-info",
      group: "Pages",
      label: message("commands.label.pageInfo"),
      keywords: ["details", "created", "updated"],
      icon: <InfoIcon aria-hidden />,
      disabledReason: noPageTarget,
      pointerRoute: message("shortcuts.pageDetailsRoute"),
      run: () => { bridge.requestPageInfo(); },
    },
    {
      id: "delete-page",
      group: "Pages",
      label: message("commands.label.deletePage"),
      keywords: ["remove page", "trash"],
      icon: <Trash2Icon aria-hidden />,
      disabledReason: blocked ?? noDeletablePage,
      pointerRoute: message("shortcuts.deletePageRoute"),
      run: () => { bridge.requestPageDelete(); },
    },
  );

  commands.push({
    id: "journal-today",
    group: "Journal",
    label: message("commands.label.todayJournal"),
    keywords: ["today", "journal", "daily"],
    hint: formatJournalDate(today),
    icon: <CalendarDaysIcon aria-hidden />,
    pointerRoute: message("shell.journal"),
    run: () => navigate(`/g/${graphId}/journal`),
  });

  if (currentDate) {
    commands.push(
      {
        id: "journal-prev",
        group: "Journal",
        label: message("commands.label.previousDay"),
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: message("shortcuts.nextPrevDayRoute"),
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, -1)}`),
      },
      {
        id: "journal-next",
        group: "Journal",
        label: message("commands.label.nextDay"),
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: message("shortcuts.nextPrevDayRoute"),
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, 1)}`),
      },
    );
  }

  commands.push({
    id: "properties",
    group: "Block",
    label: message("commands.label.properties"),
    keywords: ["property", "tag", "metadata"],
    binding: formatBindingParts(bindings.properties),
    hint: message("commands.pagePropertiesHint"),
    icon: <Settings2Icon aria-hidden />,
    disabledReason: noPropertyTarget,
    pointerRoute: message("shortcuts.blockActionsRoute"),
    run: () => { bridge.requestProperties(); },
  });

  commands.push(
    {
      id: "set-status",
      group: "Block",
      label: message("commands.label.setStatus"),
      keywords: ["task", "status", "todo", "done", "상태"],
      hint: message("commands.pagePropertiesHint"),
      icon: <CircleCheckIcon aria-hidden />,
      disabledReason: noPropertyTarget,
      pointerRoute: message("shortcuts.slashRoute"),
      run: () => { bridge.requestProperties("builtin.task-status"); },
    },
    {
      id: "set-priority",
      group: "Block",
      label: message("commands.label.setPriority"),
      keywords: ["task", "priority", "우선순위"],
      hint: message("commands.pagePropertiesHint"),
      icon: <FlagIcon aria-hidden />,
      disabledReason: noPropertyTarget,
      pointerRoute: message("shortcuts.slashRoute"),
      run: () => { bridge.requestProperties("builtin.task-priority"); },
    },
    {
      id: "set-scheduled",
      group: "Block",
      label: message("commands.label.setScheduled"),
      keywords: ["task", "scheduled", "schedule", "date", "예정"],
      hint: message("commands.pagePropertiesHint"),
      icon: <CalendarIcon aria-hidden />,
      disabledReason: noPropertyTarget,
      pointerRoute: message("shortcuts.slashRoute"),
      run: () => { bridge.requestProperties("builtin.task-scheduled"); },
    },
    {
      id: "set-deadline",
      group: "Block",
      label: message("commands.label.setDeadline"),
      keywords: ["task", "deadline", "due", "마감"],
      hint: message("commands.pagePropertiesHint"),
      icon: <AlarmClockIcon aria-hidden />,
      disabledReason: noPropertyTarget,
      pointerRoute: message("shortcuts.slashRoute"),
      run: () => { bridge.requestProperties("builtin.task-deadline"); },
    },
  );

  commands.push(
    {
      id: "undo",
      group: "Edit",
      label: message("commands.label.undo"),
      binding: formatBindingParts(bindings.undo),
      icon: <Undo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("commands.paletteRoute"),
      run: () => void runHistory(history, notify, message, false, { kind: "palette" }),
    },
    {
      id: "redo",
      group: "Edit",
      label: message("commands.label.redo"),
      binding: formatBindingParts(bindings.redo),
      icon: <Redo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("commands.paletteRoute"),
      run: () => void runHistory(history, notify, message, true, { kind: "palette" }),
    },
  );

  commands.push({
    id: "tags",
    group: "Graph",
    label: message("commands.label.tags"),
    keywords: ["tags", "tag", "defaults", "태그"],
    hint: message("commands.tagsHint"),
    icon: <HashIcon aria-hidden />,
    pointerRoute: message("shell.tags"),
    run: () => navigate(`/g/${graphId}/tags`),
  });

  commands.push(
    {
      id: "settings",
      group: "Graph",
      label: message("commands.label.settings"),
      binding: formatBindingParts(bindings.settings),
      icon: <SettingsIcon aria-hidden />,
      pointerRoute: message("shell.settings"),
      run: () => bridge.openSettings(),
    },
    ...(openMembers
      ? [{
          id: "manage-members",
          group: "Graph",
          label: message("graph.manageMembers"),
          keywords: ["invite", "share", "collaborators", "revoke"],
          icon: <UsersIcon aria-hidden />,
          pointerRoute: message("shortcuts.switchGraphRoute"),
          run: openMembers,
        } satisfies Command]
      : []),
    {
      id: "all-graphs",
      group: "Graph",
      label: message("commands.label.allGraphs"),
      keywords: ["switch graph", "close graph"],
      icon: <LayoutGridIcon aria-hidden />,
      pointerRoute: message("shortcuts.switchGraphRoute"),
      run: onExit,
    },
  );

  commands.push(
    {
      id: "theme",
      group: "App",
      label: message("commands.appearance", { theme: message(THEME_MESSAGE[theme]) }),
      keywords: ["dark mode", "light mode", "theme"],
      hint: message("commands.appearanceHint", { theme: message(THEME_MESSAGE[nextTheme(theme)]) }),
      icon: <MoonIcon aria-hidden />,
      pointerRoute: message("settings.appearance"),
      run: () => applyTheme(nextTheme(theme)),
    },
    {
      id: "toggle-rail",
      group: "App",
      label: railCollapsed
        ? message("commands.label.showSidebar")
        : message("commands.label.hideSidebar"),
      binding: formatBindingParts(bindings.sidebar),
      icon: <PanelLeftIcon aria-hidden />,
      pointerRoute: message("shell.showSidebar"),
      run: toggleRail,
    },
    {
      id: "shortcuts",
      group: "App",
      label: message("commands.label.keyboardShortcuts"),
      binding: formatBindingParts(bindings.shortcuts),
      icon: <KeyboardIcon aria-hidden />,
      pointerRoute: message("shortcuts.customiseRoute"),
      run: () => bridge.openShortcuts(),
    },
  );

  return commands;
}
