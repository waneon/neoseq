/** Shared viewport geometry for the shell and portalled touch surfaces. */
export function trackVisualViewport(window: Window): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const style = window.document.documentElement.style;
  const update = () => {
    // Pinch zoom belongs to the reader; it must not reflow the application.
    if (viewport.scale !== 1) return;
    style.setProperty("--visual-viewport-height", `${viewport.height}px`);
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
