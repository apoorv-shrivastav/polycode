import { z } from "zod";

export const NetworkModeSchema = z.enum(["deny", "allow_list"]);

/**
 * Per-role tool allowlists per §4.2.
 * Planner: read-only. Reviewer: read-only. Implementer: edit tools.
 * Bash is NEVER included here — it's gated separately by bash_enabled.
 */
export const AllowedToolsByRoleSchema = z.object({
  planner: z.array(z.string()),
  implementer: z.array(z.string()),
  reviewer: z.array(z.string()),
});

export const PolicySchema = z.object({
  version: z.literal(1),
  allowed_paths: z.array(z.string()),
  denied_paths: z.array(z.string()),
  allowed_tools_by_role: AllowedToolsByRoleSchema,
  bash_enabled: z.boolean(),
  allowed_bash_prefixes: z.array(z.string()),
  network: z.object({ mode: NetworkModeSchema }),
  network_allow: z.array(z.string()),
  budget_usd: z.number().positive(),
  wall_clock_seconds: z.number().int().positive(),
  max_turns_per_invocation: z.number().int().positive(),
  max_review_cycles_per_step: z.number().int().positive(),
  reviewer_provider: z.enum(["same", "different"]),
});

export type Policy = z.infer<typeof PolicySchema>;

/**
 * Default policy per §4.2.
 * Bash is OFF by default. Planner and reviewer are read-only.
 */
export const DEFAULT_POLICY: Policy = {
  version: 1,
  allowed_paths: ["src/**", "test/**", "package.json"],
  denied_paths: ["**/.env*", "**/secrets/**", "**/id_*", "**/.ssh/**"],
  allowed_tools_by_role: {
    planner: ["Read", "Grep", "Glob"],
    implementer: ["Read", "Edit", "Write", "Grep", "Glob"],
    reviewer: ["Read"],
  },
  bash_enabled: false,
  allowed_bash_prefixes: [],
  network: { mode: "deny" },
  network_allow: [],
  budget_usd: 2.5,
  wall_clock_seconds: 1800,
  max_turns_per_invocation: 40,
  max_review_cycles_per_step: 2,
  reviewer_provider: "same",
};
