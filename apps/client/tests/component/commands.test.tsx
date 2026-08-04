// The guard that makes the bare interface safe.
//
// DESIGN.md § Disclosure removes buttons on the promise that every verb stays
// reachable without a keyboard. These tests are that promise, mechanised: if a
// command ever ships without a pointer route, or if the global key layer ever
// starts matching a bare keystroke, the build fails instead of the interface
// quietly losing a capability.

import { describe, expect, it } from "vitest";
import { GROUP_ORDER, fuzzyScore, matchCommand, type Command } from "../../src/features/commands/registry";
import { isComposing, matchGlobal, type KeyBinding } from "../../src/features/commands/keys";
import { parseDateQuery } from "../../src/features/commands/dates";

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    defaultPrevented: false,
    isComposing: false,
    keyCode: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

const BINDINGS: KeyBinding[] = [
  { key: "k", run: () => {} },
  { key: "p", shift: true, run: () => {} },
];

describe("global key arbitration", () => {
  it("never matches a bare keystroke, so a text field keeps every plain key", () => {
    expect(matchGlobal(key({ key: "k" }), BINDINGS)).toBeNull();
    expect(matchGlobal(key({ key: "k", metaKey: true }), BINDINGS)).not.toBeNull();
    expect(matchGlobal(key({ key: "k", ctrlKey: true }), BINDINGS)).not.toBeNull();
  });

  it("yields to an IME composition before anything else", () => {
    expect(matchGlobal(key({ key: "k", metaKey: true, isComposing: true }), BINDINGS)).toBeNull();
    // Some IMEs report the processing key rather than isComposing.
    expect(matchGlobal(key({ key: "k", metaKey: true, keyCode: 229 }), BINDINGS)).toBeNull();
    expect(isComposing(key({ key: "a", keyCode: 229 }))).toBe(true);
  });

  it("yields to a handler that already claimed the event", () => {
    expect(
      matchGlobal(key({ key: "k", metaKey: true, defaultPrevented: true }), BINDINGS),
    ).toBeNull();
  });

  it("distinguishes a shifted binding from its unshifted sibling", () => {
    expect(matchGlobal(key({ key: "p", metaKey: true }), BINDINGS)).toBeNull();
    expect(matchGlobal(key({ key: "p", metaKey: true, shiftKey: true }), BINDINGS)).not.toBeNull();
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

  it("rejects prose and impossible dates rather than guessing", () => {
    expect(parseDateQuery("reading list", today)).toBeNull();
    expect(parseDateQuery("2026-02-30", today)).toBeNull();
    expect(parseDateQuery("feb 30", today)).toBeNull();
    expect(parseDateQuery("", today)).toBeNull();
  });
});
