/**
 * Week 2 exit check: "end-to-end run on a 2-step plan completes"
 *
 * Uses MockAdapter to test the full plan→implement→review pipeline
 * without spending tokens. Verifies:
 * - Planner produces a 2-step plan
 * - Implementer executes each step (with file changes)
 * - Reviewer approves each step
 * - Git commits are made for each step
 * - Session closes with outcome "completed"
 * - Trace DB is fully populated
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MockAdapter } from "../helpers/mock-adapter.js";
import { DEFAULT_POLICY } from "../../src/models/policy.js";
import { TraceStore } from "../../src/trace/store.js";

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `polycode-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(testDir, "src"), { recursive: true });
  writeFileSync(join(testDir, "src", "index.ts"), '// initial\n');
  writeFileSync(join(testDir, "package.json"), '{"name":"test"}\n');
  writeFileSync(join(testDir, ".gitignore"), '.poly/\n');

  // Initialize git with clean state
  execSync("git init && git add -A && git commit -m 'init'", {
    cwd: testDir,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" },
  });

  dbPath = join(testDir, ".poly", "trace.db");
  mkdirSync(join(testDir, ".poly"), { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

const gitEnv = { GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test.com" };

describe("end-to-end 2-step plan", () => {
  it("completes a full PIR pipeline with 2 steps", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Add greeting module",
          steps: [
            {
              id: "01",
              intent: "Create greeting function in src/greet.ts",
              touches_paths: ["src/greet.ts"],
              verification: "true",
            },
            {
              id: "02",
              intent: "Update src/index.ts to export greeting",
              touches_paths: ["src/index.ts"],
              verification: "true",
            },
          ],
          assumptions: ["src/ exists"],
          out_of_scope: [],
        }),
        costUsd: 0.05,
        toolEvents: [
          { toolName: "Read", path: "src/index.ts" },
          { toolName: "Glob", path: "src/" },
        ],
      },
      implementer: [
        {
          // Step 01: create greet.ts
          textOutput: "Created src/greet.ts",
          costUsd: 0.10,
          sideEffect: () => {
            writeFileSync(join(testDir, "src", "greet.ts"), 'export function greet() { return "hello"; }\n');
          },
          toolEvents: [
            { toolName: "Write", path: "src/greet.ts" },
          ],
        },
        {
          // Step 02: update index.ts
          textOutput: "Updated src/index.ts",
          costUsd: 0.10,
          sideEffect: () => {
            writeFileSync(join(testDir, "src", "index.ts"), 'export { greet } from "./greet.js";\n');
          },
          toolEvents: [
            { toolName: "Edit", path: "src/index.ts" },
          ],
        },
      ],
      reviewer: [
        {
          // Review step 01: approve
          textOutput: JSON.stringify({
            step_id: "01",
            verdict: "approve",
            findings: [],
            tests_suggested: [],
            overall_notes: "Clean implementation.",
          }),
          costUsd: 0.05,
        },
        {
          // Review step 02: approve
          textOutput: JSON.stringify({
            step_id: "02",
            verdict: "approve",
            findings: [],
            tests_suggested: [],
            overall_notes: "Good re-export.",
          }),
          costUsd: 0.05,
        },
      ],
    });

    const orchestrator = new Orchestrator({
      dbPath,
      adapter,
      workDir: testDir,
    });

    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: "Add greeting module",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
        allowDirty: false,
      });

      // --- Assertions ---

      // 1. Exit code is 0 (success)
      expect(exitCode).toBe(0);

      // 2. Session exists and is closed with "completed"
      const store = orchestrator.getStore();
      const session = store.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session!.outcome).toBe("completed");
      expect(session!.closed_at).toBeGreaterThan(0);

      // 3. Budget was tracked across all turns
      expect(session!.budget_usd_used).toBeCloseTo(0.35, 2); // 0.05+0.10+0.05+0.10+0.05

      // 4. All turns recorded (1 planner + 2 implementer + 2 reviewer = 5)
      const turns = store.getTurnsForSession(sessionId);
      expect(turns).toHaveLength(5);
      expect(turns[0].role).toBe("planner");
      expect(turns[1].role).toBe("implementer");
      expect(turns[1].step_id).toBe("01");
      expect(turns[2].role).toBe("reviewer");
      expect(turns[2].step_id).toBe("01");
      expect(turns[3].role).toBe("implementer");
      expect(turns[3].step_id).toBe("02");
      expect(turns[4].role).toBe("reviewer");
      expect(turns[4].step_id).toBe("02");

      // 5. Tool events recorded
      const plannerEvents = store.getToolEventsForTurn(turns[0].id);
      expect(plannerEvents.length).toBeGreaterThanOrEqual(2);

      // 6. Files actually exist
      expect(existsSync(join(testDir, "src", "greet.ts"))).toBe(true);

      // 7. Git commits were made (init + 2 step commits)
      const gitLog = execSync("git log --oneline", { cwd: testDir, encoding: "utf-8" });
      const commits = gitLog.trim().split("\n");
      expect(commits.length).toBe(3); // init + step 01 + step 02
      expect(gitLog).toContain("polycode step 01");
      expect(gitLog).toContain("polycode step 02");

      // 8. Plan was persisted
      expect(existsSync(join(testDir, ".poly", "plans", `${sessionId}.json`))).toBe(true);

      // 9. Adapter calls were correct
      expect(adapter.calls).toHaveLength(5);
      expect(adapter.calls[0].role).toBe("planner");
      expect(adapter.calls[1].role).toBe("implementer");
      expect(adapter.calls[2].role).toBe("reviewer");
      expect(adapter.calls[2].bare).toBe(true); // reviewer MUST be bare
      expect(adapter.calls[3].role).toBe("implementer");
      expect(adapter.calls[4].role).toBe("reviewer");
      expect(adapter.calls[4].bare).toBe(true);

    } finally {
      orchestrator.close();
    }
  });

  it("handles plan-only mode correctly", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Test plan",
          steps: [{ id: "01", intent: "Do something", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
        costUsd: 0.03,
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: "Test plan",
        mode: "plan-only",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(0);
      const session = orchestrator.getStore().getSession(sessionId);
      expect(session!.outcome).toBe("completed");

      // Only one turn (planner)
      const turns = orchestrator.getStore().getTurnsForSession(sessionId);
      expect(turns).toHaveLength(1);
      expect(turns[0].role).toBe("planner");
    } finally {
      orchestrator.close();
    }
  });

  it("aborts when implementer fails", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Fail test",
          steps: [{ id: "01", intent: "Fail", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
      implementer: {
        textOutput: "",
        isError: true,
        exitReason: "cli_error",
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { exitCode } = await orchestrator.run({
        task: "Fail test",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(2); // implementer failure
    } finally {
      orchestrator.close();
    }
  });

  it("aborts when reviewer rejects", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Reject test",
          steps: [{ id: "01", intent: "Bad change", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
      implementer: {
        textOutput: "Done",
        sideEffect: () => {
          writeFileSync(join(testDir, "src", "index.ts"), '// bad change\n');
        },
      },
      reviewer: {
        textOutput: JSON.stringify({
          step_id: "01",
          verdict: "reject",
          findings: [{ severity: "high", path: "src/index.ts", issue: "Fundamentally wrong" }],
          tests_suggested: [],
          overall_notes: "This approach is wrong.",
        }),
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: "Reject test",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(5); // step_rejected

      const session = orchestrator.getStore().getSession(sessionId);
      expect(session!.outcome).toBe("step_rejected");

      // File should be reverted to original
      const content = execSync("cat src/index.ts", { cwd: testDir, encoding: "utf-8" });
      expect(content).toBe("// initial\n");
    } finally {
      orchestrator.close();
    }
  });
});
