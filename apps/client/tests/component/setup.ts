import "@testing-library/jest-dom/vitest";

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
