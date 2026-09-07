import { test, expect } from "../support/fixtures";

for (const keymap of ["standard", "vim"]) {
  test(`${keymap} undo leaves an already visible editor at its reading position`, async ({
    app,
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await app.createGraph("History position");
    await app.startBlock("");
    await page.evaluate(() =>
      navigator.clipboard.writeText(
        Array.from({ length: 40 }, (_, index) => `- Note ${index}`).join("\n"),
      ),
    );
    await app.saved(() => app.editors.first().press("ControlOrMeta+v"));
    const editor = page.locator("textarea.outline-input:focus");
    await expect(editor).toHaveValue("Note 39");
    await expect(editor).toBeInViewport();
    await app.saved(async () => {
      await editor.fill("Last note changed");
      await editor.press("Tab");
    });
    // Undo the last structural action while its target is already visible.
    const scroller = page.locator(".page-scroll");
    if (keymap === "vim") {
      await app.settings("keyboard");
      await page
        .getByTestId("settings-editor-keymap")
        .getByRole("button", { name: "Vim", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await app.editors.last().click();
      await page.keyboard.press("Escape");
    }
    const before = await scroller.evaluate((node) => node.scrollTop);
    await app.saved(() => editor.press(keymap === "vim" ? "u" : "ControlOrMeta+z"));
    await expect(editor).toHaveValue("Last note changed");
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeCloseTo(before, 0);
    await expect(editor).toBeFocused();
  });
}

test("keyboard structure, subtree movement, collapse and history survive reload", async ({
  app,
  page,
}) => {
  await app.createGraph("Outline");
  await app.startBlock("Parent");
  await app.appendBlock("Child");
  await app.editors.nth(1).click();
  await app.saved(() => page.keyboard.press("Tab"));
  await expect(app.block(1)).toHaveAttribute("aria-level", "2");
  await app.appendBlock("Grandchild");
  await app.editors.nth(2).click();
  await app.saved(() => page.keyboard.press("Tab"));
  await app.appendBlock("Other root");
  await app.editors.nth(3).click();
  await app.saved(() => page.keyboard.press("Shift+Tab"));
  await app.saved(() => page.keyboard.press("Shift+Tab"));
  await app.saved(() => page.keyboard.press("Alt+ArrowUp"));
  await app.expectOutline(["Other root", "Parent", "Child", "Grandchild"]);
  for (const [index, level] of ["1", "1", "2", "3"].entries()) {
    await expect(app.block(index)).toHaveAttribute("aria-level", level);
  }
  await app.block(1).getByRole("button", { name: "Collapse", exact: true }).click();
  await app.expectOutline(["Other root", "Parent"]);
  await app.block(1).getByRole("button", { name: "Expand", exact: true }).click();
  await app.expectOutline(["Other root", "Parent", "Child", "Grandchild"]);
  await app.editors.first().click();
  await app.saved(() => page.keyboard.press("ControlOrMeta+z"));
  await app.expectOutline(["Parent", "Child", "Grandchild", "Other root"]);
  await app.saved(() => page.keyboard.press("ControlOrMeta+Shift+z"));
  await page.reload();
  await app.expectOutline(["Other root", "Parent", "Child", "Grandchild"]);
  await expect(app.block(3)).toHaveAttribute("aria-level", "3");
});

test("native clipboard paste is one history step and a split merges without losing text", async ({
  app,
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.createGraph("Clipboard");
  await app.startBlock("");
  await page.evaluate(() => navigator.clipboard.writeText("- One\n  - Nested\n- Three"));
  await app.editors.first().click();
  await app.saved(() => page.keyboard.press("ControlOrMeta+v"));
  await app.expectOutline(["One", "Nested", "Three"]);
  await expect(app.block(1)).toHaveAttribute("aria-level", "2");
  await app.saved(() => page.keyboard.press("ControlOrMeta+z"));
  await app.expectOutline([""]);
  await app.saved(() => page.keyboard.press("ControlOrMeta+Shift+z"));
  await app.expectOutline(["One", "Nested", "Three"]);
  const last = app.editors.last();
  await last.click();
  await last.press("ControlOrMeta+a");
  await last.press("ArrowRight");
  await last.press("ArrowLeft");
  await last.press("ArrowLeft");
  await last.press("ArrowLeft");
  await expect
    .poll(() => last.evaluate((node: HTMLTextAreaElement) => node.selectionStart))
    .toBe(2);
  await app.saved(() => last.press("Enter"));
  await app.expectOutline(["One", "Nested", "Th", "ree"]);
  await app.saved(() => page.keyboard.press("Backspace"));
  await app.expectOutline(["One", "Nested", "Three"]);
  await page.reload();
  await app.expectOutline(["One", "Nested", "Three"]);
});

test("a long pasted outline exposes editable rows beyond the initial viewport", async ({
  app,
  page,
  context,
}) => {
  const scrollTo = async (text: string, direction: -1 | 1) => {
    const scroller = page.locator(".page-scroll");
    const edge = direction === -1 ? app.editors.first() : app.editors.last();
    await expect(scroller).toBeVisible();
    await expect
      .poll(() => scroller.evaluate((node) => node.scrollHeight > node.clientHeight))
      .toBe(true);
    // Each wheel gesture advances an observed virtual window. A large one-shot
    // delta can be clamped before the reloaded outline finishes its layout.
    for (let step = 0; step < 12; step += 1) {
      const before = await edge.inputValue();
      if (before === text) {
        await edge.scrollIntoViewIfNeeded();
        await expect(edge).toBeInViewport();
        return;
      }
      await scroller.hover({ position: { x: 20, y: 160 } });
      await page.mouse.wheel(0, direction * 600);
      await expect(edge).not.toHaveValue(before);
    }
    await expect(edge).toHaveValue(text);
  };

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.createGraph("Long outline");
  await app.startBlock("");
  await page.evaluate(() =>
    navigator.clipboard.writeText(
      Array.from({ length: 120 }, (_, i) => `- Note ${String(i).padStart(3, "0")}`).join("\n"),
    ),
  );
  await app.saved(() => app.editors.first().press("ControlOrMeta+v"));
  await expect(app.editors.last()).toHaveValue("Note 119");
  await scrollTo("Note 000", -1);
  await scrollTo("Note 119", 1);
  const end = app.editors.last();
  await app.saved(async () => {
    await end.fill("Last note revised");
    await end.blur();
  });
  await page.reload();
  await scrollTo("Note 000", -1);
  await scrollTo("Last note revised", 1);
});
