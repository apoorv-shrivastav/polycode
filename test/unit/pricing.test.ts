import { describe, it, expect } from "vitest";
import { computeCostFromTokens } from "../../src/providers/pricing.js";

const mockTable = {
  fetched_at: "2026-04-23T00:00:00Z",
  source: "https://example.com",
  models: {
    "model-a": { input_per_million: 2.0, output_per_million: 8.0 },
    "model-b": { input_per_million: 1.0, output_per_million: 4.0 },
  },
};

describe("computeCostFromTokens", () => {
  it("computes cost for a known model", () => {
    // 1000 input + 500 output with model-a
    const cost = computeCostFromTokens(mockTable, "model-a", 1000, 500);
    // (1000/1M)*2.0 + (500/1M)*8.0 = 0.002 + 0.004 = 0.006
    expect(cost).toBeCloseTo(0.006);
  });

  it("uses most expensive model for unknown model", () => {
    const cost = computeCostFromTokens(mockTable, "unknown-model", 1000, 500);
    // Falls back to model-a (more expensive output)
    expect(cost).toBeCloseTo(0.006);
  });

  it("handles zero tokens", () => {
    expect(computeCostFromTokens(mockTable, "model-a", 0, 0)).toBe(0);
  });

  it("handles large token counts", () => {
    const cost = computeCostFromTokens(mockTable, "model-b", 1_000_000, 100_000);
    // (1M/1M)*1.0 + (100K/1M)*4.0 = 1.0 + 0.4 = 1.4
    expect(cost).toBeCloseTo(1.4);
  });
});
