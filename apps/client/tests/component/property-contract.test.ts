import { describe, expect, it } from "vitest";
import { canUserWrite, validateKey, visibilityOf } from "../../src/entities/properties";

describe("property key namespaces", () => {
  it("accepts two-level user keys and rejects other shapes", () => {
    expect(validateKey("user.rating")).toBeNull();
    expect(validateKey("user.crm-id2")).toBeNull();
    expect(validateKey("rating")?.code).toBe("key_format");
    expect(validateKey("custom.rating")?.code).toBe("key_format");
    expect(validateKey("user.task.status")?.code).toBe("key_format");
    expect(validateKey("user.Task")?.code).toBe("key_format");
  });

  it("preserves unknown built-ins as generic read-only properties", () => {
    expect(visibilityOf("builtin.future-field")).toBe("generic");
    expect(canUserWrite("builtin.future-field", "page")).toBe(false);
    expect(validateKey("builtin.future-field")?.code).toBe("reserved_key");
  });

  it("keeps feature-owned ordering out of generic property surfaces", () => {
    expect(visibilityOf("builtin.favorite-order")).toBe("feature_only");
  });
});
