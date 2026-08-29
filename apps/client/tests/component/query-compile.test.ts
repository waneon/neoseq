// What the builder actually asks the graph.
//
// The compiler is the seam between an intuitive plan and a profile the core
// validates, so these assert the *shape* of the SPARQL — parameters instead of
// spliced text, NOT EXISTS for negatives, EXISTS for alternatives, GROUP BY when
// a column summarizes. The query crate owns the matching proof that those shapes
// parse and evaluate (`sparql_accepts_the_shapes_the_query_builder_compiles`).

import { describe, expect, it } from "vitest";
import {
  compileEntityProjection,
  compilePlan,
  entityIri,
  isCompilerVariable,
  momentTimeVariable,
  planBindings,
  resolveRelativeDate,
} from "../../src/entities/query-compile";
import {
  defaultPlan,
  emptyGroup,
  type PlanCondition,
  type PlanGroup,
  type QueryPlan,
} from "../../src/entities/query-plan";

const RUNTIME = { graphId: "test-graph", today: "2026-08-18" };

function condition(partial: Omit<PlanCondition, "id" | "kind">): PlanCondition {
  return { id: `c-${partial.op}-${partial.field.kind}`, kind: "condition", ...partial };
}

function withWhere(plan: QueryPlan, where: PlanGroup): QueryPlan {
  return { ...plan, where };
}

