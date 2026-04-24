/**
 * v0.5: Test that the orchestrator correctly uses separate adapters
 * for implementer and reviewer roles.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MockAdapter } from "../helpers/mock-adapter.js";
import { DEFAULT_POLICY } from "../../src/models/policy.js";

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
  testDir = join(tmpdir(), `polycode-xprov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("cross-provider review", () => {
  it("uses separate adapters for implementer and reviewer", async () => {
    const implAdapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "Test",
          steps: [{ id: "01", intent: "Change file", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
      implementer: {
        textOutput: "Done",
        sideEffect: () => {
          writeFileSync(join(testDir, "src", "index.ts"), '// changed\n');
        },
      },
    });

    const reviewAdapter = new MockAdapter({
      reviewer: {
        textOutput: JSON.stringify({
          step_id: "01",
          verdict: "approve",
          findings: [],
          tests_suggested: [],
          overall_notes: "Looks good from the other provider.",
        }),
      },
    });

    const orchestrator = new Orchestrator({
      dbPath,
      adapter: implAdapter,
      reviewerAdapter: reviewAdapter,
      workDir: testDir,
    });

    try {
      const { exitCode } = await orchestrator.run({
        task: "Test",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(0);

      // Verify implementer adapter was called for planner + implementer
      expect(implAdapter.calls).toHaveLength(2);
      expect(implAdapter.calls[0].role).toBe("planner");
      expect(implAdapter.calls[1].role).toBe("implementer");

      // Verify reviewer adapter was called for reviewer only
      expect(reviewAdapter.calls).toHaveLength(1);
      expect(reviewAdapter.calls[0].role).toBe("reviewer");
      expect(reviewAdapter.calls[0].bare).toBe(true);

      // Verify trace records correct provider IDs
      const store = orchestrator.getStore();
      const turns = store.getTurnsForSession(
        store.listSessions()[0].id
      );
      expect(turns[0].provider).toBe("mock"); // planner
      expect(turns[1].provider).toBe("mock"); // implementer
      expect(turns[2].provider).toBe("mock"); // reviewer — same mock ID but separate instance
    } finally {
      orchestrator.close();
    }
  });
});
