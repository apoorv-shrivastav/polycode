import { z } from "zod";

/** Role of an agent turn within a polycode session. */
export const RoleSchema = z.enum(["planner", "implementer", "reviewer"]);
export type Role = z.infer<typeof RoleSchema>;

/** Session modes. */
export const SessionModeSchema = z.enum(["plan-implement-review", "plan-only", "review-only"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;

/** Session outcome per §7.2 state machine. */
export const SessionOutcomeSchema = z.enum([
  "completed",
  "accepted",
  "rejected",
  "aborted",
  "error",
  "plan_invalid",
  "step_rejected",
  "review_divergence",
  "budget_kill",
  "policy_violation",
  "paused",
]);
export type SessionOutcome = z.infer<typeof SessionOutcomeSchema>;

/** Exit reason for a single turn/invocation. */
export const ExitReasonSchema = z.enum([
  "ok",
  "budget_kill",
  "deadline_kill",
  "max_turns_kill",
  "policy_violation",
  "cli_error",
  "rate_limited",
  "auth_expired",
]);
export type ExitReason = z.infer<typeof ExitReasonSchema>;

/** Normalized turn reported by a provider adapter. */
export interface NormalizedTurn {
  provider: string;
  model: string;
  providerSession: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
  exitReason: ExitReason;
  rawResultJson: string;
}

/** Normalized tool event reported by a provider adapter. */
export interface NormalizedToolEvent {
  toolName: string;
  argsJson: string | null;
  resultSummary: string | null;
  path: string | null;
}

/** Result of a provider adapter run. */
export interface RunResult {
  turn: NormalizedTurn;
  textOutput: string;
}
