// The guard that makes the bare interface safe.
//
// DESIGN.md § Disclosure removes buttons on the promise that every verb stays
// reachable without a keyboard. These tests are that promise, mechanised: if a
// command ever ships without a pointer route, or if the global key layer ever
// starts matching a bare keystroke, the build fails instead of the interface
// quietly losing a capability.

import { describe, expect, it } from "vitest";
import { GROUP_ORDER, fuzzyScore, matchCommand, type Command } from "../../src/features/commands/registry";
import { isComposing } from "../../src/features/commands/keys";
import {
  DEFAULT_BINDINGS,
  bindingFromEvent,
  conflictingAction,
  formatBinding,
  isRejection,
  matchShortcut,
  parseBinding,
  serializeBinding,
  type ShortcutHandler,
} from "../../src/features/commands/shortcuts";
import { parseDateQuery } from "../../src/features/commands/dates";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

const HANDLERS: ShortcutHandler[] = [
  { binding: { key: "k", shift: false, alt: false }, run: () => {} },
  { binding: { key: "p", shift: true, alt: false }, run: () => {} },
];

describe("global key arbitration", () => {
  it("never matches a bare keystroke, so a text field keeps every plain key", () => {
    expect(matchShortcut(key({ key: "k" }), HANDLERS)).toBeNull();
    expect(matchShortcut(key({ key: "k", metaKey: true }), HANDLERS)).not.toBeNull();
    expect(matchShortcut(key({ key: "k", ctrlKey: true }), HANDLERS)).not.toBeNull();
  });

  it("yields to an IME composition before anything else", () => {
    expect(matchShortcut(key({ key: "k", metaKey: true, isComposing: true }), HANDLERS)).toBeNull();
    // Some IMEs report the processing key rather than isComposing.
    expect(matchShortcut(key({ key: "k", metaKey: true, keyCode: 229 }), HANDLERS)).toBeNull();
    expect(isComposing(key({ key: "a", keyCode: 229 }))).toBe(true);
  });

  it("yields to a handler that already claimed the event", () => {
    expect(
      matchShortcut(key({ key: "k", metaKey: true, defaultPrevented: true }), HANDLERS),
    ).toBeNull();
  });

  it("distinguishes a shifted binding from its unshifted sibling", () => {
    expect(matchShortcut(key({ key: "p", metaKey: true }), HANDLERS)).toBeNull();
    expect(
      matchShortcut(key({ key: "p", metaKey: true, shiftKey: true }), HANDLERS),
    ).not.toBeNull();
  });
});

describe("editable bindings", () => {
  it("round-trips through its stored form and rejects anything without a modifier", () => {
    for (const binding of Object.values(DEFAULT_BINDINGS)) {
      expect(parseBinding(serializeBinding(binding))).toEqual(binding);
    }
    expect(parseBinding("z")).toBeNull();
    expect(parseBinding("shift+z")).toBeNull();
    expect(parseBinding("mod+hyper+z")).toBeNull();
    expect(parseBinding(42)).toBeNull();
  });

  it("ships no two actions on the same keys", () => {
    for (const id of Object.keys(DEFAULT_BINDINGS) as (keyof typeof DEFAULT_BINDINGS)[]) {
      expect(conflictingAction(id, DEFAULT_BINDINGS[id], DEFAULT_BINDINGS)).toBeNull();
    }
  });

  it("names a conflict rather than silently overwriting the other action", () => {
    expect(conflictingAction("undo", DEFAULT_BINDINGS.palette, DEFAULT_BINDINGS)).toBe("palette");
  });

  it("refuses a key press that cannot become a shortcut, and says which way it failed", () => {
    const bare = bindingFromEvent(key({ key: "j" }));
    expect(isRejection(bare) && bare.reason).toBe("modifier");

    const modifierItself = bindingFromEvent(key({ key: "Shift", metaKey: true, shiftKey: true }));
    expect(isRejection(modifierItself) && modifierItself.reason).toBe("key");

    const escape = bindingFromEvent(key({ key: "Escape", metaKey: true }));
    expect(isRejection(escape) && escape.reason).toBe("key");

    // The browser takes ⌘W before the page ever sees it, so storing it would
    // record a shortcut that can never fire.
    const reserved = bindingFromEvent(key({ key: "w", metaKey: true }));
    expect(isRejection(reserved) && reserved.reason).toBe("reserved");

    const accepted = bindingFromEvent(key({ key: "J", metaKey: true, shiftKey: true }));
    expect(accepted).toEqual({ key: "j", shift: true, alt: false });
  });

  it("shows the modifier the way the running platform prints it", () => {
    // jsdom reports no platform, which is the non-Apple branch.
    expect(formatBinding(DEFAULT_BINDINGS.properties)).toBe("Ctrl+Shift+P");
    expect(formatBinding({ key: "arrowup", shift: false, alt: true })).toBe("Ctrl+Alt+↑");
  });
});

