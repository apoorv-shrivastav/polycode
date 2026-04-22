#!/usr/bin/env node

import cac from "cac";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PolicySchema, DEFAULT_POLICY, type Policy } from "../models/policy.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { TraceStore } from "../trace/store.js";
import { PolycodeError } from "../errors.js";
import { logger } from "../logger.js";
import type { SessionMode } from "../models/events.js";

const DEFAULT_DB_PATH = resolve(process.cwd(), ".poly", "trace.db");

function loadPolicy(policyPath?: string, budgetOverride?: number): Policy {
  let policy = { ...DEFAULT_POLICY };
  if (policyPath) {
    const raw = readFileSync(resolve(policyPath), "utf-8");
    const parsed = PolicySchema.parse(JSON.parse(raw));
    policy = parsed;
  }
  if (budgetOverride !== undefined) {
    policy = { ...policy, budget_usd: budgetOverride };
  }
  return policy;
}

const cli = cac("polycode");

// --- polycode run ---
cli
  .command("run <task>", "Run plan→implement→review on a task")
  .option("--mode <mode>", "Execution mode: pir, plan, review", { default: "pir" })
  .option("--policy <file>", "Path to a policy JSON file")
  .option("--budget-usd <n>", "Override policy budget")
  .option("--reviewer-provider <provider>", "Reviewer provider: same, different", { default: "same" })
  .option("--model <id>", "Override default model")
  .option("--session <id>", "Resume an existing session")
  .option("--dry-run", "Print what would happen without spawning CLIs")
  .option("--allow-dirty", "Proceed with uncommitted git changes")
  .option("--enable-bash", "Enable Bash tool for implementer (requires policy.bash_enabled)")
  .option("--interactive", "Enable end-of-session user-accept prompt")
  .action(async (task: string, options: Record<string, unknown>) => {
    const policy = loadPolicy(
      options.policy as string | undefined,
      options.budgetUsd ? parseFloat(options.budgetUsd as string) : undefined
    );

    const modeMap: Record<string, SessionMode> = {
      pir: "plan-implement-review",
      plan: "plan-only",
      review: "review-only",
    };
    const mode = modeMap[options.mode as string] ?? "plan-implement-review";

    const orchestrator = new Orchestrator({ dbPath: DEFAULT_DB_PATH });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task,
        mode,
        policy,
        model: options.model as string | undefined,
        sessionId: options.session as string | undefined,
        dryRun: !!options.dryRun,
        allowDirty: !!options.allowDirty,
        enableBash: !!options.enableBash,
        interactive: !!options.interactive,
      });
      logger.info({ sessionId }, "Session complete");
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    } finally {
      orchestrator.close();
    }
  });

// --- polycode plan ---
cli
  .command("plan <task>", "Run planner only, emit plan.json")
  .option("--policy <file>", "Path to a policy JSON file")
  .option("--budget-usd <n>", "Override policy budget")
  .option("--model <id>", "Override default model")
  .option("--dry-run", "Print what would happen without spawning CLIs")
  .option("--allow-dirty", "Proceed with uncommitted git changes")
  .action(async (task: string, options: Record<string, unknown>) => {
    const policy = loadPolicy(
      options.policy as string | undefined,
      options.budgetUsd ? parseFloat(options.budgetUsd as string) : undefined
    );

    const orchestrator = new Orchestrator({ dbPath: DEFAULT_DB_PATH });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task,
        mode: "plan-only",
        policy,
        model: options.model as string | undefined,
        dryRun: !!options.dryRun,
        allowDirty: !!options.allowDirty,
      });
      logger.info({ sessionId }, "Plan session complete");
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    } finally {
      orchestrator.close();
    }
  });

// --- polycode review ---
cli
  .command("review <diff-ref>", "Run reviewer only on a diff ref")
  .option("--policy <file>", "Path to a policy JSON file")
  .option("--budget-usd <n>", "Override policy budget")
  .option("--model <id>", "Override default model")
  .option("--allow-dirty", "Proceed with uncommitted git changes")
  .action(async (diffRef: string, options: Record<string, unknown>) => {
    const policy = loadPolicy(
      options.policy as string | undefined,
      options.budgetUsd ? parseFloat(options.budgetUsd as string) : undefined
    );

    const orchestrator = new Orchestrator({ dbPath: DEFAULT_DB_PATH });
    try {
      const { sessionId, exitCode } = await orchestrator.run({
        task: diffRef,
        mode: "review-only",
        policy,
        model: options.model as string | undefined,
        allowDirty: !!options.allowDirty,
      });
      logger.info({ sessionId }, "Review session complete");
      process.exit(exitCode);
    } catch (err) {
      handleError(err);
    } finally {
      orchestrator.close();
    }
  });

// --- polycode trace ---
cli
  .command("trace <session-id>", "Pretty-print a session's trace")
  .option("--format <format>", "Output format: pretty, jsonl", { default: "pretty" })
  .action((sessionId: string, options: Record<string, unknown>) => {
    const store = new TraceStore(DEFAULT_DB_PATH);
    try {
      const session = store.getSession(sessionId);
      if (!session) {
        process.stderr.write(`[polycode] Session not found: ${sessionId}\n`);
        process.exit(1);
      }

      const turns = store.getTurnsForSession(sessionId);
      const outcome = store.getOutcome(sessionId);

      if (options.format === "jsonl") {
        process.stdout.write(JSON.stringify(session) + "\n");
        for (const turn of turns) {
          process.stdout.write(JSON.stringify(turn) + "\n");
          const events = store.getToolEventsForTurn(turn.id);
          for (const evt of events) {
            process.stdout.write(JSON.stringify(evt) + "\n");
          }
        }
        if (outcome) process.stdout.write(JSON.stringify(outcome) + "\n");
      } else {
        printPrettyTrace(session, turns, store, outcome);
      }
    } finally {
      store.close();
    }
  });

