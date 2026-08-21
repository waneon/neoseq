// The command palette. This is the surface that pays for how bare the rest of
// the interface is (DESIGN.md § The Command Layer), so it is navigation-first,
// never blank, and always offers a way forward.
//
// Hand-rolled rather than pulled from a package: it needs direct control of
// aria-activedescendant, of caret restoration on close, and of the two motion
// constraints this codebase enforces (one arrival that finishes opaque early,
// and immediate unmount with no exit).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "lucide-react";
import { GROUP_ORDER, matchCommand, type Command, type CommandGroup } from "./registry";
import { Kbd } from "../../ui/kbd";
import { useNotify } from "../notify/context";
import { useI18n, type MessageKey } from "../../i18n";

const GROUP_MESSAGE = {
  Search: "commands.group.search",
  Pages: "commands.group.pages",
  Journal: "commands.group.journal",
  Block: "commands.group.block",
  Edit: "commands.group.edit",
  Graph: "commands.group.graph",
  App: "commands.group.app",
} as const satisfies Record<CommandGroup, MessageKey>;

interface Props {
  commands: Command[];
  /**
   * Query-dependent rows, prepended ahead of the fuzzy matches: a parsed date,
   * and the "Create page …" row that guarantees the list is never a dead end.
   */
  dynamic?(query: string): Command[];
  search?(query: string): Promise<Command[]>;
  onClose(): void;
}

interface Row {
  command: Command;
  score: number;
}

