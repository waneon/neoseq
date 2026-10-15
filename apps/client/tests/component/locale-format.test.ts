// Dates and sizes read as written, whatever their magnitude.

import { expect, it } from "vitest";
import { createLocaleRuntime } from "../../src/i18n";

it("keeps a year before 100 as written", () => {
  const en = createLocaleRuntime("en");
  expect(en.formatLocalDate("0050-03-01")).toContain("50");
  expect(en.formatLocalDate("0050-03-01")).not.toContain("1950");
  expect(en.formatLocalDate("0001-01-01")).not.toContain("1901");
});

it("states a size in the unit it reads best in", () => {
  const en = createLocaleRuntime("en");
  expect(en.formatBytes(512)).toBe("512 byte");
  expect(en.formatBytes(12 * 1024)).toBe("12 kB");
  expect(en.formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
  expect(en.formatBytes(7 * 1024 ** 3)).toBe("7 GB");
});

it("explains a property name without storage prefixes", () => {
  for (const locale of ["en", "ko"] as const) {
    const text = createLocaleRuntime(locale).message("validation.keyFormat");
    expect(text).not.toMatch(/builtin|user\./);
  }
});
