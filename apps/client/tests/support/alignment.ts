import type { Page } from "@playwright/test";

/**
 * Single-line rows whose text and marks do not share one vertical center, or
 * whose content sits off the row's own center. Text is measured by its glyph
 * box and marks by their box; wrapped rows and deliberate baseline rows that
 * are centered are exempt.
 */
export function misalignedRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tolerance = 1.01;
    const marks = [
      "svg",
      "img",
      ".kbd",
      ".tag-mark",
      ".save-dot",
      ".brand-symbol",
      ".earlier-bullet",
      ".moment-switch-track",
      ".outline-bullet",
      ".outline-toggle",
      ".outline-touch-handle > span",
    ].join(", ");
    const shown = (element: Element) =>
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const usable = (rect: DOMRect) =>
      rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.top < innerHeight;

    const measure = (row: Element) => {
      const atoms: { name: string; top: number; bottom: number }[] = [];
      let wrapped = false;
      for (const mark of row.querySelectorAll(marks)) {
        if (mark.parentElement?.closest("svg") || !shown(mark)) continue;
        const style = getComputedStyle(mark);
        if (style.clip !== "auto" || style.clipPath !== "none") continue;
        const rect = mark.getBoundingClientRect();
        if (usable(rect)) atoms.push({ name: mark.tagName.toLowerCase(), ...rect.toJSON() });
      }
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!node.textContent?.trim() || !parent || !shown(parent)) continue;
        if (parent.closest("svg, textarea, input") || !usable(parent.getBoundingClientRect()))
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(usable);
        if (new Set(rects.map((rect) => Math.round(rect.top))).size > 1) wrapped = true;
        if (rects[0])
          atoms.push({ name: `"${node.textContent.trim().slice(0, 24)}"`, ...rects[0].toJSON() });
      }
      return { atoms, wrapped };
    };

    const reports = new Set<string>();
    for (const row of document.querySelectorAll("body *")) {
      const style = getComputedStyle(row);
      if (!/flex|grid/.test(style.display) || style.flexDirection.startsWith("column")) continue;
      const box = row.getBoundingClientRect();
      if (!usable(box) || box.height > 64 || !shown(row)) continue;
      const { atoms, wrapped } = measure(row);
      if (atoms.length < 2) continue;
      if (!atoms.every((a) => atoms.every((b) => a.top < b.bottom && a.bottom > b.top))) continue;
      const centers = atoms.map((atom) => (atom.top + atom.bottom) / 2);
      const spread = Math.max(...centers) - Math.min(...centers);
      const content =
        (box.top +
          parseFloat(style.borderTopWidth) +
          parseFloat(style.paddingTop) +
          box.bottom -
          parseFloat(style.borderBottomWidth) -
          parseFloat(style.paddingBottom)) /
        2;
      const middle =
        (Math.max(...atoms.map((atom) => atom.bottom)) +
          Math.min(...atoms.map((atom) => atom.top))) /
        2;
      const offCenter = !wrapped && Math.abs(middle - content) > 1.51;
      const baseline = style.alignItems === "baseline";
      if ((spread <= tolerance || baseline) && !offCenter) continue;
      const name = row.getAttribute("data-testid") ?? (row.className.toString() || row.tagName);
      reports.add(
        `${name}: ` +
          atoms
            .map((atom, index) => `${atom.name}@${(centers[index] - box.top).toFixed(1)}`)
            .join(" "),
      );
    }
    return [...reports];
  });
}

/** The box of what a glyph or icon actually paints: text glyphs or SVG strokes. */
export function inkBox(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const shapes = element.querySelectorAll("path, line, polyline, polygon, circle, rect");
    let rects: DOMRect[];
    if (shapes.length > 0) {
      rects = [...shapes].map((shape) => shape.getBoundingClientRect());
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      rects = [range.getBoundingClientRect()];
    }
    const round = (value: number) => Math.round(value * 4) / 4;
    const left = round(Math.min(...rects.map((rect) => rect.left)));
    const right = round(Math.max(...rects.map((rect) => rect.right)));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, right, middle: round((top + bottom) / 2) };
  }, selector);
}
