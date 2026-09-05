import { describe, expect, it } from "vitest";
import {
  DERIVED_SOURCE_PROVENANCE,
  derivedSourceMarker,
  derivedSourceProvenance,
} from "../../src/entities/query-compile";
import { defaultPlan, decodePlan, QUERY_PLAN_VERSION } from "../../src/entities/query-plan";

describe("query plan grain", () => {
  it("preserves explicit entity and summary identity across persistence", () => {
    const entity = defaultPlan("block");
    expect(decodePlan(JSON.stringify(entity), QUERY_PLAN_VERSION)?.grain).toBe("entity");
    const summary = {
      ...entity,
      grain: "summary",
      columns: [{ id: "count", source: { kind: "subject" }, aggregate: "count" }],
    };
    expect(decodePlan(JSON.stringify(summary), QUERY_PLAN_VERSION)?.grain).toBe("summary");
    expect(
      decodePlan(JSON.stringify({ ...summary, grain: "entity" }), QUERY_PLAN_VERSION),
    ).toBeNull();
    expect(
      decodePlan(JSON.stringify({ ...entity, grain: "summary" }), QUERY_PLAN_VERSION),
    ).toBeNull();
  });

  it("does not reinterpret a v1 query whose renderer used to choose its row grain", () => {
    const { grain: _, ...old } = defaultPlan("block");
    expect(decodePlan(JSON.stringify({ ...old, version: 1 }), 1)).toBeNull();
    expect(decodePlan(JSON.stringify(old), QUERY_PLAN_VERSION)).toBeNull();
  });
});

describe("Rust-derived source provenance", () => {
  it("associates a compatibility artifact with the exact plan payload", () => {
    const plan = defaultPlan("block");
    const storedPlan = { version: plan.version, payload: JSON.stringify(plan) };
    const marker = derivedSourceMarker(storedPlan);

    expect(marker).toMatch(
      new RegExp(
        `^${DERIVED_SOURCE_PROVENANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${QUERY_PLAN_VERSION};fnv1a32=[0-9a-f]{8}\\n$`,
      ),
    );
    expect(derivedSourceProvenance(`${marker}SELECT * WHERE {}\n`, storedPlan)).toBe("current");
    expect(derivedSourceProvenance("SELECT * WHERE {}", storedPlan)).toBe("legacy_unmarked");
    expect(
      derivedSourceProvenance(
        `${DERIVED_SOURCE_PROVENANCE}${QUERY_PLAN_VERSION};fnv1a32=00000000\n`,
        storedPlan,
      ),
    ).toBe("stale");
  });
});
