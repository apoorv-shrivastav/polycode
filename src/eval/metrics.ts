import type {
  DefectRunResult,
  ConditionMetrics,
  ConditionComparison,
  ConfidenceInterval,
  EvalCondition,
} from "./types.js";

/**
 * Compute aggregated metrics for a single condition.
 */
export function computeConditionMetrics(
  condition: EvalCondition,
  results: DefectRunResult[]
): ConditionMetrics {
  const condResults = results.filter((r) => r.condition === condition && !r.error);
  const totalDefects = condResults.length;
  const defectsCaught = condResults.filter((r) => r.caught).length;
  const falsePositives = condResults.filter((r) => r.falsePositive).length;
  const totalCost = condResults.reduce((s, r) => s + r.costUsd, 0);
  const totalDuration = condResults.reduce((s, r) => s + r.durationMs, 0);

  // Per-codebase breakdown
  const perCodebase = new Map<string, { total: number; caught: number; rate: number }>();
  for (const r of condResults) {
    const entry = perCodebase.get(r.codebase) ?? { total: 0, caught: 0, rate: 0 };
    entry.total++;
    if (r.caught) entry.caught++;
    entry.rate = entry.total > 0 ? entry.caught / entry.total : 0;
    perCodebase.set(r.codebase, entry);
  }

  return {
    condition,
    totalDefects,
    defectsCaught,
    defectCatchRate: totalDefects > 0 ? defectsCaught / totalDefects : 0,
    falsePositives,
    falsePositiveRate: totalDefects > 0 ? falsePositives / totalDefects : 0,
    totalCostUsd: totalCost,
    costPerCaughtDefect: defectsCaught > 0 ? totalCost / defectsCaught : Infinity,
    meanDurationMs: totalDefects > 0 ? totalDuration / totalDefects : 0,
    perCodebase,
  };
}

/**
 * Compare two conditions using a two-proportion z-test with 95% CI.
 * Per §9.5: H1 supported if C beats A by ≥15pp AND B by ≥5pp, CIs excluding zero.
 */
export function compareConditions(
  baseline: ConditionMetrics,
  treatment: ConditionMetrics
): ConditionComparison {
  const p1 = baseline.defectCatchRate;
  const p2 = treatment.defectCatchRate;
  const n1 = baseline.totalDefects;
  const n2 = treatment.totalDefects;
  const diff = p2 - p1;

  // Two-proportion z-test CI
  const ci = proportionDifferenceCI(p1, n1, p2, n2, 0.05);

  // Stratified analysis: effect holds in ≥60% of codebases
  const codebases = new Set([
    ...baseline.perCodebase.keys(),
    ...treatment.perCodebase.keys(),
  ]);
  let codebasesWithEffect = 0;
  for (const cb of codebases) {
    const bRate = baseline.perCodebase.get(cb)?.rate ?? 0;
    const tRate = treatment.perCodebase.get(cb)?.rate ?? 0;
    if (tRate > bRate) codebasesWithEffect++;
  }

  return {
    baseline: baseline.condition,
    treatment: treatment.condition,
    baselineRate: p1,
    treatmentRate: p2,
    difference: diff,
    ci95: ci,
    significant: ci.lower > 0,
    stratifiedPass: codebases.size > 0 && codebasesWithEffect / codebases.size >= 0.6,
    codebases: codebases.size,
    codebasesWithEffect,
  };
}

/**
 * Compute 95% confidence interval for difference between two proportions.
 * Uses Wald interval: (p2-p1) ± z * sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)
 */
export function proportionDifferenceCI(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
  alpha: number
): ConfidenceInterval {
  const diff = p2 - p1;

  if (n1 === 0 || n2 === 0) {
    return { point: diff, lower: -1, upper: 1 };
  }

  // z-value for 95% CI (alpha = 0.05, two-sided)
  const z = zScore(1 - alpha / 2);
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);

  return {
    point: diff,
    lower: diff - z * se,
    upper: diff + z * se,
  };
}

/**
 * Approximate inverse normal CDF (z-score) using Abramowitz & Stegun.
 * Good to ~4.5e-4 absolute error.
 */
function zScore(p: number): number {
  // For p = 0.975, z ≈ 1.96
  if (p <= 0 || p >= 1) throw new Error(`p must be in (0,1), got ${p}`);

  // Rational approximation (Abramowitz & Stegun 26.2.23)
  const t = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;

  let z = t - (c0 + c1 * t + c2 * t * t) / (1 + d1 * t + d2 * t * t + d3 * t * t * t);
  if (p < 0.5) z = -z;
  return z;
}

