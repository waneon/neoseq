import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

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
