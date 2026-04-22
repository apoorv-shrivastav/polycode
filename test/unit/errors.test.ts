import { describe, it, expect } from "vitest";
import {
  PolycodeError,
  BinaryMissing,
  AuthExpired,
  RateLimited,
  MidSessionInterrupt,
  PolicyViolation,
  BudgetKill,
  ToolEventUnknown,
  DirtyWorkTree,
  ReviewDivergence,
} from "../../src/errors.js";

describe("typed error matrix", () => {
  it("BinaryMissing has exit code 127", () => {
    const err = new BinaryMissing("not found");
    expect(err).toBeInstanceOf(PolycodeError);
    expect(err.exitCode).toBe(127);
    expect(err.code).toBe("BINARY_MISSING");
    expect(err.remediation).toContain("Install");
  });

  it("AuthExpired has exit code 4", () => {
    const err = new AuthExpired();
    expect(err.exitCode).toBe(4);
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.remediation).toContain("claude login");
  });

  it("RateLimited has retry hint", () => {
    const err = new RateLimited(30, false);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.remediation).toContain("30 seconds");
  });

  it("MidSessionInterrupt includes resume command", () => {
    const err = new MidSessionInterrupt({
      sessionId: "test-123",
      lastCompletedStep: "01",
      patchFile: null,
      reason: "SIGINT",
    });
    expect(err.exitCode).toBe(7);
    expect(err.sessionId).toBe("test-123");
    expect(err.remediation).toContain("test-123");
  });

  it("PolicyViolation covers path_escape, tool_disallowed, bash_violation", () => {
    const pathErr = new PolicyViolation("path_escape", "escaped /etc");
    expect(pathErr.exitCode).toBe(3);
    expect(pathErr.violationType).toBe("path_escape");

    const toolErr = new PolicyViolation("tool_disallowed", "WebFetch");
    expect(toolErr.violationType).toBe("tool_disallowed");

    const bashErr = new PolicyViolation("bash_violation", "rm -rf");
    expect(bashErr.violationType).toBe("bash_violation");
  });

  it("BudgetKill includes cap and used amounts", () => {
    const err = new BudgetKill(2.5, 2.67);
    expect(err.exitCode).toBe(4);
    expect(err.budgetUsdCap).toBe(2.5);
    expect(err.budgetUsdUsed).toBe(2.67);
  });

  it("ToolEventUnknown includes raw snippet", () => {
    const err = new ToolEventUnknown("weird_type", '{"type":"weird_type","data":"abc"}');
    expect(err.exitCode).toBe(8);
    expect(err.eventType).toBe("weird_type");
    expect(err.rawSnippet).toContain("weird_type");
  });

  it("DirtyWorkTree has exit code 9", () => {
    const err = new DirtyWorkTree();
    expect(err.exitCode).toBe(9);
    expect(err.remediation).toContain("--allow-dirty");
  });

  it("ReviewDivergence includes step and cycle info", () => {
    const err = new ReviewDivergence("03", 2);
    expect(err.exitCode).toBe(6);
    expect(err.stepId).toBe("03");
    expect(err.cycleCount).toBe(2);
  });
});
