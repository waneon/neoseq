// The languages a code block can name and be highlighted as.
//
// Each grammar is its own lazily loaded chunk, so this list costs nothing until
// a block names one of them. It is curated rather than Shiki's full bundle: the
// built assets are precached for offline use, and hundreds of grammars nobody
// writes in a notebook would all be downloaded. A fence naming anything else is
// kept verbatim and shown as plain text.

import type { LanguageRegistration } from "shiki/core";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

export interface CodeLanguage {
  /** The name written into a new fence. */
  id: string;
  label: string;
  /** Lowercase fence names that select this language, besides `id`. */
  aliases: readonly string[];
  grammar: Grammar;
}

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  {
    id: "asm",
    label: "Assembly",
    aliases: ["assembly", "nasm", "s"],
    grammar: () => import("shiki/langs/asm.mjs"),
  },
  {
    id: "bash",
    label: "Bash",
    aliases: ["sh", "shell", "shellscript", "zsh"],
    grammar: () => import("shiki/langs/shellscript.mjs"),
  },
  { id: "c", label: "C", aliases: ["h"], grammar: () => import("shiki/langs/c.mjs") },
  {
    id: "cpp",
    label: "C++",
    aliases: ["c++", "cc", "cxx", "hh", "hpp", "hxx"],
    grammar: () => import("shiki/langs/cpp.mjs"),
  },
  {
    id: "csharp",
    label: "C#",
    aliases: ["c#", "cs"],
    grammar: () => import("shiki/langs/csharp.mjs"),
  },
  { id: "cmake", label: "CMake", aliases: [], grammar: () => import("shiki/langs/cmake.mjs") },
  { id: "css", label: "CSS", aliases: [], grammar: () => import("shiki/langs/css.mjs") },
  { id: "diff", label: "Diff", aliases: ["patch"], grammar: () => import("shiki/langs/diff.mjs") },
  {
    id: "dockerfile",
    label: "Dockerfile",
    aliases: ["docker"],
    grammar: () => import("shiki/langs/docker.mjs"),
  },
  { id: "go", label: "Go", aliases: ["golang"], grammar: () => import("shiki/langs/go.mjs") },
  { id: "html", label: "HTML", aliases: ["htm"], grammar: () => import("shiki/langs/html.mjs") },
  {
    id: "ini",
    label: "INI",
    aliases: ["conf", "cfg"],
    grammar: () => import("shiki/langs/ini.mjs"),
  },
  { id: "java", label: "Java", aliases: [], grammar: () => import("shiki/langs/java.mjs") },
  {
    id: "javascript",
    label: "JavaScript",
    aliases: ["js", "cjs", "mjs"],
    grammar: () => import("shiki/langs/javascript.mjs"),
  },
  {
    id: "json",
    label: "JSON",
    aliases: ["jsonc", "json5"],
    grammar: () => import("shiki/langs/json.mjs"),
  },
  // TSX is a superset of JSX, so one grammar serves both.
  { id: "jsx", label: "JSX", aliases: [], grammar: () => import("shiki/langs/tsx.mjs") },
  {
    id: "kotlin",
    label: "Kotlin",
    aliases: ["kt", "kts"],
    grammar: () => import("shiki/langs/kotlin.mjs"),
  },
  {
    id: "makefile",
    label: "Makefile",
    aliases: ["make", "mk"],
    grammar: () => import("shiki/langs/make.mjs"),
  },
  {
    id: "markdown",
    label: "Markdown",
    aliases: ["md"],
    grammar: () => import("shiki/langs/markdown.mjs"),
  },
  {
    id: "python",
    label: "Python",
    aliases: ["py", "python3"],
    grammar: () => import("shiki/langs/python.mjs"),
  },
  { id: "rust", label: "Rust", aliases: ["rs"], grammar: () => import("shiki/langs/rust.mjs") },
  { id: "sql", label: "SQL", aliases: [], grammar: () => import("shiki/langs/sql.mjs") },
  {
    id: "systemverilog",
    label: "SystemVerilog",
    aliases: ["sv", "svh", "system-verilog"],
    grammar: () => import("shiki/langs/system-verilog.mjs"),
  },
  { id: "toml", label: "TOML", aliases: [], grammar: () => import("shiki/langs/toml.mjs") },
  { id: "tsx", label: "TSX", aliases: [], grammar: () => import("shiki/langs/tsx.mjs") },
  {
    id: "typescript",
    label: "TypeScript",
    aliases: ["ts", "cts", "mts"],
    grammar: () => import("shiki/langs/typescript.mjs"),
  },
  {
    id: "verilog",
    label: "Verilog",
    aliases: ["v"],
    grammar: () => import("shiki/langs/verilog.mjs"),
  },
  { id: "xml", label: "XML", aliases: ["svg"], grammar: () => import("shiki/langs/xml.mjs") },
  { id: "yaml", label: "YAML", aliases: ["yml"], grammar: () => import("shiki/langs/yaml.mjs") },
];

const BY_NAME = new Map<string, CodeLanguage>(
  CODE_LANGUAGES.flatMap((language) =>
    [language.id, ...language.aliases].map((name) => [name, language] as const),
  ),
);

/** The language a fence's info string names: its first word, case-insensitively. */
export function codeLanguage(info: string): CodeLanguage | undefined {
  const name = info.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  return name ? BY_NAME.get(name) : undefined;
}
