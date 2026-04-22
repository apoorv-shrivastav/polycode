import { z } from "zod";

export const FindingSeveritySchema = z.enum(["high", "med", "low"]);

export const FindingSchema = z.object({
  severity: FindingSeveritySchema,
  path: z.string(),
  line: z.number().int().optional(),
  issue: z.string(),
  suggestion: z.string().optional(),
});

export const ReviewVerdictSchema = z.enum(["approve", "request_changes", "reject"]);

export const ReviewArtifactSchema = z.object({
  step_id: z.string(),
  verdict: ReviewVerdictSchema,
  findings: z.array(FindingSchema),
  tests_suggested: z.array(z.string()),
  overall_notes: z.string(),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
