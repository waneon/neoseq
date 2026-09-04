import { describe, expect, it } from "vitest";
import {
  DERIVED_SOURCE_PROVENANCE,
  derivedSourceMarker,
  derivedSourceProvenance,
  isCompilerVariable,
  momentTimeVariable,
  planProjection,
} from "../../src/entities/query-compile";
import { defaultPlan, type QueryPlan } from "../../src/entities/query-plan";

describe("query plan presentation metadata", () => {
  it("predicts ordinary and entity projection names without compiling query semantics", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [
        { id: "body", source: { kind: "content" } },
        {
          id: "scheduled",
          source: { kind: "property", key: "builtin.task-scheduled" },
        },
      ],
    };

    expect(planProjection(plan)).toEqual({
      variables: ["q_subject", "body", "scheduled", momentTimeVariable("scheduled")],
      subjectVariable: "q_subject",
    });
    expect(planProjection(plan, "entities")).toEqual({
      variables: ["q_subject"],
      subjectVariable: "q_subject",
    });
  });

  it("omits subject identity from aggregate-shaped answers", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [{ id: "total", source: { kind: "subject" }, aggregate: "count" }],
    };

    expect(planProjection(plan)).toEqual({ variables: ["total"], subjectVariable: null });
    expect(isCompilerVariable("q_subject")).toBe(true);
    expect(isCompilerVariable("total")).toBe(false);
  });
});

describe("Rust-derived source provenance", () => {
  it("associates a compatibility artifact with the exact plan payload", () => {
    const plan = defaultPlan("block");
    const storedPlan = { version: plan.version, payload: JSON.stringify(plan) };
    const marker = derivedSourceMarker(storedPlan);

    expect(marker).toMatch(
      new RegExp(
        `^${DERIVED_SOURCE_PROVENANCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}1;fnv1a32=[0-9a-f]{8}\\n$`,
      ),
    );
    expect(derivedSourceProvenance(`${marker}SELECT * WHERE {}\n`, storedPlan)).toBe("current");
    expect(derivedSourceProvenance("SELECT * WHERE {}", storedPlan)).toBe("legacy_unmarked");
    expect(
      derivedSourceProvenance(`${DERIVED_SOURCE_PROVENANCE}1;fnv1a32=00000000\n`, storedPlan),
    ).toBe("stale");
  });
});
