import type { Locator, Page } from "@playwright/test";

type Boxes = Record<string, number[]>;

/**
 * The box of every visible element, keyed by node identity, so an element
 * keeps its key when siblings come and go. Descendants of `changing` are the
 * content an action may replace; the region itself keeps only its block start,
 * since its size follows that content, and its ancestors may change height.
 */
function boxes(page: Page, changing: string): Promise<Boxes> {
  return page.evaluate((changing) => {
    const registry = window as unknown as { __stableIds?: WeakMap<Element, string> };
    const ids = (registry.__stableIds ??= new WeakMap());
    const result: Record<string, number[]> = {};
    for (const element of document.body.querySelectorAll("*")) {
      if (element.parentElement?.closest(changing)) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      let id = ids.get(element);
      if (!id) {
        const label = element.getAttribute("data-testid") ?? element.className.toString();
        id = `${element.tagName.toLowerCase()}.${label.split(" ")[0]}#${Math.random().toString(36).slice(2, 8)}`;
        ids.set(element, id);
      }
      const box = element.matches(changing)
        ? [rect.top]
        : element.querySelector(changing)
          ? [rect.left, rect.top, rect.width]
          : [rect.left, rect.top, rect.width, rect.height];
      result[id] = box.map((value) => Math.round(value * 100) / 100);
    }
    return result;
  }, changing);
}

/**
 * Elements that moved or resized while `act` ran, outside the `changing`
 * region. Elements that appeared or disappeared are the action's own result.
 */
export async function shiftedBy(
  page: Page,
  changing: string,
  act: () => Promise<void>,
): Promise<string[]> {
  const before = await boxes(page, changing);
  await act();
  const after = await boxes(page, changing);
  return Object.entries(before)
    .filter(([key, box]) => after[key] && after[key].some((value, i) => value !== box[i]))
    .map(([key, box]) => `${key}: ${box.join(",")} -> ${after[key].join(",")}`);
}

/** Boxes of `targets` before and after `act`, for asserting they are equal. */
export async function boxesAround(
  targets: Locator[],
  act: () => Promise<void>,
): Promise<{ before: unknown[]; after: unknown[] }> {
  const measure = () => Promise.all(targets.map((target) => target.boundingBox()));
  const before = await measure();
  await act();
  return { before, after: await measure() };
}
