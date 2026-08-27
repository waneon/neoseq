// What a tag looks like and where it is filed — one mark, one editor.
//
// A tag already had a name and a set of defaults, and no way to be told apart
// from sixty others at a glance. It has three things now, and they belong
// together because they are all answers to "which tag is this": a **mark** (the
// reader's own emoji, or the `#` every tag was already wearing), a **colour**
// (one of the eight named hue steps the accent itself offers), and a **group**
// (a name it is filed under).
//
// **The mark is the control.** Wherever a tag appears as itself — a row in the
// manager, the title of its own page — the thing in front of its name is the
// button that opens this panel. That is the same move the query caption makes:
// the object is the disclosure, so nothing has to be parked beside it. There is
// exactly one editor for all three values, which is why "recolour it" and "move
// it" are not two different surfaces with two different pointer routes.
//
// Nothing here can produce an illegible tag. A colour is a *hue*: lightness and
// chroma stay the mode's, so a tag painted red is the same measured distance from
// the page as the accent is, in both modes and at every step
// (designs/foundations.md § Semantic Color). An emoji is one grapheme of text,
// rendered as text.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import type { TagSnapshot } from "../../core-port/snapshot";
import {
  normalizeTagIcon,
  TAG_COLOR_KEY,
  TAG_COLORS,
  TAG_GROUP_KEY,
  TAG_ICON_KEY,
  tagColor,
  tagGroup,
  tagGroupNames,
  tagIcon,
  type TagColor,
} from "../../entities/tag-identity";
import { canonicalEntityName } from "../../entities/names";
import type { Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { Input } from "@/ui/shadcn/input";
import { useI18n, type MessageKey } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";

/**
 * Quick marks, because most tags want one of these and nobody wants to hunt for
 * it. It is a shortcut, not a vocabulary: the field beside the grid takes any
 * grapheme the reader's own keyboard can produce, which is what keeps this list
 * from having to be complete.
 */
const QUICK_MARKS = [
  "📌", "🎯", "💡", "🔥", "⭐️", "❤️", "✅",
  "📚", "✍️", "🎨", "🧪", "🔧", "🌱", "🌍",
  "🏃", "🍳", "🎵", "🎬", "💰", "🏠", "✈️",
  "🗓", "📈", "🧠", "☕️", "🐛", "🚀", "🔒",
];

const COLOR_MESSAGE = {
  red: "accent.red",
  orange: "accent.orange",
  green: "accent.green",
  teal: "accent.teal",
  blue: "accent.blue",
  iris: "accent.iris",
  violet: "accent.violet",
  rose: "accent.rose",
} as const satisfies Record<TagColor, MessageKey>;

/**
 * The tag, as a mark: its emoji if it has one, and otherwise the `#` it has worn
 * all along. The `#` was already the default icon; this only makes it the tag's
 * own colour and gives it something to open.
 */
export function TagMark({
  tag,
  size = "sm",
  onOpen,
}: {
  tag: TagSnapshot;
  size?: "sm" | "lg";
  /** Absent means this is a reading of the mark, not the control that sets it. */
  onOpen?: (anchor: HTMLElement) => void;
}) {
  const { message } = useI18n();
  const icon = tagIcon(tag);
  const body = icon ?? <span className="hash">#</span>;
  const shared = {
    className: "tag-mark",
    "data-hue": tagColor(tag) ?? undefined,
    "data-size": size,
    "data-icon": icon ? "true" : undefined,
    "data-testid": "tag-mark",
  } as const;
  if (!onOpen) {
    return (
      <span {...shared} aria-hidden>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...shared}
      aria-label={message("tags.customizeNamed", { name: tag.name })}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {body}
    </button>
  );
}

/**
 * The one panel that writes a tag's mark, colour, and group. Three sections, all
 * of them visible at once: every value here is a *choice among a handful*, and a
 * choice among a handful is made by looking at the handful
 * (designs/foundations.md § Semantic Color).
 */
export function TagIdentityPicker({
  tag,
  anchor,
  onClose,
}: {
  tag: TagSnapshot;
  anchor: Anchor;
  onClose: () => void;
}) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const icon = tagIcon(tag);
  const color = tagColor(tag);

  const write = (key: string, value: string | null) => {
    const owner = { kind: "tag", tag_id: tag.id } as const;
    const command = value === null
      ? { type: "remove_property" as const, owner, key }
      : { type: "set_property" as const, owner, key, value: { type: "string" as const, value } };
    void session.execute(command).catch((cause: unknown) => {
      // The panel keeps showing the authoritative value, so a silent failure
      // reads as a press that never registered.
      notify.failure(message("failure.customizeTag", { name: tag.name }), cause);
    });
  };

  return (
    <AnchoredPanel
      anchor={anchor}
      label={message("tags.customizeNamed", { name: tag.name })}
      className="tag-identity"
      options={{ width: 296, minWidth: 264, maxHeight: 440 }}
      surfaceRef={panelRef}
      dismissOnExternalScroll
      trapFocus
      initialFocus={() => panelRef.current?.querySelector<HTMLElement>('[data-testid="tag-mark-field"]') ?? null}
      testId="tag-identity"
      onClose={onClose}
    >
      <section className="tag-identity-section">
        <h3>{message("tags.mark")}</h3>
        <div className="tag-identity-mark">
          {/* The field *is* the preview: the thing being edited is the thing you
              press. An emoji arrives from the platform's own picker as often as
              it is typed, so this stays a text field rather than a grid alone. */}
          <input
            className="tag-mark-field"
            data-hue={color ?? undefined}
            data-icon={icon ? "true" : undefined}
            data-testid="tag-mark-field"
            aria-label={message("tags.mark")}
            value={icon ?? ""}
            placeholder="#"
            onChange={(event) => {
              const next = normalizeTagIcon(event.target.value);
              write(TAG_ICON_KEY, next || null);
            }}
          />
          <button
            type="button"
            className="tag-identity-clear"
            disabled={!icon}
            onClick={() => write(TAG_ICON_KEY, null)}
          >
            {message("tags.markClear")}
          </button>
        </div>
        <div className="tag-mark-grid" role="group" aria-label={message("tags.mark")}>
          {QUICK_MARKS.map((mark) => (
            <button
              key={mark}
              type="button"
              className="tag-mark-option"
              aria-pressed={icon === mark}
              aria-label={mark}
              onClick={() => write(TAG_ICON_KEY, icon === mark ? null : mark)}
            >
              {mark}
            </button>
          ))}
        </div>
      </section>

      <section className="tag-identity-section">
        <h3>{message("tags.colour")}</h3>
        <div
          className="color-choice"
          data-kind="tag"
          role="group"
          aria-label={message("tags.colour")}
          data-testid="tag-colour-choice"
        >
          {/* "No colour" is a real answer and it is offered as one: a disc with
              nothing in it, in the same row as the eight that do. */}
          <button
            type="button"
            className="color-swatch"
            data-kind="none"
            aria-pressed={color === null}
            aria-label={message("tags.colourNone")}
            title={message("tags.colourNone")}
            onClick={() => write(TAG_COLOR_KEY, null)}
          >
            <CheckIcon aria-hidden />
          </button>
          {TAG_COLORS.map((option) => {
            const name = message(COLOR_MESSAGE[option]);
            return (
              <button
                key={option}
                type="button"
                className="color-swatch"
                data-hue={option}
                aria-pressed={color === option}
                aria-label={name}
                title={name}
                data-testid={`tag-colour-${option}`}
                onClick={() => write(TAG_COLOR_KEY, option)}
              >
                <CheckIcon aria-hidden />
              </button>
            );
          })}
        </div>
      </section>

      <section className="tag-identity-section">
        <h3>{message("tags.group")}</h3>
        <GroupField tag={tag} onChange={(next) => write(TAG_GROUP_KEY, next)} />
      </section>
    </AnchoredPanel>
  );
}

