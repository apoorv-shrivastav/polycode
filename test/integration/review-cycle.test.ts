/**
 * Tests the §7.4 review cycle semantics:
 * - request_changes triggers a new implementer pass with findings
 * - approve after retry works
 * - max_review_cycles_per_step triggers ReviewDivergence
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MockAdapter } from "../helpers/mock-adapter.js";
import { DEFAULT_POLICY, type Policy } from "../../src/models/policy.js";
import { ReviewDivergence } from "../../src/errors.js";

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
  testDir = join(tmpdir(), `polycode-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("review cycles", () => {
  it("request_changes → implementer retry → approve succeeds", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Fix bug",
          steps: [{ id: "01", intent: "Fix null check", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
      implementer: [
        {
          // First attempt: incomplete fix
          textOutput: "First attempt",
          sideEffect: () => {
            writeFileSync(join(testDir, "src", "index.ts"), '// partial fix\n');
          },
        },
        {
          // Second attempt after review feedback: complete fix
          textOutput: "Fixed with review feedback",
          sideEffect: () => {
            writeFileSync(join(testDir, "src", "index.ts"), '// complete fix with null check\n');
          },
        },
      ],
      reviewer: [
        {
          // First review: request changes
          textOutput: JSON.stringify({
            step_id: "01",
            verdict: "request_changes",
            findings: [{
              severity: "high",
              path: "src/index.ts",
              line: 1,
              issue: "Missing null check on input parameter",
              suggestion: "Add if (!input) return null;",
            }],
            tests_suggested: ["test null input"],
            overall_notes: "Need null safety.",
          }),
        },
        {
          // Second review: approve
          textOutput: JSON.stringify({
            step_id: "01",
            verdict: "approve",
            findings: [],
            tests_suggested: [],
            overall_notes: "Null check added correctly.",
          }),
        },
      ],
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: "Fix bug",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(0);

      // Check turns: planner + impl(0) + review(0) + impl(1) + review(1) = 5
      const turns = orchestrator.getStore().getTurnsForSession(sessionId);
      expect(turns).toHaveLength(5);

      // Verify review cycles are tracked
      expect(turns[1].review_cycle).toBe(0); // first implementer
      expect(turns[2].review_cycle).toBe(0); // first reviewer
      expect(turns[3].review_cycle).toBe(1); // second implementer (retry)
      expect(turns[4].review_cycle).toBe(1); // second reviewer

      // Verify implementer retry got the findings in its prompt
      expect(adapter.calls[3].role).toBe("implementer");
      expect(adapter.calls[3].prompt).toContain("REVIEWER FINDINGS");
      expect(adapter.calls[3].prompt).toContain("Missing null check");

      // Verify reviewer calls are always bare (independent)
      expect(adapter.calls[2].bare).toBe(true);
      expect(adapter.calls[4].bare).toBe(true);

    } finally {
      orchestrator.close();
    }
  });

  it("ReviewDivergence when max cycles exceeded", async () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      max_review_cycles_per_step: 2,
    };

    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Diverge",
          steps: [{ id: "01", intent: "Do thing", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
      implementer: [
        {
          textOutput: "Attempt 1",
          sideEffect: () => writeFileSync(join(testDir, "src", "index.ts"), '// attempt 1\n'),
        },
        {
          textOutput: "Attempt 2",
          sideEffect: () => writeFileSync(join(testDir, "src", "index.ts"), '// attempt 2\n'),
        },
      ],
      reviewer: [
        {
          textOutput: JSON.stringify({
            step_id: "01",
            verdict: "request_changes",
            findings: [{ severity: "med", path: "src/index.ts", issue: "Not good enough" }],
            tests_suggested: [],
            overall_notes: "Try again.",
          }),
        },
        {
          // Keep requesting changes — should hit the cap
          textOutput: JSON.stringify({
            step_id: "01",
            verdict: "request_changes",
            findings: [{ severity: "med", path: "src/index.ts", issue: "Still not good" }],
            tests_suggested: [],
            overall_notes: "Nope.",
          }),
        },
      ],
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      await expect(
        orchestrator.run({
          task: "Diverge",
          mode: "plan-implement-review",
          policy,
        })
      ).rejects.toThrow(ReviewDivergence);

      // Session should be marked as review_divergence
      const sessions = orchestrator.getStore().listSessions();
      expect(sessions[0].outcome).toBe("review_divergence");
    } finally {
      orchestrator.close();
    }
  });
});