export function CommandPalette({ commands, dynamic, search, onClose }: Props) {
  const { message } = useI18n();
  const notify = useNotify();
  const [query, setQuery] = useState("");
  const [searchRows, setSearchRows] = useState<Command[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Where focus and the caret were when the palette opened, so closing without
  // navigating puts the user back exactly where they were mid-word.
  const restore = useRef<{
    element: HTMLElement | null;
    start: number | null;
    end: number | null;
  }>({ element: null, start: null, end: null });

  useLayoutEffect(() => {
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      restore.current = {
        element,
        start: element.selectionStart,
        end: element.selectionEnd,
      };
    } else if (element instanceof HTMLElement) {
      restore.current = { element, start: null, end: null };
    }
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let current = true;
    const trimmed = query.trim();
    if (!search || trimmed.length === 0) {
      setSearchRows([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void search(trimmed)
        .then((rows) => {
          if (current) setSearchRows(rows);
        })
        .catch((error: unknown) => {
          // Reporting matters here: silence is indistinguishable from "no
          // matches", and the difference is whether the graph was searched at
          // all. It goes to the one place every failure in this application
          // goes, keyed so a typist who keeps typing gets one report, not ten.
          if (!current) return;
          setSearchRows([]);
          notify.failure(message("failure.searchGraph"), error);
        });
    }, 160);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [message, notify, query, search]);

  const close = (restoreFocus: boolean) => {
    const saved = restore.current;
    onClose();
    if (!restoreFocus || !saved.element?.isConnected) return;
    saved.element.focus();
    if (
      saved.start !== null &&
      (saved.element instanceof HTMLTextAreaElement ||
        saved.element instanceof HTMLInputElement)
    ) {
      saved.element.setSelectionRange(saved.start, saved.end ?? saved.start);
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // A backstop for the one case the panel's own handler cannot see. The panel
  // holds a single focusable element, so a `⇥` off the input parks focus outside
  // it — and from there the keydown never reaches the panel and `⎋` would do
  // nothing at all, which for a modal surface means it is stuck. The panel's own
  // handler stops propagation, so this never fires twice for one press.
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current(true);
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  const groups = useMemo(() => {
    const trimmed = query.trim();
    const extras = dynamic?.(trimmed) ?? [];
    const scored: Row[] = [];
    for (const command of commands) {
      const score = matchCommand(command, trimmed);
      if (score === null) continue;
      scored.push({ command, score });
    }
    const byGroup = new Map<CommandGroup, Row[]>();
    for (const row of scored) {
      const bucket = byGroup.get(row.command.group);
      if (bucket) bucket.push(row);
      else byGroup.set(row.command.group, [row]);
    }
    const ordered: { group: CommandGroup; rows: Row[] }[] = [];
    if (searchRows.length > 0) {
      ordered.push({
        group: "Search",
        rows: searchRows.map((command) => ({ command, score: Number.MAX_SAFE_INTEGER })),
      });
    }
    // Query-dependent rows always lead: a typed date or a page to create is the
    // most specific thing the query can mean.
    if (extras.length > 0) {
      ordered.push({
        group: extras[0].group,
        rows: extras.map((command) => ({ command, score: Number.MAX_SAFE_INTEGER })),
      });
    }
    for (const group of GROUP_ORDER) {
      const rows = byGroup.get(group);
      if (!rows || rows.length === 0) continue;
      // Registry order is meaningful with an empty query, so only re-rank once
      // the user has actually typed something.
      if (trimmed.length > 0) rows.sort((left, right) => right.score - left.score);
      ordered.push({ group, rows });
    }
    return ordered;
  }, [commands, dynamic, query, searchRows]);

  const flat = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view without animating anything.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: "nearest",
    });
  }, [active, groups]);

  const runRow = (row: Row | undefined) => {
    if (!row || row.command.disabledReason) return;
    onClose();
    void row.command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Escape is decided BEFORE the IME guard, and it is the one key that is.
    //
    // The guard exists because a composition owns the keyboard outright, and for
    // every other key that is right. But `Escape` is not a character — it is the
    // way out of the surface — and while an IME is composing, the browser reports
    // `isComposing: true` on that keydown too. So a user typing 검색 into the
    // palette and then pressing Escape got nothing at all: the guard returned
    // first, the key never reached the close path, and the only exit left was the
    // pointer. The composition is abandoned along with the panel, which is what
    // dismissing a surface has always meant.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.nativeEvent.isComposing) return;
    // The palette is `aria-modal`, and a modal that hands focus to the rail
    // behind it on ⇥ is not one. It holds exactly one focusable element, so
    // trapping is simply refusing the key: focus has nowhere else to go inside,
    // and outside is where it must not land.
    if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, Math.max(flat.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runRow(flat[active]);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(flat.length - 1, 0));
    }
  };

  const activeId = flat[active] ? `cmdk-opt-${flat[active].command.id}` : undefined;
  let index = -1;

  // The backdrop is a SIBLING of the panel, not its parent: opacity on an ancestor
  // fades its children too, which would leave the palette's text compositing at
  // partial alpha the instant it is read. The scrim fades; the panel does not.
  return createPortal(
    <>
      <div className="cmdk-backdrop" aria-hidden />
      <div
        className="cmdk-scrim"
        data-testid="command-palette"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close(true);
        }}
      >
      <div
        className="cmdk enter-rise"
        role="dialog"
        aria-modal="true"
        aria-label={message("commands.palette")}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk-input-row">
          <SearchIcon aria-hidden />
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="cmdk-results"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label={message("commands.searchLabel")}
            placeholder={message("commands.searchPlaceholder")}
            data-testid="command-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ul
          ref={listRef}
          id="cmdk-results"
          className="cmdk-results"
          role="listbox"
          aria-label={message("commands.results")}
        >
          {flat.length === 0 && (
            <li className="cmdk-empty" role="status">
              {message("commands.searchResultsEmpty", { query: query.trim() })}
            </li>
          )}
          {groups.map(({ group, rows }, groupIndex) => (
            <li key={`${group}-${groupIndex}`} role="presentation">
              <div className="cmdk-group-title" role="presentation">
                {message(GROUP_MESSAGE[group])}
              </div>
              <ul
                role="group"
                aria-label={message(GROUP_MESSAGE[group])}
                className="m-0 list-none p-0"
              >
                {rows.map(({ command }) => {
                  index += 1;
                  const position = index;
                  return (
                    <li key={command.id} role="presentation">
                      <div
                        id={`cmdk-opt-${command.id}`}
                        role="option"
                        aria-selected={position === active}
                        aria-disabled={command.disabledReason ? true : undefined}
                        className="cmdk-row"
                        data-active={position === active}
                        data-disabled={command.disabledReason ? true : undefined}
                        data-testid={`cmd-${command.id}`}
                        onMouseMove={() => setActive(position)}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          runRow({ command, score: 0 });
                        }}
                      >
                        {command.icon}
                        <span className="label">{command.label}</span>
                        <span className="hint">
                          {command.disabledReason ?? command.hint ?? ""}
                        </span>
                        {command.binding && <Kbd parts={command.binding} />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        {/* The keys the palette answers to, stated where the palette is. It is
            the one overlay a reader is expected to drive entirely from the
            keyboard, and three eleven-pixel pairs at the foot of it is what
            every application this one competes with uses to teach that — and
            what closes the panel visually, so the last row no longer runs off a
            rounded edge into nothing. */}
        <div className="cmdk-footer" aria-hidden>
          <span className="cmdk-hint">
            <Kbd parts={["↑", "↓"]} />
            {message("commands.hintKeysNavigate")}
          </span>
          <span className="cmdk-hint">
            <Kbd parts={["⏎"]} />
            {message("commands.hintKeysSelect")}
          </span>
          <span className="cmdk-hint">
            <Kbd parts={["esc"]} />
            {message("commands.hintKeysClose")}
          </span>
        </div>
      </div>
      </div>
    </>,
    document.body,
  );
}
