import type { Command, QueryOwnerRef } from "../../core-port/commands";
import { INITIAL_QUERY_VIEW_ID } from "../../entities/query-document";
import { compilePlan } from "../../entities/query-compile";
import {
  defaultPlan,
  encodePlan,
  QUERY_PLAN_VERSION,
} from "../../entities/query-plan";

/** The command behind every UI route that creates an ordinary block query. */
export function createQueryCommand(owner: QueryOwnerRef): Command {
  const plan = defaultPlan();
  return {
    type: "set_query_plan",
    owner,
    view_id: INITIAL_QUERY_VIEW_ID,
    plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
    source: compilePlan(plan).source,
  };
}