// --- polycode replay ---
cli
  .command("replay <session-id>", "Re-run a session from its stored plan/policy")
  .option("--budget-usd <n>", "Override budget for replay")
  .option("--allow-dirty", "Proceed with uncommitted git changes")
  .action(async (sessionId: string, options: Record<string, unknown>) => {
    const store = new TraceStore(DEFAULT_DB_PATH);
    try {
      const session = store.getSession(sessionId);
      if (!session) {
        process.stderr.write(`[polycode] Session not found: ${sessionId}\n`);
        process.exit(1);
      }

      const policy = PolicySchema.parse(JSON.parse(session.policy_json));
      if (options.budgetUsd) {
        policy.budget_usd = parseFloat(options.budgetUsd as string);
      }

      store.close();
      const orchestrator = new Orchestrator({ dbPath: DEFAULT_DB_PATH });
      try {
        const result = await orchestrator.run({
          task: session.task,
          mode: session.mode as SessionMode,
          policy,
          allowDirty: !!options.allowDirty,
        });
        logger.info({ sessionId: result.sessionId }, "Replay session complete");
        process.exit(result.exitCode);
      } catch (err) {
        handleError(err);
      } finally {
        orchestrator.close();
      }
    } catch (err) {
      store.close();
      handleError(err);
    }
  });

// --- polycode eval ---
cli
  .command("eval <corpus-dir>", "Run the §9 2×2 eval on a defect corpus")
  .option("--conditions <conditions>", "Conditions to run: A,B,C,D", { default: "A,B,C" })
  .option("--output <file>", "Output CSV path", { default: "results.csv" })
  .option("--max-cost-usd <n>", "Hard cost ceiling", { default: "1500" })
  .action(async (_corpusDir: string, _options: Record<string, unknown>) => {
    process.stderr.write("[polycode] Eval harness not yet implemented (Week 4).\n");
    process.exit(1);
  });

// Version and help
cli.version("0.2.0");
cli.help();

// Parse and run
cli.parse();

// --- Error handler ---

function handleError(err: unknown): never {
  if (err instanceof PolycodeError) {
    process.stderr.write(`\n[polycode] ERROR (${err.code}): ${err.message}\n`);
    process.stderr.write(`  ${err.remediation}\n\n`);
    process.exit(err.exitCode);
  }
  if (err instanceof Error) {
    logger.error({ err }, "Unexpected error");
    process.stderr.write(`\n[polycode] UNEXPECTED ERROR: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`\n[polycode] UNKNOWN ERROR: ${String(err)}\n`);
  process.exit(1);
}

// --- Pretty-print helpers ---

function printPrettyTrace(
  session: {
    id: string; task: string; created_at: number; closed_at: number | null;
    mode: string; budget_usd_cap: number; budget_usd_used: number;
    outcome: string | null; cc_version: string;
  },
  turns: Array<{
    id: string; role: string; ordinal: number; step_id: string | null;
    review_cycle: number; provider: string; model: string;
    cost_usd: number | null; input_tokens: number | null;
    output_tokens: number | null; exit_reason: string | null;
    is_error: number | null;
  }>,
  store: TraceStore,
  outcome: {
    tests_passed: number | null; user_accept: number | null;
    defects_caught: number | null; notes: string | null;
  } | undefined
): void {
  const w = (s: string) => process.stdout.write(s + "\n");
  w("=".repeat(60));
  w(`Session:    ${session.id}`);
  w(`Task:       ${session.task}`);
  w(`Mode:       ${session.mode}`);
  w(`Budget:     $${session.budget_usd_used.toFixed(4)} / $${session.budget_usd_cap.toFixed(2)}`);
  w(`Outcome:    ${session.outcome ?? "in-progress"}`);
  w(`CC Version: ${session.cc_version}`);
  w(`Created:    ${new Date(session.created_at).toISOString()}`);
  if (session.closed_at) {
    w(`Closed:     ${new Date(session.closed_at).toISOString()}`);
  }
  w("-".repeat(60));

  for (const turn of turns) {
    const step = turn.step_id ? ` step=${turn.step_id}` : "";
    const cycle = turn.review_cycle > 0 ? ` cycle=${turn.review_cycle}` : "";
    w(`\n  Turn ${turn.ordinal} [${turn.role}]${step}${cycle} via ${turn.provider} (${turn.model})`);
    w(
      `    Cost: $${(turn.cost_usd ?? 0).toFixed(4)}  |  Tokens: ${turn.input_tokens ?? 0} in / ${turn.output_tokens ?? 0} out  |  Exit: ${turn.exit_reason ?? "?"}`
    );

    const events = store.getToolEventsForTurn(turn.id);
    if (events.length > 0) {
      w(`    Tools (${events.length}):`);
      for (const evt of events) {
        const scope = evt.in_scope ? "ok" : "OUT-OF-SCOPE";
        const path = evt.path ? ` -> ${evt.path}` : "";
        w(`      [${scope}] ${evt.tool_name}${path}`);
      }
    }
  }

  if (outcome) {
    w("\n" + "-".repeat(60));
    w("Outcome:");
    if (outcome.tests_passed !== null) w(`  Tests: ${outcome.tests_passed ? "PASSED" : "FAILED"}`);
    if (outcome.defects_caught !== null) w(`  Defects caught: ${outcome.defects_caught}`);
    if (outcome.notes) w(`  Notes: ${outcome.notes}`);
  }

  w("\n" + "=".repeat(60));
}
