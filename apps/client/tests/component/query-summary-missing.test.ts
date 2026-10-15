// A condition still waiting for its value says so the same way for every field.

import { expect, it } from "vitest";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import { conditionPhrase } from "../../src/features/query/summary";
import { createLocaleRuntime } from "../../src/i18n";

it("leaves an unchosen tag or page as a missing value", () => {
  const { message } = createLocaleRuntime("en");
  const context = { snapshot: EMPTY_SNAPSHOT, message, formatDate: (date: string) => date };
  for (const [field, value] of [
    [{ kind: "tag" }, { type: "tag", value: "" }],
    [{ kind: "page" }, { type: "page", value: "" }],
  ] as const) {
    const phrase = conditionPhrase(
      { id: "c", kind: "condition", field, op: "equals", value },
      "block",
      context,
    );
    expect(phrase.value).toBe("");
  }
});
