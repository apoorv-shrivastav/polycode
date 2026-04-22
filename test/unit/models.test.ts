import { describe, it, expect } from "vitest";
import { PolicySchema, DEFAULT_POLICY } from "../../src/models/policy.js";
import { PlanSchema } from "../../src/models/plan.js";
import { ReviewArtifactSchema } from "../../src/models/review.js";

describe("PolicySchema v0.2", () => {
  it("validates the default policy", () => {
    expect(PolicySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
  });

  it("rejects invalid version", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, version: 2 }).success).toBe(false);
  });

  it("rejects negative budget", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, budget_usd: -1 }).success).toBe(false);
  });

  it("rejects zero budget", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, budget_usd: 0 }).success).toBe(false);
  });

  it("requires allowed_tools_by_role instead of flat allowed_tools", () => {
    const oldStyle = { ...DEFAULT_POLICY, allowed_tools: ["Read"], allowed_tools_by_role: undefined };
    expect(PolicySchema.safeParse(oldStyle).success).toBe(false);
  });

  it("requires bash_enabled field", () => {
    const without = { ...DEFAULT_POLICY, bash_enabled: undefined };
    expect(PolicySchema.safeParse(without).success).toBe(false);
  });

  it("requires max_review_cycles_per_step", () => {
    const without = { ...DEFAULT_POLICY, max_review_cycles_per_step: undefined };
    expect(PolicySchema.safeParse(without).success).toBe(false);
  });

  it("validates reviewer_provider enum", () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, reviewer_provider: "same" }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, reviewer_provider: "different" }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, reviewer_provider: "invalid" }).success).toBe(false);
  });

  it("default policy has bash_enabled=false", () => {
    expect(DEFAULT_POLICY.bash_enabled).toBe(false);
  });

  it("default denied_paths includes SSH keys", () => {
    expect(DEFAULT_POLICY.denied_paths).toContain("**/id_*");
    expect(DEFAULT_POLICY.denied_paths).toContain("**/.ssh/**");
  });
});

describe("PlanSchema v0.2", () => {
  it("validates a valid plan WITHOUT estimated_cost_usd", () => {
    const plan = {
      task: "Refactor auth",
      steps: [{
        id: "01",
        intent: "Extract session token generation",
        touches_paths: ["src/auth/session.ts"],
        verification: "npm test -- auth",
      }],
      assumptions: ["Tests cover behavior"],
      out_of_scope: ["Storage backend"],
    };
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects plan with no steps", () => {
    const plan = { task: "Nothing", steps: [], assumptions: [], out_of_scope: [] };
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it("does NOT require estimated_cost_usd (removed in v0.2)", () => {
    const plan = {
      task: "Test",
      steps: [{ id: "01", intent: "Do thing", touches_paths: ["src/a.ts"], verification: "test" }],
      assumptions: [],
      out_of_scope: [],
    };
    // If estimated_cost_usd were still required, this would fail
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe("ReviewArtifactSchema", () => {
  it("validates a valid review", () => {
    const review = {
      step_id: "01",
      verdict: "approve",
      findings: [],
      tests_suggested: [],
      overall_notes: "Looks good",
    };
    expect(ReviewArtifactSchema.safeParse(review).success).toBe(true);
  });

  it("validates a review with findings", () => {
    const review = {
      step_id: "01",
      verdict: "request_changes",
      findings: [{
        severity: "high",
        path: "src/auth/session.ts",
        line: 42,
        issue: "Token expiry not validated",
        suggestion: "Add expiry check",
      }],
      tests_suggested: ["test expired token"],
      overall_notes: "Needs work",
    };
    expect(ReviewArtifactSchema.safeParse(review).success).toBe(true);
  });

  it("rejects invalid verdict", () => {
    const review = {
      step_id: "01", verdict: "maybe",
      findings: [], tests_suggested: [], overall_notes: "",
    };
    expect(ReviewArtifactSchema.safeParse(review).success).toBe(false);
  });
});
