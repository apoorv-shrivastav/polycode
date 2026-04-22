/**
 * Week 2 exit check: "git must be clean to start" and
 * "path-traversal attack in a crafted plan is blocked"
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { Orchestrator } from "../../src/orchestrator/orchestrator.js";
import { MockAdapter } from "../helpers/mock-adapter.js";
import { DEFAULT_POLICY } from "../../src/models/policy.js";
import { DirtyWorkTree } from "../../src/errors.js";

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
  testDir = join(tmpdir(), `polycode-pre-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("clean-git precondition", () => {
  it("blocks when git is dirty", async () => {
    // Make the working tree dirty
    writeFileSync(join(testDir, "src", "index.ts"), '// dirty\n');

    const adapter = new MockAdapter({
      planner: { textOutput: "{}" },
    });
    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });

    try {
      await expect(
        orchestrator.run({
          task: "test",
          mode: "plan-only",
          policy: DEFAULT_POLICY,
          // allowDirty NOT set
        })
      ).rejects.toThrow(DirtyWorkTree);
    } finally {
      orchestrator.close();
    }
  });

  it("proceeds with --allow-dirty", async () => {
    writeFileSync(join(testDir, "src", "index.ts"), '// dirty\n');

    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "test",
          steps: [{ id: "01", intent: "x", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
    });
    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });

    try {
      const { exitCode } = await orchestrator.run({
        task: "test",
        mode: "plan-only",
        policy: DEFAULT_POLICY,
        allowDirty: true,
      });
      expect(exitCode).toBe(0);
    } finally {
      orchestrator.close();
    }
  });

  it("succeeds when git is clean", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "test",
          steps: [{ id: "01", intent: "x", touches_paths: ["src/index.ts"], verification: "true" }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
    });
    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });

    try {
      const { exitCode } = await orchestrator.run({
        task: "test",
        mode: "plan-only",
        policy: DEFAULT_POLICY,
      });
      expect(exitCode).toBe(0);
    } finally {
      orchestrator.close();
    }
  });
});

describe("path-traversal blocking in plans", () => {
  it("rejects a plan with parent-traversal paths", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "evil",
          steps: [{
            id: "01",
            intent: "Steal secrets",
            touches_paths: ["../../../etc/passwd"],
            verification: "true",
          }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: "evil",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });

      expect(exitCode).toBe(1); // plan_invalid
      const session = orchestrator.getStore().getSession(sessionId);
      expect(session!.outcome).toBe("plan_invalid");
    } finally {
      orchestrator.close();
    }
  });

  it("rejects a plan with absolute paths", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "evil",
          steps: [{
            id: "01",
            intent: "Access system file",
            touches_paths: ["/etc/shadow"],
            verification: "true",
          }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { exitCode } = await orchestrator.run({
        task: "evil",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });
      expect(exitCode).toBe(1); // plan_invalid
    } finally {
      orchestrator.close();
    }
  });

  it("rejects a plan with paths outside allowed_paths", async () => {
    const adapter = new MockAdapter({
      planner: {
        textOutput: JSON.stringify({
          task: "out of bounds",
          steps: [{
            id: "01",
            intent: "Edit config",
            touches_paths: ["config/production.yaml"],
            verification: "true",
          }],
          assumptions: [],
          out_of_scope: [],
        }),
      },
    });

    const orchestrator = new Orchestrator({ dbPath, adapter, workDir: testDir });
    try {
      const { exitCode } = await orchestrator.run({
        task: "out of bounds",
        mode: "plan-implement-review",
        policy: DEFAULT_POLICY,
      });
      expect(exitCode).toBe(1);
    } finally {
      orchestrator.close();
    }
  });
});
