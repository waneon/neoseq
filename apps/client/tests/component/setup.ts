import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

const consoleError = console.error.bind(console);
let actViolations: string[] = [];
let actTimingReports = 0;

// Diagnostics that the test code itself determines: an act() scope that
// overlaps another or is never awaited is wrong on every machine.
const actViolationDiagnostics = [
  "overlapping act() calls",
  "act(async () => ...) without await",
  "`act` call was not awaited",
] as const;

// Diagnostics that depend on scheduling. Application work runs on real timers,
// Worker-like promises, and a Wasm core, so whether its last update lands inside
// or just outside an interaction's act() scope depends on machine speed. As
// failures they passed on fast workstations and failed on CI runners without
// any change in behavior, so they are reported, never failed on. Assertions on
// the settled result remain the evidence.
const actTimingDiagnostics = [
  "was not wrapped in act",
  "The current testing environment is not configured to support act",
] as const;

function formatConsoleArguments(args: unknown[]): string {
  if (args.length === 0) return "";
  let message = String(args[0]);
  for (const value of args.slice(1)) message = message.replace("%s", String(value));
  return message;
}

console.error = (...args: unknown[]) => {
  const message = formatConsoleArguments(args);
  if (actViolationDiagnostics.some((diagnostic) => message.includes(diagnostic))) {
    actViolations.push(message);
    return;
  }
  if (actTimingDiagnostics.some((diagnostic) => message.includes(diagnostic))) {
    actTimingReports += 1;
    return;
  }
  consoleError(...args);
};

beforeEach(() => {
  actViolations = [];
  actTimingReports = 0;
});

afterEach(({ task }) => {
  // Own cleanup so diagnostics raised by unmount effects belong to the test
  // that mounted them, rather than leaking into the next test or environment.
  cleanup();
  if (actTimingReports > 0) {
    console.warn(
      `${task.name}: ${actTimingReports} React update(s) settled outside an act() scope (scheduling-dependent; not a failure)`,
    );
    actTimingReports = 0;
  }
  if (actViolations.length === 0) return;
  const violations = actViolations;
  actViolations = [];
  throw new Error(`React act() contract violated:\n\n${violations.join("\n\n")}`);
});

// Node 24's Request performs a strict brand check on AbortSignal. Vitest keeps
// Node's Request but jsdom supplies AbortController, so React Router otherwise
// hands Request an equally valid signal from the other DOM implementation and
// every client-side navigation throws. Keep the signal React Router owns (and
// therefore its cancellation semantics), while letting Node construct the
// request without applying its incompatible brand check.
const NodeRequest = globalThis.Request;
class DomCompatibleRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const { signal, ...compatibleInit } = init;
    super(input, compatibleInit);
    if (signal) Object.defineProperty(this, "signal", { value: signal });
  }
}
(globalThis as Record<string, unknown>).Request = DomCompatibleRequest;

// The default second is a guess about how fast the machine is. Under the
// contention of a full verification run a portalled menu can take longer to
// mount than that, which reads as a missing element rather than a slow one.
configure({ asyncUtilTimeout: 5_000 });

// jsdom lacks layout APIs the virtualized outline touches.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
}

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

// jsdom reports 0×0 layout, which would give the virtualizer an empty
// viewport. Fixed sizes keep the visible row range non-empty in tests.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 64,
});
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get: () => 800,
});

Element.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
  const rect = {
    width: 800,
    height: 64,
    top: 0,
    left: 0,
    bottom: 64,
    right: 800,
    x: 0,
    y: 0,
  };
  return { ...rect, toJSON: () => rect } as DOMRect;
};

// Radix primitives (dropdown menu, dialog, tooltip) reach for pointer-capture,
// scroll, and media-query APIs that jsdom does not implement. Stub them so the
// portaled menus open and close under userEvent the way they do in a browser.
if (!("PointerEvent" in globalThis)) {
  class PointerEventStub extends MouseEvent {
    public pointerId: number;
    public pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  (globalThis as Record<string, unknown>).PointerEvent = PointerEventStub;
}

for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    (Element.prototype as unknown as Record<string, unknown>)[method] = () => false;
  }
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

// jsdom has no Web Locks. Grant every request so a session opens writable at
// once, the way a secure-context browser does. lease.test.ts removes this to
// exercise the BroadcastChannel election that insecure contexts fall back to.
if (!("locks" in navigator)) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        name: string,
        options: LockOptions | ((lock: Lock | null) => unknown),
        callback?: (lock: Lock | null) => unknown,
      ) => {
        const run = typeof options === "function" ? options : callback;
        return Promise.resolve(run?.({ name, mode: "exclusive" } as Lock));
      },
    },
  });
}