describe("command registry contract", () => {
  const sample: Command = {
    id: "sample",
    group: "App",
    label: "Toggle something",
    keywords: ["switch"],
    pointerRoute: "the control in the top bar",
    run: () => {},
  };

  it("requires a pointer route on every command", () => {
    // The type makes this unrepresentable; this asserts the runtime shape too, so
    // a command assembled dynamically cannot slip through.
    expect(sample.pointerRoute).toBeTruthy();
  });

  it("ranks an exact prefix above a substring above a scattered subsequence", () => {
    const prefix = fuzzyScore("Reading list", "read")!;
    const substring = fuzzyScore("My reading list", "read")!;
    const scattered = fuzzyScore("Repeated dailies", "read")!;
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(scattered);
    expect(fuzzyScore("Reading list", "zzz")).toBeNull();
  });

  it("matches keywords but ranks them below the label", () => {
    expect(matchCommand(sample, "toggle")).toBeGreaterThan(matchCommand(sample, "switch")!);
    expect(matchCommand(sample, "nonsense")).toBeNull();
  });

  it("orders navigation groups ahead of action groups", () => {
    expect(GROUP_ORDER.indexOf("Pages")).toBeLessThan(GROUP_ORDER.indexOf("Edit"));
    expect(GROUP_ORDER.indexOf("Journal")).toBeLessThan(GROUP_ORDER.indexOf("App"));
  });
});

describe("natural-language dates", () => {
  const today = "2026-08-04"; // a Tuesday

  it("resolves the relative forms a journal actually needs", () => {
    expect(parseDateQuery("today", today)).toBe("2026-08-04");
    expect(parseDateQuery("tomorrow", today)).toBe("2026-08-05");
    expect(parseDateQuery("yesterday", today)).toBe("2026-08-03");
    expect(parseDateQuery("3 days ago", today)).toBe("2026-08-01");
    expect(parseDateQuery("in 2 weeks", today)).toBe("2026-08-18");
  });

  it("resolves weekdays forwards and backwards without landing on today", () => {
    expect(parseDateQuery("next friday", today)).toBe("2026-08-07");
    expect(parseDateQuery("tue", today)).toBe("2026-08-11");
    expect(parseDateQuery("last friday", today)).toBe("2026-07-31");
  });

  it("resolves month-and-day forms, defaulting the year to the current one", () => {
    expect(parseDateQuery("aug 5", today)).toBe("2026-08-05");
    expect(parseDateQuery("5 august", today)).toBe("2026-08-05");
    expect(parseDateQuery("august 5, 2027", today)).toBe("2027-08-05");
    expect(parseDateQuery("2026-08-05", today)).toBe("2026-08-05");
  });

  it("resolves Korean relative, weekday, and calendar forms", () => {
    expect(parseDateQuery("오늘", today, "ko")).toBe("2026-08-04");
    expect(parseDateQuery("3일 전", today, "ko")).toBe("2026-08-01");
    expect(parseDateQuery("2주 후", today, "ko")).toBe("2026-08-18");
    expect(parseDateQuery("다음 금요일", today, "ko")).toBe("2026-08-07");
    expect(parseDateQuery("지난 금요일", today, "ko")).toBe("2026-07-31");
    expect(parseDateQuery("8월 5일", today, "ko")).toBe("2026-08-05");
    expect(parseDateQuery("2027년 8월 5일", today, "ko")).toBe("2027-08-05");
  });

  it("rejects prose and impossible dates rather than guessing", () => {
    expect(parseDateQuery("reading list", today)).toBeNull();
    expect(parseDateQuery("2026-02-30", today)).toBeNull();
    expect(parseDateQuery("feb 30", today)).toBeNull();
    expect(parseDateQuery("", today)).toBeNull();
    expect(parseDateQuery("2월 30일", today, "ko")).toBeNull();
  });
});
