import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckIcon, FolderIcon, PlusIcon, XIcon } from "lucide-react";
import type { Command } from "../../core-port/commands";
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
import { elementAnchor, type Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { Button } from "@/ui/shadcn/button";
import { useI18n, type MessageKey } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";

const QUICK_MARKS = ["📌", "🎯", "💡", "⭐️", "✅", "📚", "✍️", "🎨", "🧪", "🔧", "🌱", "🚀", "🏠"];

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

export function TagMark({
  tag,
  size = "sm",
  onOpen,
}: {
  tag: TagSnapshot;
  size?: "sm" | "lg";
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
      aria-haspopup="dialog"
      title={message("tags.customizeNamed", { name: tag.name })}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {body}
    </button>
  );
}

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
  const [original] = useState(() => ({
    icon: tagIcon(tag),
    color: tagColor(tag),
    group: tagGroup(tag),
  }));
  const [mark, setMark] = useState(original.icon ?? "");
  const [color, setColor] = useState(original.color);
  const [group, setGroup] = useState(original.group);
  const [groupOpen, setGroupOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const markInputId = useId();
  const markHintId = useId();
  const icon = normalizeTagIcon(mark);

  const save = async () => {
    if (submitting.current) return;
    const owner = { kind: "tag", tag_id: tag.id } as const;
    const changes = [
      [TAG_ICON_KEY, icon || null, original.icon],
      [TAG_COLOR_KEY, color, original.color],
      [TAG_GROUP_KEY, group?.trim() || null, original.group],
    ] as const;
    const commands: Command[] = changes.flatMap<Command>(([key, value, previous]) =>
      value === previous
        ? []
        : value === null
          ? [{ type: "remove_property" as const, owner, key }]
          : [
              {
                type: "set_property" as const,
                owner,
                key,
                value: { type: "string" as const, value },
              },
            ],
    );
    if (commands.length === 0) {
      onClose();
      return;
    }
    submitting.current = true;
    setPending(true);
    try {
      await session.execute({ type: "batch", commands });
      onClose();
    } catch (cause) {
      notify.failure(message("failure.customizeTag", { name: tag.name }), cause);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <AnchoredPanel
      anchor={anchor}
      label={message("tags.customizeNamed", { name: tag.name })}
      className="tag-identity tag-identity-editor"
      options={{ width: 344, minWidth: 280, maxHeight: 640 }}
      surfaceRef={panelRef}
      dismissOnExternalScroll
      trapFocus
      initialFocus={() =>
        panelRef.current?.querySelector<HTMLElement>('[data-testid="tag-mark-field"]') ?? null
      }
      testId="tag-identity"
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      onEscapeKeyDown={(event) => {
        if (submitting.current || groupOpen) event.preventDefault();
        if (groupOpen) setGroupOpen(false);
      }}
    >
      <header className="tag-identity-head">
        <strong>{message("tags.customize")}</strong>
        <Button
          variant="ghost"
          size="icon"
          aria-label={message("common.close")}
          disabled={pending}
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </header>
      <div className="tag-identity-body">
        <div className="tag-identity-preview" data-hue={color ?? undefined}>
          <span className="tag-identity-preview-mark" aria-hidden>
            {icon || "#"}
          </span>
          <div>
            <strong>{tag.name}</strong>
            <span>{group?.trim() || message("tags.ungrouped")}</span>
          </div>
        </div>
        <section className="tag-identity-section">
          <h3>{message("tags.mark")}</h3>
          <div className="tag-mark-grid" role="group" aria-label={message("tags.mark")}>
            <button
              type="button"
              className="tag-mark-option tag-mark-default"
              aria-label={message("tags.markClear")}
              title={message("tags.markClear")}
              aria-pressed={!icon}
              disabled={pending}
              onClick={() => setMark("")}
            >
              #
            </button>
            {QUICK_MARKS.map((option) => (
              <button
                key={option}
                type="button"
                className="tag-mark-option"
                aria-pressed={icon === option}
                aria-label={option}
                disabled={pending}
                onClick={() => setMark(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="tag-identity-custom-mark">
            <input
              id={markInputId}
              className="tag-mark-field"
              data-hue={color ?? undefined}
              data-icon={icon ? "true" : undefined}
              data-testid="tag-mark-field"
              aria-describedby={markHintId}
              value={mark}
              placeholder="#"
              disabled={pending}
              autoComplete="off"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setMark(event.target.value)}
              onBlur={() => setMark(icon)}
              onCompositionEnd={(event) => setMark(normalizeTagIcon(event.currentTarget.value))}
            />
            <div>
              <label htmlFor={markInputId}>{message("tags.customMark")}</label>
              <p id={markHintId}>{message("tags.customMarkHint")}</p>
            </div>
          </div>
        </section>
        <section className="tag-identity-section">
          <div className="tag-identity-section-heading">
            <h3>{message("tags.colour")}</h3>
            <span>{color ? message(COLOR_MESSAGE[color]) : message("tags.colourNone")}</span>
          </div>
          <div
            className="color-choice"
            data-kind="tag"
            role="group"
            aria-label={message("tags.colour")}
            data-testid="tag-colour-choice"
          >
            <button
              type="button"
              className="color-swatch"
              data-kind="none"
              aria-pressed={color === null}
              aria-label={message("tags.colourNone")}
              title={message("tags.colourNone")}
              disabled={pending}
              onClick={() => setColor(null)}
            >
              <CheckIcon aria-hidden />
            </button>
            {TAG_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                className="color-swatch"
                data-hue={option}
                aria-pressed={color === option}
                aria-label={message(COLOR_MESSAGE[option])}
                title={message(COLOR_MESSAGE[option])}
                data-testid={`tag-colour-${option}`}
                disabled={pending}
                onClick={() => setColor(option)}
              >
                <CheckIcon aria-hidden />
              </button>
            ))}
          </div>
        </section>
        <section className="tag-identity-section">
          <h3>{message("tags.group")}</h3>
          <TagGroupField
            value={group}
            onChange={setGroup}
            disabled={pending}
            open={groupOpen}
            onOpenChange={setGroupOpen}
          />
        </section>
      </div>
      <footer className="tag-identity-footer">
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          {message("common.cancel")}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={pending}
          aria-busy={pending}
          data-testid="tag-identity-done"
        >
          {message("common.done")}
        </Button>
      </footer>
    </AnchoredPanel>
  );
}

export function TagGroupField({
  value,
  onChange,
  disabled = false,
  id,
  open: controlledOpen,
  onOpenChange,
  testId = "tag-group-field",
}: {
  value: string | null;
  onChange: (group: string | null) => void;
  disabled?: boolean;
  id?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
}) {
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot,
  );
  const { message, compare } = useI18n();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const options = useMemo(() => {
    const typed = canonicalEntityName(value ?? "");
    const names = tagGroupNames(state.snapshot.tags, compare);
    const matches = names.filter((name) => !typed || canonicalEntityName(name).includes(typed));
    const rows: { value: string | null; label: string; create?: boolean }[] = matches.map(
      (name) => ({ value: name, label: name }),
    );
    if (!typed) rows.unshift({ value: null, label: message("tags.ungrouped") });
    if (typed && !names.some((name) => canonicalEntityName(name) === typed)) {
      rows.push({
        value: value?.trim() || null,
        label: message("tags.groupCreate", { name: value?.trim() ?? "" }),
        create: true,
      });
    }
    return rows;
  }, [state.snapshot.tags, compare, value, message]);
  const selectedIndex = Math.max(0, Math.min(active, options.length - 1));

  useEffect(() => {
    if (open)
      listRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, open]);

  const choose = (group: string | null) => {
    onChange(group);
    setOpen(false);
  };

  return (
    <div className="tag-group-field">
      <div className="tag-group-input">
        <FolderIcon aria-hidden />
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && options[selectedIndex] ? `${listId}-${selectedIndex}` : undefined
          }
          aria-label={message("tags.group")}
          placeholder={message("tags.findGroup")}
          value={value ?? ""}
          disabled={disabled}
          data-testid={testId}
          onChange={(event) => {
            const next = event.target.value;
            const existing = tagGroupNames(state.snapshot.tags, compare).find(
              (name) => canonicalEntityName(name) === canonicalEntityName(next),
            );
            onChange(existing ?? (next || null));
            setOpen(true);
            setActive(0);
          }}
          onFocus={(event) => {
            event.currentTarget.select();
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                open
                  ? (selectedIndex + direction + options.length) % Math.max(1, options.length)
                  : 0,
              );
              setOpen(true);
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              const option = options[selectedIndex];
              if (option) choose(option.value);
            }
          }}
        />
        {value && !disabled && (
          <button
            type="button"
            className="tag-group-reset"
            aria-label={message("tags.ungrouped")}
            onClick={() => choose(null)}
          >
            <XIcon aria-hidden />
          </button>
        )}
      </div>
      {open && inputRef.current && (
        <AnchoredPanel
          anchor={elementAnchor(inputRef.current.parentElement ?? inputRef.current)}
          id={listId}
          role="listbox"
          label={message("tags.group")}
          className="tag-group-options tag-group-popover"
          options={{ side: "top", matchAnchorWidth: true, maxHeight: 180 }}
          surfaceRef={listRef}
          returnFocus={() => inputRef.current}
          preserveAnchorFocus
          dismissOnExternalScroll
          onClose={() => setOpen(false)}
        >
          {options.map((option, index) => (
            <button
              key={option.value ?? "__ungrouped"}
              type="button"
              role="option"
              id={`${listId}-${index}`}
              aria-selected={!option.create && option.value === value}
              data-active={index === selectedIndex}
              tabIndex={-1}
              onPointerMove={() => setActive(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              {option.create ? <PlusIcon aria-hidden /> : <FolderIcon aria-hidden />}
              <span>{option.label}</span>
              {!option.create && option.value === value && <CheckIcon aria-hidden />}
            </button>
          ))}
        </AnchoredPanel>
      )}
    </div>
  );
}
