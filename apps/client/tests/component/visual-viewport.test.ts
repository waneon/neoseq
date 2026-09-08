import { afterEach, describe, expect, it } from "vitest";
import { trackVisualViewport } from "../../src/ui/visual-viewport";

const style = document.documentElement.style;
let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  stop = undefined;
});

function viewportWindow() {
  const viewport = Object.assign(new EventTarget(), { height: 900, offsetTop: 0, scale: 1 });
  const host = Object.assign(new EventTarget(), {
    document,
    innerHeight: 900,
    visualViewport: viewport,
  });
  stop = trackVisualViewport(host as unknown as Window);
  return { host, viewport };
}

function geometry() {
  return ["height", "top", "bottom"].map((name) =>
    style.getPropertyValue(`--visual-viewport-${name}`),
  );
}

describe("visual viewport", () => {
  it("keeps touch surfaces above a keyboard as the visible viewport resizes and pans", () => {
    const { host, viewport } = viewportWindow();
    expect(geometry()).toEqual(["900px", "0px", "0px"]);

    viewport.height = 560;
    viewport.dispatchEvent(new Event("resize"));
    expect(geometry()).toEqual(["560px", "0px", "340px"]);

    viewport.offsetTop = 80;
    viewport.dispatchEvent(new Event("scroll"));
    expect(geometry()).toEqual(["560px", "80px", "260px"]);

    host.innerHeight = 600;
    host.dispatchEvent(new Event("resize"));
    expect(geometry()).toEqual(["560px", "80px", "0px"]);
  });

  it("lets pinch zoom change the reader's view without reflowing the application", () => {
    const { viewport } = viewportWindow();
    viewport.scale = 2;
    viewport.height = 450;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(geometry()).toEqual(["900px", "0px", "0px"]);

    viewport.scale = 1;
    viewport.height = 900;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(geometry()).toEqual(["900px", "0px", "0px"]);
  });

  it("releases geometry and stops updating it when tracking ends", () => {
    const { host, viewport } = viewportWindow();
    stop!();
    stop = undefined;
    expect(geometry()).toEqual(["", "", ""]);
    viewport.height = 500;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    host.dispatchEvent(new Event("resize"));
    expect(geometry()).toEqual(["", "", ""]);
  });
});
