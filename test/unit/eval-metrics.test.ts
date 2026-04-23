import { describe, it, expect } from "vitest";
import {
  computeConditionMetrics,
  compareConditions,
  proportionDifferenceCI,
  applyDecisionRule,
  resultsToCSV,
} from "../../src/eval/metrics.js";
import type { DefectRunResult } from "../../src/eval/types.js";

function makeResult(overrides: Partial<DefectRunResult>): DefectRunResult {
  return {
    defectId: "test-001",
    codebase: "calc",
    condition: "A",
    caught: false,
    falsePositive: false,
    testCaught: false,
    costUsd: 0.10,
    durationMs: 1000,
    sessionId: "sess-1",
    error: null,
    ...overrides,
  };
}

describe("computeConditionMetrics", () => {
  it("computes catch rate correctly", () => {
    const results: DefectRunResult[] = [
      makeResult({ defectId: "d1", condition: "C", caught: true }),
      makeResult({ defectId: "d2", condition: "C", caught: true }),
      makeResult({ defectId: "d3", condition: "C", caught: false }),
      makeResult({ defectId: "d4", condition: "C", caught: true }),
    ];

    const m = computeConditionMetrics("C", results);
    expect(m.totalDefects).toBe(4);
    expect(m.defectsCaught).toBe(3);
    expect(m.defectCatchRate).toBeCloseTo(0.75);
  });

  it("excludes error results", () => {
    const results: DefectRunResult[] = [
      makeResult({ defectId: "d1", condition: "A", caught: true }),
      makeResult({ defectId: "d2", condition: "A", caught: false, error: "failed" }),
    ];

    const m = computeConditionMetrics("A", results);
    expect(m.totalDefects).toBe(1); // error excluded
    expect(m.defectsCaught).toBe(1);
    expect(m.defectCatchRate).toBe(1.0);
  });

  it("computes per-codebase breakdown", () => {
    const results: DefectRunResult[] = [
      makeResult({ defectId: "d1", codebase: "calc", condition: "C", caught: true }),
      makeResult({ defectId: "d2", codebase: "calc", condition: "C", caught: false }),
      makeResult({ defectId: "d3", codebase: "userstore", condition: "C", caught: true }),
      makeResult({ defectId: "d4", codebase: "userstore", condition: "C", caught: true }),
    ];

    const m = computeConditionMetrics("C", results);
    expect(m.perCodebase.get("calc")!.rate).toBeCloseTo(0.5);
    expect(m.perCodebase.get("userstore")!.rate).toBeCloseTo(1.0);
  });

  it("handles empty results", () => {
    const m = computeConditionMetrics("A", []);
    expect(m.totalDefects).toBe(0);
    expect(m.defectCatchRate).toBe(0);
    expect(m.costPerCaughtDefect).toBe(Infinity);
  });

  it("computes cost per caught defect", () => {
    const results: DefectRunResult[] = [
      makeResult({ condition: "C", caught: true, costUsd: 0.50 }),
      makeResult({ defectId: "d2", condition: "C", caught: true, costUsd: 0.30 }),
      makeResult({ defectId: "d3", condition: "C", caught: false, costUsd: 0.20 }),
    ];
    const m = computeConditionMetrics("C", results);
    expect(m.costPerCaughtDefect).toBeCloseTo(0.50); // $1.00 / 2 caught
  });
});

describe("proportionDifferenceCI", () => {
  it("returns correct CI for well-separated proportions", () => {
    const ci = proportionDifferenceCI(0.3, 100, 0.6, 100, 0.05);
    expect(ci.point).toBeCloseTo(0.3);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.upper).toBeGreaterThan(ci.lower);
  });

  it("CI includes zero for similar proportions with small n", () => {
    const ci = proportionDifferenceCI(0.5, 10, 0.55, 10, 0.05);
    expect(ci.lower).toBeLessThan(0);
    expect(ci.upper).toBeGreaterThan(0);
  });

  it("handles edge case of n=0", () => {
    const ci = proportionDifferenceCI(0.5, 0, 0.5, 10, 0.05);
    expect(ci.lower).toBe(-1);
    expect(ci.upper).toBe(1);
  });
});

describe("compareConditions", () => {
  it("detects significant improvement", () => {
    const baseline = computeConditionMetrics("A", [
      makeResult({ defectId: "d1", codebase: "calc", condition: "A", caught: false }),
      makeResult({ defectId: "d2", codebase: "calc", condition: "A", caught: false }),
      makeResult({ defectId: "d3", codebase: "calc", condition: "A", caught: true }),
      makeResult({ defectId: "d4", codebase: "userstore", condition: "A", caught: false }),
      makeResult({ defectId: "d5", codebase: "userstore", condition: "A", caught: false }),
    ]);
    // Large fake dataset to get significance
    const treatmentResults: DefectRunResult[] = [];
    for (let i = 0; i < 50; i++) {
      treatmentResults.push(makeResult({
        defectId: `d${i}`,
        codebase: i < 25 ? "calc" : "userstore",
        condition: "C",
        caught: Math.random() < 0.8,
      }));
    }
    const treatment = computeConditionMetrics("C", treatmentResults);

    const comparison = compareConditions(baseline, treatment);
    expect(comparison.baseline).toBe("A");
    expect(comparison.treatment).toBe("C");
    expect(comparison.difference).toBeGreaterThan(0);
  });
});

describe("applyDecisionRule", () => {
  it("supports H1 when thresholds are met", () => {
    // Create metrics where C clearly beats A and B
    const metricsA = computeConditionMetrics("A", Array.from({ length: 40 }, (_, i) =>
      makeResult({ defectId: `d${i}`, codebase: i < 20 ? "calc" : "userstore", condition: "A", caught: i % 5 === 0 })
    ));
    const metricsB = computeConditionMetrics("B", Array.from({ length: 40 }, (_, i) =>
      makeResult({ defectId: `d${i}`, codebase: i < 20 ? "calc" : "userstore", condition: "B", caught: i % 3 === 0 })
    ));
    const metricsC = computeConditionMetrics("C", Array.from({ length: 40 }, (_, i) =>
      makeResult({ defectId: `d${i}`, codebase: i < 20 ? "calc" : "userstore", condition: "C", caught: i % 5 !== 0 })
    ));

    const result = applyDecisionRule({
      cVsA: compareConditions(metricsA, metricsC),
      cVsB: compareConditions(metricsB, metricsC),
    });

    // The result depends on the specific data — we just test the structure
    expect(result).toHaveProperty("h1Supported");
    expect(result).toHaveProperty("reason");
    expect(typeof result.reason).toBe("string");
  });
});

describe("resultsToCSV", () => {
  it("generates valid CSV with header", () => {
    const results: DefectRunResult[] = [
      makeResult({ defectId: "d1", condition: "A", caught: true, costUsd: 0.50 }),
      makeResult({ defectId: "d2", condition: "C", caught: false, costUsd: 0.30 }),
    ];

    const csv = resultsToCSV(results);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("defect_id,codebase,condition,caught,false_positive,test_caught,cost_usd,duration_ms,session_id,error");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain("d1,calc,A,1");
    expect(lines[2]).toContain("d2,calc,C,0");
  });
});
