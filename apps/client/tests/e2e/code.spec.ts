import { test, expect } from "../support/fixtures";

const FENCE = "```";

/** The block's canonical Markdown, read through its source view. */
async function sourceOf(app: import("../support/app").NeoseqApp, index: number) {
  await app.block(index).getByTestId("block-bullet").click({ button: "right" });
  await app.page.getByTestId("menu-code-source").click();
  const source = await app.editors.nth(index).inputValue();
  await app.block(index).getByTestId("block-bullet").click({ button: "right" });
  await app.page.getByTestId("menu-code-source").click();
  return source;
}

test("a code block is written as code and stored as a fence", async ({ app, page }) => {
  await app.createGraph("Code notes");
  await app.createPage("Snippets");
  await app.startBlock("");
  const code = app.editors.first();
  await code.pressSequentially("/code");
  await page.keyboard.press("Enter");
  // The language is asked for at once; typing finds it.
  await expect(page.getByRole("option", { name: "Plain text" })).toBeFocused();
  await page.keyboard.type("Rust");
  await expect(page.getByRole("option", { name: "Rust" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(code).toBeFocused();

  await app.saved(async () => {
    await page.keyboard.type("fn main() {");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type('println!("hi");');
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.type("}");
  });
  const block = page.locator(".outline-code .code-block");
  await expect(block.locator(".code-gutter > span")).toHaveText(["1", "2", "3"]);
  await expect(block.getByTestId("code-language")).toHaveText("Rust");

  // Shift+Enter leaves the code for a new line of writing.
  await app.saved(async () => {
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("After the code");
  });
  await app.expectOutline([
    `${FENCE}rust\nfn main() {\n  println!("hi");\n}\n${FENCE}`,
    "After the code",
  ]);

  await page.reload();
  await expect(block).toHaveAttribute("data-highlighted", "true");
  expect(await sourceOf(app, 0)).toBe(`${FENCE}rust\nfn main() {\n  println!("hi");\n}\n${FENCE}`);
});

test("the caret lands on the code it is placed on and never on a fence", async ({ app, page }) => {
  await app.createGraph("Code notes");
  await app.createPage("Snippets");
  await app.startBlock("Above");
  await app.appendBlock("");
  const code = app.editors.nth(1);
  await app.saved(async () => {
    await code.fill(`${FENCE}js\nconst answer = 42;\nconsole.log(answer);\n${FENCE}`);
    await code.blur();
  });
  for (const word of ["answer", "log"]) {
    // Press the third glyph of the word as the highlighted copy draws it.
    const point = await page.evaluate((target) => {
      const text = document.querySelector(".outline-code .code-text")!;
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(target);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at + 2);
        range.setEnd(node, at + 3);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      throw new Error(`${target} is not drawn`);
    }, word);
    await page.mouse.click(point.x, point.y);
    const value = await code.inputValue();
    const caret = await code.evaluate((textarea: HTMLTextAreaElement) => textarea.selectionStart);
    expect([value.indexOf(word) + 2, value.indexOf(word) + 3]).toContain(caret);
  }

  // The first line's edge steps out of the block, not onto the opening fence.
  const firstLine = (await page.locator(".outline-code .code-line").first().boundingBox())!;
  await page.mouse.click(firstLine.x + 2, firstLine.y + firstLine.height / 2);
  await page.keyboard.press("ArrowUp");
  await expect(app.editors.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(code).toBeFocused();
  expect(await code.evaluate((textarea: HTMLTextAreaElement) => textarea.selectionStart)).toBe(
    `${FENCE}js\n`.length,
  );
});

test("code keeps its fences when it contains one, and unwraps when emptied", async ({
  app,
  page,
}) => {
  await app.createGraph("Code notes");
  await app.createPage("Snippets");
  await app.startBlock("");
  const code = app.editors.first();
  await code.pressSequentially("/code");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: "Plain text" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(code).toBeFocused();
  await app.saved(async () => {
    await page.keyboard.type("A fence:");
    await page.keyboard.press("Enter");
    await page.keyboard.type(FENCE);
  });
  await expect(page.locator(".outline-code")).toHaveCount(1);
  expect(await code.inputValue()).toBe(`${"`".repeat(4)}\nA fence:\n${FENCE}\n${"`".repeat(4)}`);

  await app.saved(async () => {
    await code.press("ControlOrMeta+a");
    await code.press("Backspace");
    await code.press("Backspace");
  });
  await expect(page.locator(".outline-code")).toHaveCount(0);
  await expect(code).toHaveValue("");
});

test("a fence inside writing reads as highlighted code", async ({ app, page }) => {
  await app.createGraph("Code notes");
  await app.createPage("Snippets");
  await app.startBlock(`Run this:\n${FENCE}python\nprint("hi")\n${FENCE}`);
  await app.editors.first().blur();
  const block = page.getByTestId("block-markdown").locator(".code-block");
  await expect(block).toHaveAttribute("data-highlighted", "true");
  await expect(block.locator(".code-language")).toHaveText("Python");
  await expect(block.locator(".code-gutter > span")).toHaveText(["1"]);
});

test("the block menu reaches the language and the source", async ({ app, page }) => {
  await app.createGraph("Code notes");
  await app.createPage("Snippets");
  await app.startBlock("");
  await app.saved(async () => {
    await app.editors.first().fill(`${FENCE}\nSELECT 1;\n${FENCE}`);
    await app.editors.first().blur();
  });
  await app.block(0).getByTestId("block-bullet").click({ button: "right" });
  await page.getByTestId("menu-code-language").click();
  await expect(page.getByRole("option", { name: "Plain text" })).toBeFocused();
  await page.keyboard.type("SQL");
  await expect(page.getByRole("option", { name: "SQL" })).toBeFocused();
  await app.saved(() => page.keyboard.press("Enter"));
  await expect(page.getByTestId("code-language")).toHaveText("SQL");
  expect(await sourceOf(app, 0)).toBe(`${FENCE}sql\nSELECT 1;\n${FENCE}`);
});
