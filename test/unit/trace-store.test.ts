import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceStore } from "../../src/trace/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

let store: TraceStore;
let dbPath: string;

const minimalPolicy = {
  version: 1 as const,
  allowed_paths: ["src/**"],
  denied_paths: [],
  allowed_tools_by_role: {
    planner: ["Read"],
    implementer: ["Read", "Edit"],
    reviewer: ["Read"],
  },
  bash_enabled: false,
  allowed_bash_prefixes: [],
  network: { mode: "deny" as const },
  network_allow: [],
  budget_usd: 2.5,
  wall_clock_seconds: 1800,
  max_turns_per_invocation: 40,
  max_review_cycles_per_step: 2,
  reviewer_provider: "same" as const,
};

beforeEach(() => {
  dbPath = join(tmpdir(), `polycode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  store = new TraceStore(dbPath);
});

afterEach(() => {
  store.close();
  try { unlinkSync(dbPath); } catch { /* ok */ }
});

describe("TraceStore", () => {
  describe("sessions", () => {
    it("creates and retrieves a session with cc_version", () => {
      const id = store.createSession({
        task: "test task",
        mode: "plan-implement-review",
        policy: minimalPolicy,
        budgetUsdCap: 2.5,
        ccVersion: "2.1.117 (Claude Code)",
      });

      const session = store.getSession(id);
      expect(session).toBeDefined();
      expect(session!.task).toBe("test task");
      expect(session!.mode).toBe("plan-implement-review");
      expect(session!.budget_usd_cap).toBe(2.5);
      expect(session!.budget_usd_used).toBe(0);
      expect(session!.outcome).toBeNull();
      expect(session!.cc_version).toBe("2.1.117 (Claude Code)");
    });

    it("closes a session with outcome", () => {
      const id = store.createSession({
        task: "t", mode: "plan-only", policy: minimalPolicy,
        budgetUsdCap: 1, ccVersion: "test",
      });
      store.closeSession(id, "completed");
      const session = store.getSession(id);
      expect(session!.outcome).toBe("completed");
      expect(session!.closed_at).toBeGreaterThan(0);
    });

    it("supports new v0.2 outcomes", () => {
      for (const outcome of [
        "plan_invalid", "step_rejected", "review_divergence",
        "budget_kill", "policy_violation", "paused",
      ] as const) {
        const id = store.createSession({
          task: "t", mode: "plan-only", policy: minimalPolicy,
          budgetUsdCap: 1, ccVersion: "test",
        });
        store.closeSession(id, outcome);
        expect(store.getSession(id)!.outcome).toBe(outcome);
      }
    });

    it("updates budget", () => {
      const id = store.createSession({
        task: "t", mode: "plan-only", policy: minimalPolicy,
        budgetUsdCap: 5, ccVersion: "test",
      });
      store.updateSessionBudget(id, 1.23);
      expect(store.getSession(id)!.budget_usd_used).toBe(1.23);
    });

    it("lists sessions in reverse chronological order", () => {
      for (let i = 0; i < 3; i++) {
        store.createSession({
          task: `task-${i}`, mode: "plan-only", policy: minimalPolicy,
          budgetUsdCap: 1, ccVersion: "test",
        });
      }
      const sessions = store.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions[0].created_at).toBeGreaterThanOrEqual(sessions[1].created_at);
    });
  });

  describe("turns", () => {
    it("creates turn with step_id and review_cycle", () => {
      const sessId = store.createSession({
        task: "t", mode: "plan-only", policy: minimalPolicy,
        budgetUsdCap: 1, ccVersion: "test",
      });

      const turnId = store.createTurn({
        sessionId: sessId,
        role: "implementer",
        ordinal: 0,
        stepId: "01",
        reviewCycle: 1,
        provider: "claude-code",
        model: "claude-sonnet-4-5",
      });

      store.completeTurn(turnId, {
        providerSession: "cc-sess-1",
        inputTokens: 100, outputTokens: 50,
        cacheReadTokens: 200, cacheWriteTokens: 300,
        costUsd: 0.05, numTurns: 3,
        isError: false, exitReason: "ok",
        rawResultJson: '{"test": true}',
      });

      const turns = store.getTurnsForSession(sessId);
      expect(turns).toHaveLength(1);
      expect(turns[0].step_id).toBe("01");
      expect(turns[0].review_cycle).toBe(1);
      expect(turns[0].cost_usd).toBe(0.05);
      expect(turns[0].exit_reason).toBe("ok");
    });
  });

  describe("tool events", () => {
    it("records and retrieves tool events with scope", () => {
      const sessId = store.createSession({
        task: "t", mode: "plan-only", policy: minimalPolicy,
        budgetUsdCap: 1, ccVersion: "test",
      });
      const turnId = store.createTurn({
        sessionId: sessId, role: "implementer", ordinal: 0,
        provider: "claude-code", model: "test",
      });

      store.recordToolEvent(turnId, {
        toolName: "Write",
        argsJson: '{"file_path":"src/hello.ts"}',
        resultSummary: "File created",
        path: "src/hello.ts",
      }, true);

      store.recordToolEvent(turnId, {
        toolName: "Write",
        argsJson: '{"file_path":".env"}',
        resultSummary: "File created",
        path: ".env",
      }, false);

      const events = store.getToolEventsForTurn(turnId);
      expect(events).toHaveLength(2);
      expect(events[0].in_scope).toBe(1);
      expect(events[1].in_scope).toBe(0);
    });
  });

  describe("outcomes", () => {
    it("records and retrieves outcomes", () => {
      const sessId = store.createSession({
        task: "t", mode: "plan-only", policy: minimalPolicy,
        budgetUsdCap: 1, ccVersion: "test",
      });

      store.recordOutcome({
        sessionId: sessId,
        testsPassed: true,
        defectsCaught: 3,
        falsePositives: 1,
        notes: "Good run",
      });

      const outcome = store.getOutcome(sessId);
      expect(outcome).toBeDefined();
      expect(outcome!.tests_passed).toBe(1);
      expect(outcome!.defects_caught).toBe(3);
    });
  });
});
