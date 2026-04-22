/**
 * Week 2 exit check: "budget kill demonstrable with --budget-usd 0.05"
 *
 * Tests that the session-rollup budget tracker kills the session
 * when cumulative cost across planner+implementer+reviewer exceeds the cap.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MockAdapter } from "../helpers/mock-adapter.js";
import { DEFAULT_POLICY, type Policy } from "../../src/models/policy.js";
import { BudgetKill } from "../../src/errors.js";

let testDir: string;
let dbPath: string;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

beforeEach(() => {
  testDir = join(tmpdir(), `polycode-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, "src"), { recursive: true });
  writeFileSync(join(testDir, "src", "index.ts"), '// initial\n');
  writeFileSync(join(testDir, ".gitignore"), '.poly/\n');
  execSync("git init && git add -A && git commit -m 'init'", { cwd: testDir, env: gitEnv });
  dbPath = join(testDir, ".poly", "trace.db");
  mkdirSync(join(testDir, ".poly"), { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("budget kill", () => {
  it("kills session when cumulative cost exceeds budget cap", async () => {
    // Budget is $0.05 but planner alone costs $0.03, implementer $0.03 → total $0.06 > $0.05
    const tinyBudgetPolicy: Policy = {
      ...DEFAULT_POLICY,
      budget_usd: 0.05,
    };

    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Test",
          steps: [
            { id: "01", intent: "Step 1", touches_paths: ["src/index.ts"], verification: "true" },
            { id: "02", intent: "Step 2", touches_paths: ["src/index.ts"], verification: "true" },
          ],
          assumptions: [],
          out_of_scope: [],
        }),
        costUsd: 0.03,
      },
      implementer: {
        textOutput: "Done",
        costUsd: 0.03,
        sideEffect: () => {
          writeFileSync(join(testDir, "src", "index.ts"), '// changed\n');
        },
      },
      reviewer: {
        textOutput: JSON.stringify({
          step_id: "01",
          verdict: "approve",
          findings: [],
          tests_suggested: [],
          overall_notes: "OK",
        }),
        costUsd: 0.02,
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      // The BudgetKill should be thrown after step 1 completes
      // planner ($0.03) + implementer ($0.03) + reviewer ($0.02) = $0.08 > $0.05
      await expect(
        orchestrator.run({
          task: "Test",
          mode: "plan-implement-review",
          policy: tinyBudgetPolicy,
        })
      ).rejects.toThrow(BudgetKill);

      // Verify the session was marked with budget_kill outcome
      const sessions = orchestrator.getStore().listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].outcome).toBe("budget_kill");
      expect(sessions[0].budget_usd_used).toBeGreaterThan(0.05);
    } finally {
      orchestrator.close();
    }
  });

  it("succeeds when cost stays under budget", async () => {
    const generousBudgetPolicy: Policy = {
      ...DEFAULT_POLICY,
      budget_usd: 10.0,
    };

    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "T",
          steps: [{ id: "01", intent: "S", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
        costUsd: 0.01,
      },
      implementer: {
        textOutput: "Done",
        costUsd: 0.01,
        sideEffect: () => {
          writeFileSync(join(testDir, "src", "index.ts"), '// ok\n');
        },
      },
      reviewer: {
        textOutput: JSON.stringify({
          step_id: "01", verdict: "approve", findings: [], tests_suggested: [], overall_notes: "OK",
        }),
        costUsd: 0.01,
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { exitCode } = await orchestrator.run({
        task: "T",
        mode: "plan-implement-review",
        policy: generousBudgetPolicy,
      });
      expect(exitCode).toBe(0);
    } finally {
      orchestrator.close();
    }
  });
});
