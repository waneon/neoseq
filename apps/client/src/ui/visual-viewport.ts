/** How long the page keeps moving after the visible viewport resizes. */
const SETTLE_MS = 500;
let resizedAt = -Infinity;

/**
 * Whether the visible viewport resized just now. The keyboard opening or
 * closing scrolls the page on its own, and a surface that closes on scroll must
 * not read that as the reader moving on.
 */
export function viewportSettling(): boolean {
  return performance.now() - resizedAt < SETTLE_MS;
}

/** Shared viewport geometry for the shell and portalled touch surfaces. */
export function trackVisualViewport(window: Window): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const style = window.document.documentElement.style;
  const resized = () => {
    resizedAt = performance.now();
    update();
  };
  const update = () => {
    // Pinch zoom belongs to the reader; it must not reflow the application.
    if (viewport.scale !== 1) return;
    // Only a viewport the keyboard shrinks needs a height of its own; otherwise
    // `100dvh` follows a resize without waiting for this handler.
    if (viewport.height === window.innerHeight) style.removeProperty("--visual-viewport-height");
    else style.setProperty("--visual-viewport-height", `${viewport.height}px`);
    style.setProperty("--visual-viewport-top", `${viewport.offsetTop}px`);
    style.setProperty(
      "--visual-viewport-bottom",
      `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
    );
  };
  update();
  viewport.addEventListener("resize", resized);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", resized);
  return () => {
    viewport.removeEventListener("resize", resized);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", resized);
    for (const name of ["height", "top", "bottom"]) {
      style.removeProperty(`--visual-viewport-${name}`);
    }
  };
}
