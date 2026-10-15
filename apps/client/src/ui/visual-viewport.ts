/** Shared viewport geometry for the shell and portalled touch surfaces. */
export function trackVisualViewport(window: Window): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const style = window.document.documentElement.style;
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
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("resize", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("resize", update);
    for (const name of ["height", "top", "bottom"]) {
      style.removeProperty(`--visual-viewport-${name}`);
    }
  };
}
