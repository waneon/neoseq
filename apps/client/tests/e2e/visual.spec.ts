import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";

type Pixel = readonly [number, number, number, number];

const distance = (left: Pixel, right: Pixel): number => Math.hypot(
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
  left[3] - right[3],
);

async function renderedInsetEdges(
  page: Page,
  field: Locator,
  testInfo: TestInfo,
): Promise<{ expected: Pixel; edges: Pixel[] }> {
  const box = await field.boundingBox();
  if (!box) throw new Error("focused field has no rendered box");
  const png = await field.screenshot({ animations: "disabled" });
  await testInfo.attach("focused-field", { body: png, contentType: "image/png" });

  return page.evaluate(async ({ source, cssWidth, cssHeight }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas context unavailable");
    context.drawImage(image, 0, 0);

    const scaleX = image.width / cssWidth;
    const scaleY = image.height / cssHeight;
    const pixel = (x: number, y: number): Pixel => {
      const data = context.getImageData(
        Math.max(0, Math.min(image.width - 1, Math.round(x * scaleX))),
        Math.max(0, Math.min(image.height - 1, Math.round(y * scaleY))),
        1,
        1,
      ).data;
      return [data[0]!, data[1]!, data[2]!, data[3]!];
    };

    const probe = document.createElement("span");
    probe.style.color = "var(--focus-tone)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();

    const swatch = document.createElement("canvas");
    swatch.width = 1;
    swatch.height = 1;
    const swatchContext = swatch.getContext("2d", { willReadFrequently: true });
    if (!swatchContext) throw new Error("swatch context unavailable");
    swatchContext.fillStyle = accent;
    swatchContext.fillRect(0, 0, 1, 1);
    const expectedData = swatchContext.getImageData(0, 0, 1, 1).data;
    const expected: Pixel = [
      expectedData[0]!,
      expectedData[1]!,
      expectedData[2]!,
      expectedData[3]!,
    ];

    const inset = 1;
    return {
      expected,
      edges: [
        pixel(cssWidth / 2, inset),
        pixel(cssWidth - 1 - inset, cssHeight / 2),
        pixel(cssWidth / 2, cssHeight - 1 - inset),
        pixel(inset, cssHeight / 2),
      ],
    };
  }, {
    source: png.toString("base64"),
    cssWidth: box.width,
    cssHeight: box.height,
  });
}

test("focus edges survive clipping in every visual project", async ({ page }, testInfo) => {
  await page.goto("/#/verify/visual");
  await page.locator("html").evaluate((root) => root.style.setProperty("--accent-h", "18"));

  const picker = page.getByTestId("visual-focus-picker");
  const field = picker.getByLabel("Date, time, or repeat");
  await expect(field).toBeFocused();

  const tokens = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    const ringSize = style.getPropertyValue("--focus-ring-size").trim();
    const collapsedHalo = style.getPropertyValue("--collapsed-halo").trim();
    return {
      ringSize,
      collapsedHalo,
      ringSizeIsLength: CSS.supports("width", ringSize),
      collapsedHaloIsColor: CSS.supports("color", collapsedHalo),
    };
  });
  expect(tokens.ringSizeIsLength, tokens.ringSize).toBe(true);
  expect(tokens.collapsedHaloIsColor, tokens.collapsedHalo).toBe(true);

  const scrollOwners = await picker
    .locator(".property-picker-value, .moment-picker-body")
    .evaluateAll((elements) => elements
      .filter((element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY))
      .map((element) => element.className));
  expect(scrollOwners).toEqual(["moment-picker-body"]);

  const shadow = await field.evaluate((element) => getComputedStyle(element).boxShadow);
  expect(shadow).toContain("inset");

  const rendered = await renderedInsetEdges(page, field, testInfo);
  for (const edge of rendered.edges) {
    expect(distance(edge, rendered.expected), `${edge} differs from ${rendered.expected}`)
      .toBeLessThan(42);
  }

  const fallback = page.getByTestId("visual-focus-fallback");
  await fallback.focus();
  const fallbackOutline = await fallback.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  });
  expect(fallbackOutline).toEqual({ style: "solid", width: "2px", offset: "-2px" });
});

