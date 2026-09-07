import { test, expect } from "../support/fixtures";

test("wrapped Markdown source keeps the next row under a completed click", async ({
  app,
  page,
}) => {
  await app.createGraph("Wrapped source");
  const source = `[foo](${"long".repeat(160)})`;
  await app.startBlock(source);
  await app.appendBlock("**next block**");
  await app.appendBlock("last block");

  for (const destination of [1, 2]) {
    await app.block(0).getByTestId("block-markdown").click();
    await expect(app.editors.first()).toBeFocused();
    const target =
      destination === 1 ? app.block(1).getByTestId("block-markdown") : app.editors.nth(2);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + 30;
    const y = box!.y + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Permit blur reconciliation and virtual measurements while the press is
    // still held; both must preserve the geometry used to resolve its click.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const pressedBox = await target.boundingBox();
    expect(pressedBox!.y).toBeCloseTo(box!.y, 0);
    await page.mouse.up();
    await expect(app.editors.nth(destination)).toBeFocused();
    await expect(app.editors.first()).toBeHidden();
  }
});

test("Markdown preserves source while unsafe links and remote images stay inert", async ({
  app,
  page,
}) => {
  await app.createGraph("Markdown");
  const source =
    "Read **bold text** and [docs](https://example.com).\n[unsafe](javascript:alert(1)) ![tracking image](https://example.com/pixel.png)";
  await app.startBlock(source);
  const preview = app.block(0).getByTestId("block-markdown");
  await expect(preview.locator("strong")).toHaveText("bold text");
  await expect(preview.getByRole("link", { name: "docs" })).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(preview.getByRole("link", { name: "docs" })).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await expect(preview.getByRole("link", { name: "unsafe" })).toHaveCount(0);
  await expect(preview.getByRole("img")).toHaveCount(0);
  await expect(preview).toContainText("tracking image");
  await preview.locator("strong").click();
  await expect(app.editors.first()).toBeFocused();
  await expect(app.editors.first()).toHaveValue(source);
  await app.editBlock(0, source + "\n한글도 보존됩니다.");
  await page.reload();
  await app.expectOutline([source + "\n한글도 보존됩니다."]);
});

test("native browser composition preserves Hangul and postpones structural Enter", async ({
  app,
  page,
  context,
}) => {
  await app.createGraph("Composition");
  await app.startBlock("");
  const input = app.editors.first();
  const ime = await context.newCDPSession(page);
  // Chromium's IME boundary generates real composition/input events. This is
  // browser integration coverage; it does not emulate a particular OS keyboard.
  for (const text of ["ㅎ", "한", "한글"]) {
    await ime.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
    await expect(input).toHaveValue(text);
  }
  // The IME consumes the character-producing key; the page receives the
  // composing keycode (229), not a second literal newline from a keyboard.
  await ime.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
  });
  await ime.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 229,
  });
  await expect(app.rows).toHaveCount(1);
  await app.saved(async () => {
    await ime.send("Input.insertText", { text: "한글" });
    await input.blur();
  });
  await app.expectOutline(["한글"]);
  await input.click();
  await input.press("ControlOrMeta+a");
  await input.press("ArrowRight");
  await app.saved(() => input.press("Enter"));
  await app.expectOutline(["한글", ""]);
  await page.reload();
  await app.expectOutline(["한글", ""]);
});
