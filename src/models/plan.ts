import { z } from "zod";

/**
 * Plan artifact per §4.3.
 * estimated_cost_usd is removed — planner has no basis for grounding it.
 * Budget is session-level only.
 */
export const PlanStepSchema = z.object({
  id: z.string(),
  intent: z.string(),
  touches_paths: z.array(z.string()),
  verification: z.string(),
});

export const PlanSchema = z.object({
  task: z.string(),
  steps: z.array(PlanStepSchema).min(1),
  assumptions: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