/**
 * Apply the §9.5 pre-registered decision rule.
 */
export function applyDecisionRule(comparisons: {
  cVsA: ConditionComparison;
  cVsB: ConditionComparison;
}): {
  h1Supported: boolean;
  reason: string;
} {
  const { cVsA, cVsB } = comparisons;

  // H1: C beats A by ≥15pp AND C beats B by ≥5pp, CIs excluding zero, stratified ≥60%
  const aggregateCvsA = cVsA.difference >= 0.15 && cVsA.significant;
  const aggregateCvsB = cVsB.difference >= 0.05 && cVsB.significant;
  const stratifiedCvsA = cVsA.stratifiedPass;

  if (aggregateCvsA && aggregateCvsB && stratifiedCvsA) {
    return {
      h1Supported: true,
      reason: `H1 SUPPORTED: C beats A by ${(cVsA.difference * 100).toFixed(1)}pp ` +
        `(CI: [${(cVsA.ci95.lower * 100).toFixed(1)}, ${(cVsA.ci95.upper * 100).toFixed(1)}]) ` +
        `and C beats B by ${(cVsB.difference * 100).toFixed(1)}pp ` +
        `(CI: [${(cVsB.ci95.lower * 100).toFixed(1)}, ${(cVsB.ci95.upper * 100).toFixed(1)}]). ` +
        `Stratified: effect in ${cVsA.codebasesWithEffect}/${cVsA.codebases} codebases.`,
    };
  }

  const reasons: string[] = [];
  if (!aggregateCvsA) reasons.push(`C vs A: ${(cVsA.difference * 100).toFixed(1)}pp (need ≥15, CI excludes 0: ${cVsA.significant})`);
  if (!aggregateCvsB) reasons.push(`C vs B: ${(cVsB.difference * 100).toFixed(1)}pp (need ≥5, CI excludes 0: ${cVsB.significant})`);
  if (!stratifiedCvsA) reasons.push(`Stratified: ${cVsA.codebasesWithEffect}/${cVsA.codebases} codebases (need ≥60%)`);

  return {
    h1Supported: false,
    reason: `H1 NOT SUPPORTED: ${reasons.join("; ")}`,
  };
}

/**
 * Format results as CSV.
 */
export function resultsToCSV(results: DefectRunResult[]): string {
  const header = "defect_id,codebase,condition,caught,false_positive,test_caught,cost_usd,duration_ms,session_id,error";
  const rows = results.map((r) =>
    [
      r.defectId,
      r.codebase,
      r.condition,
      r.caught ? 1 : 0,
      r.falsePositive ? 1 : 0,
      r.testCaught ? 1 : 0,
      r.costUsd.toFixed(4),
      r.durationMs,
      r.sessionId,
      r.error ?? "",
    ].join(",")
  );
  return [header, ...rows].join("\n") + "\n";
}

/**
 * Format a summary report.
 */
export function formatSummaryReport(
  metricsMap: Map<EvalCondition, ConditionMetrics>,
  comparisons: ConditionComparison[],
  decision: { h1Supported: boolean; reason: string },
  totalCost: number,
  incomplete: boolean
): string {
  const lines: string[] = [
    "# polycode eval results",
    "",
    incomplete ? "**STATUS: INCOMPLETE** (cost ceiling reached)" : "**STATUS: COMPLETE**",
    "",
    `Total cost: $${totalCost.toFixed(2)}`,
    "",
    "## Per-condition metrics",
    "",
    "| Condition | Defects | Caught | Rate | FP | Cost | $/caught |",
    "|-----------|---------|--------|------|----|------|----------|",
  ];

  for (const [cond, m] of metricsMap) {
    lines.push(
      `| ${cond} | ${m.totalDefects} | ${m.defectsCaught} | ${(m.defectCatchRate * 100).toFixed(1)}% | ${m.falsePositives} | $${m.totalCostUsd.toFixed(2)} | $${m.costPerCaughtDefect === Infinity ? "∞" : m.costPerCaughtDefect.toFixed(2)} |`
    );
  }

  lines.push("", "## Comparisons (95% CI)", "");

  for (const c of comparisons) {
    lines.push(
      `**${c.treatment} vs ${c.baseline}**: ${(c.difference * 100).toFixed(1)}pp ` +
        `[${(c.ci95.lower * 100).toFixed(1)}, ${(c.ci95.upper * 100).toFixed(1)}] ` +
        `significant=${c.significant} stratified=${c.codebasesWithEffect}/${c.codebases}`
    );
  }

  lines.push("", "## Decision", "", decision.reason, "");

  return lines.join("\n");
}
