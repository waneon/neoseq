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

/**
 * The box of every visible, on-screen element under `root`, keyed by its place
 * in the tree, so two pages showing the same content can be compared element by
 * element.
 */
export function layoutOf(page: Page, root: string, ignore: string): Promise<Boxes> {
  return page.evaluate(
    async ({ root, ignore }) => {
      // Boxes at rest, not partway through a transition.
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
      const result: Record<string, number[]> = {};
      const visit = (element: Element, path: string) => {
        const seen = new Map<string, number>();
        for (const child of element.children) {
          if (child.matches(ignore)) continue;
          const label = `${child.tagName.toLowerCase()}.${
            child.getAttribute("data-testid") ?? child.classList[0] ?? ""
          }`;
          const index = seen.get(label) ?? 0;
          seen.set(label, index + 1);
          const key = `${path}/${label}[${index}]`;
          if (!child.checkVisibility({ visibilityProperty: true })) continue;
          const rect = child.getBoundingClientRect();
          // Off-screen, as a closed drawer is, nothing is laid out for the reader.
          if (rect.right <= 0 || rect.left >= innerWidth) continue;
          if (rect.width > 0 || rect.height > 0) {
            result[key] = [rect.left, rect.top, rect.width, rect.height].map(
              (value) => Math.round(value * 2) / 2,
            );
          }
          visit(child, key);
        }
      };
      for (const element of document.querySelectorAll(root)) visit(element, root);
      return result;
    },
    { root, ignore },
  );
}

/** Elements one layout has that the other lacks, or places differently. */
export function layoutDifferences(expected: Boxes, actual: Boxes): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys]
    .filter((key) => expected[key]?.join() !== actual[key]?.join())
    .map(
      (key) =>
        `${key}: ${expected[key]?.join(",") ?? "absent"} -> ${actual[key]?.join(",") ?? "absent"}`,
    );
}