/**
 * Where the tag is filed. A group is a name, so this is a field with the names
 * already in use offered under it — picking one files the tag, typing a new one
 * creates that group by being its first member, and clearing it unfiles the tag.
 * There is nothing else to a group, which is the whole reason it is a name.
 */
function GroupField({
  tag,
  onChange,
}: {
  tag: TagSnapshot;
  onChange: (group: string | null) => void;
}) {
  const state = useSessionState();
  const { message, compare } = useI18n();
  const current = tagGroup(tag);
  const [draft, setDraft] = useState(current ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listId = useId();

  const cancelBlur = useCallback(() => {
    if (blurTimer.current === null) return;
    clearTimeout(blurTimer.current);
    blurTimer.current = null;
  }, []);

  useEffect(() => () => cancelBlur(), [cancelBlur]);

  // The authoritative group is the truth after a write or a remote edit; the
  // draft is the truth only while the reader is typing into it.
  useEffect(() => setDraft(current ?? ""), [current]);

  const options = useMemo(() => {
    const typed = canonicalEntityName(draft);
    const names = tagGroupNames(state.snapshot.tags, compare)
      .filter((name) => typed.length === 0 || canonicalEntityName(name).includes(typed));
    const exact = names.some((name) => canonicalEntityName(name) === typed);
    return { names: names.slice(0, 8), create: typed.length > 0 && !exact };
  }, [state.snapshot.tags, draft, compare]);

  const rows: { label: string; create?: boolean }[] = [
    ...options.names.map((name) => ({ label: name })),
    ...(options.create ? [{ label: draft.trim(), create: true }] : []),
  ];
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const commit = (name: string) => {
    const next = name.trim();
    setOpen(false);
    setDraft(next);
    if (next === (current ?? "")) return;
    onChange(next ? next : null);
  };

  return (
    <div className="autocomplete">
      <Input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
        aria-label={message("tags.group")}
        placeholder={message("tags.groupPlaceholder")}
        value={draft}
        data-testid="tag-group-field"
        onChange={(event) => {
          setDraft(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          cancelBlur();
          setOpen(true);
        }}
        onBlur={() => {
          cancelBlur();
          blurTimer.current = setTimeout(() => {
            blurTimer.current = null;
            setOpen(false);
            commit(draft);
          }, 150);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(index + 1, rows.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit(rows[active]?.label ?? draft);
          } else if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setDraft(current ?? "");
          }
        }}
      />
      {open && inputRef.current && (
        <AnchoredPanel
          anchor={inputRef.current}
          id={listId}
          role="listbox"
          label={message("tags.group")}
          className="ac-popover"
          options={{ matchAnchorWidth: true, maxWidth: 320, maxHeight: 220 }}
          revision={rows.length}
          surfaceRef={listRef}
          dismissOnExternalScroll
          preserveAnchorFocus
          onClose={() => setOpen(false)}
        >
          {rows.length === 0 ? (
            <div role="status" className="ac-hint">{message("tags.noGroups")}</div>
          ) : (
          <ul role="presentation" className="m-0 list-none p-0">
            {rows.map((row, index) => (
              <li key={row.create ? "__create" : row.label} role="presentation">
                <button
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  className="property-picker-option"
                  tabIndex={-1}
                  onPointerMove={() => setActive(index)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    cancelBlur();
                  }}
                  onClick={() => commit(row.label)}
                >
                  <span className="property-picker-candidate">
                    <span>
                      {row.create
                        ? message("tags.groupCreate", { name: row.label })
                        : row.label}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          )}
        </AnchoredPanel>
      )}
    </div>
  );
}