describe("query plan compilation", () => {
  it("selects a subject, its text, and its page for the starting plan", () => {
    const { source, parameters, variables, subjectVariable } = compilePlan(defaultPlan("block"));
    expect(parameters).toEqual([]);
    // Which thing a row is comes back whether or not a column asked for it, and
    // it is never a column of its own.
    expect(subjectVariable).toBe("q_subject");
    expect(variables).toEqual(["q_subject", "text", "page"]);
    expect(source).toContain("?q_subject a neo:Block .");
    expect(source).toContain("OPTIONAL { ?q_subject neo:content ?text }");
    expect(source).toContain("OPTIONAL { ?q_subject neo:page ?page }");
    expect(source).toContain("ORDER BY ?q_subject");
    expect(source).toContain("LIMIT 100");
  });

  // Order is presentation. A `LIMIT` still has to cut against something, so the
  // subject is the whole of the query's own order; which rows a reader sees
  // first is decided after the answer arrives, by the view they read it in
  // (`query-ordering.test.ts`).
  it("orders only by the subject, whatever the plan shows", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [
        { id: "priority", source: { kind: "property", key: "builtin.task-priority" } },
        { id: "page", source: { kind: "page" } },
      ],
    };
    const { source } = compilePlan(plan);
    expect(source).toContain("ORDER BY ?q_subject");
    expect(source.match(/ORDER BY .*/)?.[0]).toBe("ORDER BY ?q_subject");
  });

  it("sends every user value as a bound parameter, never as spliced text", () => {
    const plan = withWhere(defaultPlan("block"), {
      ...emptyGroup("all"),
      children: [
        condition({
          field: { kind: "content" },
          op: "contains",
          value: { type: "text", value: '") } DROP ALL #' },
        }),
      ],
    });
    const { source, parameters } = compilePlan(plan);
    expect(source).not.toContain("DROP ALL");
    expect(source).toContain("neo:matchesText(?q_v1, ?q_p0)");
    expect(parameters).toEqual([
      { name: "q_p0", value: { type: "text", value: '") } DROP ALL #' } },
    ]);
  });

  it("resolves a relative date against the reader's today on every run", () => {
    const plan = withWhere(defaultPlan("block"), {
      ...emptyGroup("all"),
      children: [
        condition({
          field: { kind: "property", key: "builtin.task-deadline" },
          op: "lte",
          value: { type: "relative", value: { unit: "day", offset: 0 } },
        }),
      ],
    });
    const { source, parameters } = compilePlan(plan);
    // The stored source names the parameter; the day itself is bound at run
    // time, so "due today" is still true tomorrow.
    expect(source).toContain("FILTER(?q_v1 <= ?q_p0)");
    expect(source).not.toContain("2026-08-18");
    expect(planBindings(parameters, RUNTIME)).toEqual({
      q_p0: {
        kind: "literal",
        value: "2026-08-18",
        datatype: "http://www.w3.org/2001/XMLSchema#date",
      },
    });
    expect(planBindings(parameters, { ...RUNTIME, today: "2026-09-01" }).q_p0).toMatchObject({
      value: "2026-09-01",
    });
  });

  it("reads week and month offsets as calendar boundaries", () => {
    // 2026-08-18 is a Tuesday.
    expect(resolveRelativeDate({ unit: "week", offset: 0 }, "2026-08-18")).toBe("2026-08-17");
    expect(resolveRelativeDate({ unit: "week", offset: 1 }, "2026-08-18")).toBe("2026-08-24");
    expect(resolveRelativeDate({ unit: "month", offset: 0 }, "2026-08-18")).toBe("2026-08-01");
    expect(resolveRelativeDate({ unit: "month", offset: 1 }, "2026-08-18")).toBe("2026-09-01");
  });

  it("asks a negative as NOT EXISTS so rows with no value survive it", () => {
    const plan = withWhere(defaultPlan("block"), {
      ...emptyGroup("all"),
      children: [
        condition({
          field: { kind: "property", key: "builtin.task-status" },
          op: "not_equals",
          value: { type: "text", value: "done" },
        }),
      ],
    });
    const { source } = compilePlan(plan);
    expect(source).toContain("FILTER NOT EXISTS {");
    expect(source).toContain("?q_subject prop:builtin.task-status ?q_p0 .");
  });

  it("compiles alternatives as EXISTS, which the row and its parameters reach", () => {
    const inner: PlanGroup = {
      ...emptyGroup("any"),
      id: "g-any",
      children: [
        condition({
          field: { kind: "tag" },
          op: "equals",
          value: { type: "tag", value: "project" },
        }),
        condition({
          field: { kind: "property", key: "builtin.task-priority" },
          op: "equals",
          value: { type: "text", value: "high" },
        }),
      ],
    };
    const { source } = compilePlan(
      withWhere(defaultPlan("block"), { ...emptyGroup("all"), children: [inner] }),
    );
    // Not UNION: a union branch is evaluated before it joins, so neither the row
    // in hand nor a bound parameter would be visible inside it.
    expect(source).not.toContain("UNION");
    expect(source).toContain("FILTER(");
    expect(source.match(/EXISTS \{/g)).toHaveLength(2);
    expect(source).toContain("||");
    // The subject is anchored exactly once, at the top.
    expect(source.match(/\?q_subject a neo:Block \./g)).toHaveLength(1);
  });

  it("compiles “none of these” as the negation of the same disjunction", () => {
    const inner: PlanGroup = {
      ...emptyGroup("none"),
      id: "g-none",
      children: [
        condition({
          field: { kind: "tag" },
          op: "equals",
          value: { type: "tag", value: "project" },
        }),
      ],
    };
    const { source } = compilePlan(
      withWhere(defaultPlan("block"), { ...emptyGroup("all"), children: [inner] }),
    );
    expect(source).toContain("FILTER(");
    expect(source).toContain("!(");
    expect(source).toContain("EXISTS {");
  });

  it("folds a repeated relation into one cell and groups the rest", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [
        { id: "status", source: { kind: "property", key: "builtin.task-status" } },
        { id: "tags", source: { kind: "tags" }, aggregate: "list" },
        { id: "total", source: { kind: "subject" }, aggregate: "count" },
      ],
    };
    const { source, variables, subjectVariable } = compilePlan(plan);
    // A summary has no row identity: the row *is* the group.
    expect(subjectVariable).toBeNull();
    expect(variables).toEqual(["status", "tags", "total"]);
    expect(source).toContain('GROUP_CONCAT(DISTINCT ?q_a1; SEPARATOR="\\u001F") AS ?tags');
    expect(source).toContain("(COUNT(DISTINCT ?q_subject) AS ?total)");
    expect(source).toContain("GROUP BY ?status");
  });

  it("selects the time of day beside the moment it refines, as no column of its own", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [
        { id: "scheduled", source: { kind: "property", key: "builtin.task-scheduled" } },
        { id: "deadline", source: { kind: "property", key: "builtin.task-deadline" } },
        { id: "status", source: { kind: "property", key: "builtin.task-status" } },
      ],
    };
    const { source, variables } = compilePlan(plan);
    // A moment is a day plus an optional time, so a column that shows one asks
    // for both. Only the moments get a companion — a status has no time.
    expect(variables).toEqual([
      "q_subject",
      "scheduled",
      momentTimeVariable("scheduled"),
      "deadline",
      momentTimeVariable("deadline"),
      "status",
    ]);
    expect(source).toContain(
      "OPTIONAL { ?q_subject prop:builtin.task-scheduled-time ?q_time_scheduled }",
    );
    expect(source).toContain(
      "OPTIONAL { ?q_subject prop:builtin.task-deadline-time ?q_time_deadline }",
    );
    // The companion lives in the compiler's own namespace, which is what keeps
    // it out of the columns a table draws (§ resultColumns).
    expect(variables.filter(isCompilerVariable)).toEqual([
      "q_subject",
      momentTimeVariable("scheduled"),
      momentTimeVariable("deadline"),
    ]);
  });

  it("asks for no time beside a moment it is summarizing", () => {
    const plan: QueryPlan = {
      ...defaultPlan("block"),
      columns: [
        {
          id: "latest",
          source: { kind: "property", key: "builtin.task-scheduled" },
          aggregate: "max",
        },
      ],
    };
    const { source, variables } = compilePlan(plan);
    // The latest of a set of days is a day. There is no one time of day it is
    // at, so nothing pretends there is.
    expect(variables).toEqual(["latest"]);
    expect(source).not.toContain("task-scheduled-time");
  });

  it("compiles an entity projection without table columns or their aggregates", () => {
    const plan = withWhere(
      {
        ...defaultPlan("block"),
        columns: [
          { id: "text", source: { kind: "content" } },
          { id: "tags", source: { kind: "tags" }, aggregate: "list" },
        ],
      },
      {
        ...emptyGroup("all"),
        children: [
          condition({
            field: { kind: "property", key: "builtin.task-status" },
            op: "equals",
            value: { type: "text", value: "todo" },
          }),
        ],
      },
    );

    const { source, variables, subjectVariable, parameters } = compileEntityProjection(plan);
    expect(subjectVariable).toBe("q_subject");
    expect(variables).toEqual(["q_subject"]);
    expect(source).toContain("SELECT ?q_subject WHERE");
    expect(source).toContain("?q_subject prop:builtin.task-status ?q_p0 .");
    expect(source).not.toContain("neo:content ?text");
    expect(source).not.toContain("GROUP_CONCAT");
    expect(source).not.toContain("GROUP BY");
    expect(parameters).toEqual([
      {
        name: "q_p0",
        value: { type: "text", value: "todo" },
      },
    ]);
  });

  it("names entities by stable IRI, and inlines them when the builder is left", () => {
    const plan = withWhere(defaultPlan("block"), {
      ...emptyGroup("all"),
      children: [
        condition({
          field: { kind: "tag" },
          op: "equals",
          value: { type: "tag", value: "project" },
        }),
      ],
    });
    const iri = entityIri("test-graph", "tag", "project");
    expect(iri).toBe("urn:neoseq:entity:test-graph:tag:project");
    expect(planBindings(compilePlan(plan).parameters, RUNTIME)).toEqual({
      q_p0: { kind: "iri", value: iri },
    });
  });

  it("keeps a graph id with spaces percent-encoded, as the projection does", () => {
    expect(entityIri("query graph", "page", "a/b")).toBe(
      "urn:neoseq:entity:query%20graph:page:a%2Fb",
    );
  });
});
