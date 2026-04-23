import { z } from "zod";

/** Eval conditions per §9.1 */
export type EvalCondition = "A" | "B" | "C" | "D";

/** A single seeded defect in the corpus. */
export const DefectSchema = z.object({
  id: z.string(),
  codebase: z.string(),
  category: z.string(),
  description: z.string(),
  /** Path to the fault-introducing diff relative to the codebase root. */
  diff_file: z.string(),
  /** Path to a test file that fails when the defect is present. */
  test_file: z.string(),
  /** Command to run the test. */
  test_command: z.string(),
  /** The file(s) affected by this defect. */
  affected_files: z.array(z.string()),
});

export type Defect = z.infer<typeof DefectSchema>;

/** Corpus manifest listing all codebases and their defects. */
export const CorpusManifestSchema = z.object({
  version: z.literal(1),
  codebases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      setup_command: z.string().optional(),
    })
  ),
  defects: z.array(DefectSchema),
});

export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

/** Result of running one defect under one condition. */
export interface DefectRunResult {
  defectId: string;
  codebase: string;
  condition: EvalCondition;
  /** Did the reviewer (or self-review) flag this defect? */
  caught: boolean;
  /** Was it a false positive (flagged something that isn't the defect)? */
  falsePositive: boolean;
  /** Did the test catch it when the reviewer missed it? */
  testCaught: boolean;
  costUsd: number;
  durationMs: number;
  sessionId: string;
  error: string | null;
}

/** Aggregated metrics for one condition. */
export interface ConditionMetrics {
  condition: EvalCondition;
  totalDefects: number;
  defectsCaught: number;
  defectCatchRate: number;
  falsePositives: number;
  falsePositiveRate: number;
  totalCostUsd: number;
  costPerCaughtDefect: number;
  meanDurationMs: number;
  /** Per-codebase catch rates for stratified analysis. */
  perCodebase: Map<string, { total: number; caught: number; rate: number }>;
}

/** Confidence interval. */
export interface ConfidenceInterval {
  point: number;
  lower: number;
  upper: number;
}

/** Comparison result between two conditions. */
export interface ConditionComparison {
  baseline: EvalCondition;
  treatment: EvalCondition;
  baselineRate: number;
  treatmentRate: number;
  difference: number;
  ci95: ConfidenceInterval;
  /** Does CI exclude zero? */
  significant: boolean;
  /** Does effect hold in ≥60% of codebases? */
  stratifiedPass: boolean;
  codebases: number;
  codebasesWithEffect: number;
}
