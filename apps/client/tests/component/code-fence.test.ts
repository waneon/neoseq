import { describe, expect, it } from "vitest";
import { planAutoPair } from "../../src/features/blocks/editor/auto-pair";
import {
  closeLine,
  indent,
  indentUnit,
  newline,
  outdentBackspace,
} from "../../src/features/code/editing";
import { codeFence, fencedSource, lengthenFence, withInfo } from "../../src/features/code/fence";
import { codeLanguage } from "../../src/features/code/languages";

describe("code block shape", () => {
  it("is a block whose whole source is one fence", () => {
    const source = "```rust\nfn main() {}\n```";
    expect(codeFence(source)).toEqual({
      marker: "```",
      info: "rust",
      body: "fn main() {}",
      bodyStart: 8,
      bodyEnd: 20,
    });
    expect(codeFence("```\n\n```")).toMatchObject({ body: "", bodyStart: 4, bodyEnd: 4 });
    expect(codeFence("~~~~ py\na\n~~~~")).toMatchObject({ marker: "~~~~", info: "py", body: "a" });
  });

  it("rejects prose around the fence, a broken fence, and an inner closing line", () => {
    expect(codeFence("Run this:\n```\nls\n```")).toBeNull();
    expect(codeFence("```\nls\n```\nafter")).toBeNull();
    expect(codeFence("```\nls")).toBeNull();
    expect(codeFence("```\n```")).toBeNull();
    expect(codeFence("````\nls\n```")).toBeNull();
    expect(codeFence("```\na\n```\nb\n```")).toBeNull();
    expect(codeFence("```a`b\nx\n```")).toBeNull();
  });

  it("lengthens both fences when the body gains a closing line", () => {
    const grown = lengthenFence("```js\na\n```\nb\n```");
    expect(grown).toEqual({ source: "````js\na\n```\nb\n````", added: 1 });
    expect(codeFence(grown!.source)).toMatchObject({ info: "js", body: "a\n```\nb" });
    expect(lengthenFence("```\na\n```")).toBeNull();
  });

  it("writes a fence longer than any closing line in the body", () => {
    expect(fencedSource("")).toBe("```\n\n```");
    expect(fencedSource("x", "go")).toBe("```go\nx\n```");
    expect(fencedSource("```\nx\n````")).toBe("`````\n```\nx\n````\n`````");
    const source = "```js\na\n```";
    expect(withInfo(source, codeFence(source)!, "ts")).toBe("```ts\na\n```");
  });
});

describe("code languages", () => {
  it("resolve by name or alias from the first word of the info string", () => {
    expect(codeLanguage("Rust")?.label).toBe("Rust");
    expect(codeLanguage("c++ {.numberLines}")?.id).toBe("cpp");
    expect(codeLanguage(" sh ")?.id).toBe("bash");
    expect(codeLanguage("")).toBeUndefined();
    expect(codeLanguage("brainfuck")).toBeUndefined();
  });
});

describe("code editing", () => {
  it("keeps indentation on a new line and deepens it after an opener", () => {
    expect(newline("  x = 1", 7, 7, "  ")).toMatchObject({ insert: "\n  ", selectionStart: 10 });
    expect(newline("  if x:", 7, 7, "  ")).toMatchObject({ insert: "\n    ", selectionStart: 12 });
    expect(newline("f(", 2, 2, "    ")).toMatchObject({ insert: "\n    ", selectionStart: 7 });
    // Between a pair the closer takes its own line at the outer indentation.
    expect(newline("  {}", 3, 3, "  ")).toEqual({
      from: 3,
      to: 3,
      insert: "\n    \n  ",
      selectionStart: 8,
      selectionEnd: 8,
    });
  });

  it("returns a closer to its opener's indentation and backspaces by indent stops", () => {
    expect(closeLine("{\n    ", 6, "}", "  ")).toMatchObject({ insert: "  }", selectionStart: 5 });
    expect(closeLine("{\n  x", 5, "}", "  ")).toBeNull();
    expect(closeLine("{\n  }", 4, "}", "  ")).toBeNull();
    expect(outdentBackspace("      x", 6, "    ")).toMatchObject({ from: 4, to: 6 });
    expect(outdentBackspace("    x", 4, "    ")).toMatchObject({ from: 0, to: 4 });
    expect(outdentBackspace("  a ", 4, "  ")).toBeNull();
  });

  it("pairs in code but types a run of quotes whole", () => {
    const type = (value: string, data: string, code: boolean) =>
      planAutoPair({
        value,
        start: value.length,
        end: value.length,
        direction: "none",
        inputType: "insertText",
        data,
        isComposing: false,
        code,
      });
    expect(type("x = ", "(", true)).toMatchObject({ insert: "()" });
    expect(type("``", "`", true)).toBeNull();
    expect(type("``", "`", false)).toMatchObject({ insert: "``" });
  });

  it("uses the body's own indent unit", () => {
    expect(indentUnit("a\n    b\n        c")).toBe("    ");
    expect(indentUnit("a\n\tb")).toBe("\t");
    expect(indentUnit("a")).toBe("  ");
  });

  it("inserts a unit at a caret and shifts every selected line", () => {
    expect(indent("ab", 1, 1, "  ", false)).toMatchObject({ insert: "  ", selectionStart: 3 });
    const value = "a\nb\nc";
    const shifted = indent(value, 0, 3, "  ", false);
    expect(shifted).toEqual({
      from: 0,
      to: 3,
      insert: "  a\n  b",
      selectionStart: 2,
      selectionEnd: 7,
    });
    const back = indent("  a\n  b", 2, 7, "  ", true);
    expect(back).toMatchObject({ insert: "a\nb", selectionStart: 0, selectionEnd: 3 });
  });
});