test("a bare Option key does not turn pointer focus into a keyboard ring", async (
  { page, isMobile },
) => {
  test.skip(
    Boolean(isMobile),
    "Option focus modality is a macOS desktop interaction",
  );
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgentData", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  });
  await page.goto("/#/verify/visual");
  const platform = await page.evaluate(() => {
    const current = navigator as Navigator & { userAgentData?: { platform?: string } };
    return current.userAgentData?.platform || current.platform;
  });
  expect(platform).toBe("MacIntel");

  const timeToggle = page.getByTestId("moment-time-toggle");
  const track = timeToggle.locator(".moment-switch-track");
  await timeToggle.click();
  const restingTrackShadow = await track.evaluate((node) => getComputedStyle(node).boxShadow);
  await expect(timeToggle).not.toHaveAttribute("data-focus-visible", "true");

  await page.keyboard.press("Alt");
  await expect(timeToggle).not.toHaveAttribute("data-focus-visible", "true");
  await expect.poll(() => timeToggle.evaluate((node) => getComputedStyle(node).boxShadow))
    .toBe("none");

  // The modifier may still accompany a meaningful key. Filtering the Alt flag
  // wholesale would break macOS Option+Arrow navigation throughout the app.
  await page.keyboard.press("Alt+ArrowDown");
  await expect(timeToggle).toHaveAttribute("data-focus-visible", "true");
  await expect.poll(() => track.evaluate((node) => getComputedStyle(node).boxShadow))
    .not.toBe(restingTrackShadow);
  await expect.poll(() => timeToggle.evaluate((node) => getComputedStyle(node).boxShadow))
    .toBe("none");
});

test("query table values share one row, type and content axis", async ({ page }) => {
  await page.goto("/#/verify/visual");
  const table = page.getByTestId("visual-query-table");
  await expect(table).toBeVisible();

  const measure = () => table.evaluate((node) => {
    const rows = [...node.querySelectorAll<HTMLElement>("tbody tr")];
    const controls = [...node.querySelectorAll<HTMLElement>(".query-cell-control")];
    const textLeft = (element: Element): number => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && !text.textContent?.trim()) text = walker.nextNode();
      if (!text) throw new Error("cell value has no text");
      const start = text.textContent!.search(/\S/);
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 1);
      return range.getBoundingClientRect().left;
    };
    const first = rows[0]!;
    const status = first.querySelector<HTMLElement>(".query-status")!;
    const due = first.querySelector<HTMLElement>(".query-due")!;
    const plain = first.querySelector<HTMLElement>(".query-contract-plain")!;
    const markdown = first.querySelector<HTMLElement>(".query-markdown-preview")!;
    const inset = (element: Element, left: number): number =>
      left - element.closest("td")!.getBoundingClientRect().left;
    return {
      rowHeights: rows.map((row) => row.getBoundingClientRect().height),
      frames: node.querySelectorAll("tbody td > .query-cell-frame").length,
      cells: node.querySelectorAll("tbody td").length,
      fonts: controls.map((control) => {
        const style = getComputedStyle(control);
        return [style.fontSize, style.lineHeight];
      }),
      axes: {
        status: inset(status, status.getBoundingClientRect().left),
        due: inset(due, textLeft(due)),
        plain: inset(plain, textLeft(plain)),
        markdown: inset(markdown, textLeft(markdown)),
      },
    };
  });

  const roomy = await measure();
  expect(roomy.frames).toBe(roomy.cells);
  expect(roomy.rowHeights).toEqual([32, 32]);
  expect(new Set(roomy.fonts.map(String))).toEqual(new Set(["14px,20px"]));
  expect(roomy.axes.status).toBeCloseTo(roomy.axes.plain, 5);
  expect(roomy.axes.due).toBeCloseTo(roomy.axes.plain, 5);
  expect(roomy.axes.markdown).toBeCloseTo(roomy.axes.plain, 5);

  await table.evaluate((node) => node.setAttribute("data-compact", "true"));
  const compact = await measure();
  expect(compact.rowHeights).toEqual([24, 24]);
  expect(compact.axes).toEqual(roomy.axes);

  const cells = table.locator("tbody tr").first().locator("td");
  const fills: string[] = [];
  for (const cell of await cells.all()) {
    await cell.hover();
    fills.push(await cell.evaluate((node) => getComputedStyle(node).backgroundColor));
  }
  expect(new Set(fills).size).toBe(1);
  expect(fills[0]).not.toBe("rgba(0, 0, 0, 0)");
});
