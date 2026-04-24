import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { TraceStore } from "../trace/store.js";
import { ClaudeCodeAdapter } from "../providers/claude-code.js";
import {
  isPathInAllowlist,
  isBashCommandAllowed,
  WRAPPER_MODE_GAPS,
  validatePlan,
  validateDiffPaths,
  extractDiffPaths,
} from "../policy/index.js";
import { PlanSchema, type Plan, type PlanStep } from "../models/plan.js";
import { ReviewArtifactSchema, type ReviewArtifact } from "../models/review.js";
import type { Policy } from "../models/policy.js";
import type {
  SessionMode,
  SessionOutcome,
  Role,
  NormalizedTurn,
  NormalizedToolEvent,
} from "../models/events.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import { logger, printTurnSummary, printWrapperGaps } from "../logger.js";
import {
  DirtyWorkTree,
  BudgetKill,
  PolicyViolation,
  ReviewDivergence,
  MidSessionInterrupt,
} from "../errors.js";

export interface OrchestratorOptions {
  task: string;
  mode: SessionMode;
  policy: Policy;
  model?: string;
  sessionId?: string;
  dryRun?: boolean;
  allowDirty?: boolean;
  enableBash?: boolean;
  interactive?: boolean;
  dbPath?: string;
  workDir?: string;
}

export class Orchestrator {
  private store: TraceStore;
  private adapter: ProviderAdapter;
  private reviewerAdapter: ProviderAdapter;
  private workDir: string;
  private turnOrdinal = 0;

  constructor(opts: {
    dbPath: string;
    adapter?: ProviderAdapter;
    reviewerAdapter?: ProviderAdapter;
    workDir?: string;
  }) {
    this.store = new TraceStore(opts.dbPath);
    this.adapter = opts.adapter ?? new ClaudeCodeAdapter();
    this.reviewerAdapter = opts.reviewerAdapter ?? this.adapter;
    this.workDir = opts.workDir ?? process.cwd();
  }

  close(): void {
    this.store.close();
  }

  getStore(): TraceStore {
    return this.store;
  }

  async run(opts: OrchestratorOptions): Promise<{ sessionId: string; exitCode: number }> {
    // Print wrapper-mode gaps at session start per §8.1
    printWrapperGaps(WRAPPER_MODE_GAPS);

    if (opts.dryRun) {
      return this.dryRun(opts);
    }

    // §7.1 Preconditions
    await this.assertPreconditions(opts);

    // Check provider versions
    await this.adapter.checkVersion();
    if (this.reviewerAdapter !== this.adapter) {
      await this.reviewerAdapter.checkVersion();
    }

    const ccVersion = this.adapter.pinnedVersion;
    const sessionId = opts.sessionId ?? this.store.createSession({
      task: opts.task,
      mode: opts.mode,
      policy: opts.policy,
      budgetUsdCap: opts.policy.budget_usd,
      ccVersion,
    });

    try {
      switch (opts.mode) {
        case "plan-only":
          return await this.runPlanOnly(sessionId, opts);
        case "review-only":
          return await this.runReviewOnly(sessionId, opts);
        case "plan-implement-review":
          return await this.runPIR(sessionId, opts);
        default:
          throw new Error(`Unknown mode: ${opts.mode}`);
      }
    } catch (err) {
      if (err instanceof MidSessionInterrupt) {
        this.store.closeSession(sessionId, "paused");
        throw err; // let CLI handle the resume message
      }
      if (err instanceof BudgetKill) {
        this.store.closeSession(sessionId, "budget_kill");
        throw err;
      }
      if (err instanceof PolicyViolation) {
        this.store.closeSession(sessionId, "policy_violation");
        throw err;
      }
      if (err instanceof ReviewDivergence) {
        this.store.closeSession(sessionId, "review_divergence");
        throw err;
      }
      this.store.closeSession(sessionId, "error");
      throw err;
    }
  }

  // --- §7.1 Preconditions ---

  private async assertPreconditions(opts: OrchestratorOptions): Promise<void> {
    // Clean git check
    if (!opts.allowDirty) {
      try {
        const status = execSync("git status --porcelain", {
          encoding: "utf-8",
          cwd: this.workDir,
        }).trim();
        if (status.length > 0) {
          throw new DirtyWorkTree();
        }
      } catch (err) {
        if (err instanceof DirtyWorkTree) throw err;
        // Not a git repo — skip this check
        logger.warn("Not in a git repository; skipping clean-git check");
      }
    }

    // Disk space check (rule-of-thumb: 100 MB)
    // Best-effort; not all systems support this easily
    try {
      const df = execSync("df -k .", { encoding: "utf-8", cwd: this.workDir });
      const lines = df.split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availKb = parseInt(parts[3], 10);
        if (!isNaN(availKb) && availKb < 100 * 1024) {
          logger.warn({ availKb }, "Low disk space (<100MB). SQLite writes may fail.");
        }
      }
    } catch {
      // ignore — can't check, proceed
    }
  }

  // --- Plan Only ---

  private async runPlanOnly(
    sessionId: string,
    opts: OrchestratorOptions
  ): Promise<{ sessionId: string; exitCode: number }> {
    const plan = await this.runPlanner(sessionId, opts);
    if (!plan) {
      this.store.closeSession(sessionId, "plan_invalid");
      return { sessionId, exitCode: 1 };
    }
    this.persistPlan(sessionId, plan);
    this.store.closeSession(sessionId, "completed");
    return { sessionId, exitCode: 0 };
  }

  // --- Review Only ---

  private async runReviewOnly(
    sessionId: string,
    opts: OrchestratorOptions
  ): Promise<{ sessionId: string; exitCode: number }> {
    const diff = this.getDiff(opts.task);
    const review = await this.runReviewer(sessionId, diff, "01", "Review the provided diff", opts, 0);
    if (!review) {
      this.store.closeSession(sessionId, "error");
      return { sessionId, exitCode: 1 };
    }
    process.stdout.write(JSON.stringify(review, null, 2) + "\n");
    this.store.closeSession(sessionId, review.verdict === "reject" ? "rejected" : "completed");
    return { sessionId, exitCode: review.verdict === "reject" ? 1 : 0 };
  }

  // --- Full PIR per §7.2 ---

  private async runPIR(
    sessionId: string,
    opts: OrchestratorOptions
  ): Promise<{ sessionId: string; exitCode: number }> {
    // 1. PLAN
    logger.info("Phase 1: Planning");
    const plan = await this.runPlanner(sessionId, opts);
    if (!plan) {
      this.store.closeSession(sessionId, "plan_invalid");
      return { sessionId, exitCode: 1 };
    }

    // Validate plan paths with canonicalization per §7.5
    const validation = validatePlan(plan, opts.policy, this.workDir);
    if (!validation.ok) {
      logger.error(
        { reason: validation.reason, path: validation.path },
        "Plan validation failed"
      );
      this.store.closeSession(sessionId, "plan_invalid");
      return { sessionId, exitCode: 1 };
    }
    this.persistPlan(sessionId, plan);

    // 2. IMPLEMENT + REVIEW step by step, with bounded review cycles
    for (const step of plan.steps) {
      let cycle = 0;
      let reviewFindings: string | null = null;

      while (true) {
        logger.info(
          { stepId: step.id, cycle, intent: step.intent },
          `Phase 2: Implementing step ${step.id}`
        );

        // Take a git snapshot before implementation
        const snapshotRef = this.gitSnapshot();

        // Run implementer (with findings from previous cycle if any)
        const implResult = await this.runImplementer(
          sessionId, step, opts, cycle, reviewFindings
        );

        if (implResult.turn.exitReason !== "ok") {
          logger.error(
            { exitReason: implResult.turn.exitReason },
            "Implementer failed"
          );
          this.store.closeSession(sessionId, "aborted");
          return { sessionId, exitCode: 2 };
        }

        // Diff escape check with canonicalization per §7.5
        const diff = this.getDiffSince(snapshotRef);
        const diffValidation = validateDiffPaths(diff, opts.policy, this.workDir);
        if (!diffValidation.ok) {
          logger.error(
            { escapedPaths: diffValidation.escapedPaths },
            "POLICY VIOLATION: Diff modifies paths outside allowed_paths"
          );
          this.revertTo(snapshotRef);
          throw new PolicyViolation(
            "path_escape",
            `Escaped paths: ${diffValidation.escapedPaths.join(", ")}`
          );
        }

        // 3. REVIEW (fresh session, independent)
        logger.info({ stepId: step.id, cycle }, "Phase 3: Reviewing");
        const review = await this.runReviewer(
          sessionId, diff, step.id, step.intent, opts, cycle
        );

        if (!review) {
          logger.error("Reviewer produced no parseable review");
          this.store.closeSession(sessionId, "error");
          return { sessionId, exitCode: 1 };
        }

        switch (review.verdict) {
          case "approve":
            logger.info({ stepId: step.id }, "Step APPROVED");
            this.commitStep(step.id, step.intent);
            break;

          case "reject":
            logger.info(
              { stepId: step.id, notes: review.overall_notes },
              "Step REJECTED"
            );
            this.revertTo(snapshotRef);
            this.store.closeSession(sessionId, "step_rejected");
            return { sessionId, exitCode: 5 };

          case "request_changes":
            cycle++;
            logger.info(
              { stepId: step.id, cycle, findingsCount: review.findings.length },
              "CHANGES REQUESTED"
            );

            // §7 bounded review cycles
            if (cycle >= opts.policy.max_review_cycles_per_step) {
              logger.error(
                { stepId: step.id, maxCycles: opts.policy.max_review_cycles_per_step },
                "Review cycle cap reached — divergence"
              );
              this.revertTo(snapshotRef);
              throw new ReviewDivergence(step.id, cycle);
            }

            // §7.4 Prepare findings for next implementer cycle
            reviewFindings = review.findings
              .map((f) => `[${f.severity}] ${f.path}:${f.line ?? "?"} — ${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ""}`)
              .join("\n");

            // Revert before the next implementer attempt
            this.revertTo(snapshotRef);
            continue; // next cycle
        }

        break; // approved — move to next step
      }

      // Budget check after every step
      const session = this.store.getSession(sessionId);
      if (session && session.budget_usd_used >= session.budget_usd_cap) {
        throw new BudgetKill(session.budget_usd_cap, session.budget_usd_used);
      }
    }

    // 4. FINAL
    if (opts.interactive) {
      // In interactive mode we'd prompt — but v0 is non-interactive default
      this.store.closeSession(sessionId, "completed");
    } else {
      this.store.closeSession(sessionId, "completed");
    }
    return { sessionId, exitCode: 0 };
  }

  // --- Planner ---

  private async runPlanner(
    sessionId: string,
    opts: OrchestratorOptions
  ): Promise<Plan | null> {
    const turnId = this.store.createTurn({
      sessionId,
      role: "planner",
      ordinal: this.turnOrdinal++,
      provider: this.adapter.id,
      model: opts.model ?? "default",
    });

    const startedAt = Date.now();
    const result = await this.adapter.run({
      role: "planner",
      prompt: `Task: ${opts.task}\n\nAnalyze the codebase and produce a structured implementation plan as JSON.`,
      policy: opts.policy,
      model: opts.model,
      onTurn: (turn) => {
        this.store.completeTurn(turnId, {
          providerSession: turn.providerSession,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheWriteTokens: turn.cacheWriteTokens,
          costUsd: turn.costUsd,
          numTurns: turn.numTurns,
          isError: turn.isError,
          exitReason: turn.exitReason,
          rawResultJson: turn.rawResultJson,
        });
        this.updateSessionBudget(sessionId, turn.costUsd);
        printTurnSummary({
          role: "planner",
          model: turn.model,
          costUsd: turn.costUsd,
          durationMs: Date.now() - startedAt,
          exitReason: turn.exitReason,
        });
      },
      onToolEvent: (evt) => {
        this.store.recordToolEvent(
          turnId,
          evt,
          evt.path ? isPathInAllowlist(evt.path, opts.policy) : true
        );
      },
    });

    return this.parsePlan(result.textOutput);
  }

  // --- Implementer ---

  private async runImplementer(
    sessionId: string,
    step: PlanStep,
    opts: OrchestratorOptions,
    cycle: number,
    reviewFindings: string | null
  ): Promise<{ turn: NormalizedTurn }> {
    const turnId = this.store.createTurn({
      sessionId,
      role: "implementer",
      ordinal: this.turnOrdinal++,
      stepId: step.id,
      reviewCycle: cycle,
      provider: this.adapter.id,
      model: opts.model ?? "default",
    });

    // §7.4: On retry cycles, include findings and explicit instruction
    const promptParts = [
      `Step ${step.id}: ${step.intent}`,
      "",
      `Files to modify: ${step.touches_paths.join(", ")}`,
      `Verification: ${step.verification}`,
    ];

    if (cycle > 0 && reviewFindings) {
      promptParts.push(
        "",
        "=== REVIEWER FINDINGS FROM PREVIOUS CYCLE ===",
        "The reviewer requested the following changes. Do NOT reinterpret the original intent.",
        "",
        reviewFindings,
        "",
        "=== END FINDINGS ===",
        "",
        "Address all findings while implementing the step."
      );
    } else {
      promptParts.push("", "Implement this step now. Run the verification command when done.");
    }

    const startedAt = Date.now();
    let capturedTurn: NormalizedTurn | null = null;

    await this.adapter.run({
      role: "implementer",
      prompt: promptParts.join("\n"),
      policy: opts.policy,
      model: opts.model,
      enableBash: opts.enableBash,
      onTurn: (turn) => {
        capturedTurn = turn;
        this.store.completeTurn(turnId, {
          providerSession: turn.providerSession,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheWriteTokens: turn.cacheWriteTokens,
          costUsd: turn.costUsd,
          numTurns: turn.numTurns,
          isError: turn.isError,
          exitReason: turn.exitReason,
          rawResultJson: turn.rawResultJson,
        });
        this.updateSessionBudget(sessionId, turn.costUsd);
        printTurnSummary({
          role: "implementer",
          model: turn.model,
          costUsd: turn.costUsd,
          durationMs: Date.now() - startedAt,
          exitReason: turn.exitReason,
          stepId: step.id,
          reviewCycle: cycle > 0 ? cycle : undefined,
        });
      },
      onToolEvent: (evt) => {
        this.store.recordToolEvent(
          turnId,
          evt,
          evt.path ? isPathInAllowlist(evt.path, opts.policy) : true
        );
        // Audit bash commands per §8.1 gap 5
        if (evt.toolName === "Bash" && evt.argsJson) {
          try {
            const args = JSON.parse(evt.argsJson);
            if (args.command && !isBashCommandAllowed(args.command, opts.policy)) {
              logger.warn(
                { command: args.command.slice(0, 100) },
                "AUDIT: Bash command not in allowed prefixes"
              );
            }
          } catch {
            // ignore parse failures
          }
        }
      },
    });

    return { turn: capturedTurn! };
  }

  // --- Reviewer ---

  private async runReviewer(
    sessionId: string,
    diff: string,
    stepId: string,
    stepIntent: string,
    opts: OrchestratorOptions,
    reviewCycle: number
  ): Promise<ReviewArtifact | null> {
    const turnId = this.store.createTurn({
      sessionId,
      role: "reviewer",
      ordinal: this.turnOrdinal++,
      stepId,
      reviewCycle,
      provider: this.reviewerAdapter.id,
      model: opts.model ?? "default",
    });

    const prompt = [
      `Review the following code change for step "${stepId}": ${stepIntent}`,
      "",
      "```diff",
      diff,
      "```",
      "",
      "Produce a review as JSON: { step_id, verdict, findings, tests_suggested, overall_notes }",
    ].join("\n");

    const startedAt = Date.now();
    const result = await this.reviewerAdapter.run({
      role: "reviewer",
      prompt,
      policy: opts.policy,
      model: opts.model,
      bare: true, // CRITICAL: fresh, independent session per §6.4
      onTurn: (turn) => {
        this.store.completeTurn(turnId, {
          providerSession: turn.providerSession,
          inputTokens: turn.inputTokens,
          outputTokens: turn.outputTokens,
          cacheReadTokens: turn.cacheReadTokens,
          cacheWriteTokens: turn.cacheWriteTokens,
          costUsd: turn.costUsd,
          numTurns: turn.numTurns,
          isError: turn.isError,
          exitReason: turn.exitReason,
          rawResultJson: turn.rawResultJson,
        });
        this.updateSessionBudget(sessionId, turn.costUsd);
        printTurnSummary({
          role: "reviewer",
          model: turn.model,
          costUsd: turn.costUsd,
          durationMs: Date.now() - startedAt,
          exitReason: turn.exitReason,
          stepId,
          reviewCycle: reviewCycle > 0 ? reviewCycle : undefined,
        });
      },
      onToolEvent: (evt) => {
        this.store.recordToolEvent(
          turnId,
          evt,
          evt.path ? isPathInAllowlist(evt.path, opts.policy) : true
        );
      },
    });

    return this.parseReview(result.textOutput);
  }

  // --- Helpers ---

  private updateSessionBudget(sessionId: string, additionalCost: number): void {
    const session = this.store.getSession(sessionId);
    if (session) {
      this.store.updateSessionBudget(sessionId, session.budget_usd_used + additionalCost);
    }
  }

  private parsePlan(text: string): Plan | null {
    const json = extractJson(text);
    if (!json) {
      logger.error("Could not extract JSON plan from planner output");
      return null;
    }
    const parsed = PlanSchema.safeParse(json);
    if (!parsed.success) {
      logger.error({ error: parsed.error.message }, "Plan JSON does not match schema");
      return null;
    }
    return parsed.data;
  }

  private parseReview(text: string): ReviewArtifact | null {
    const json = extractJson(text);
    if (!json) {
      logger.error("Could not extract JSON review from reviewer output");
      return null;
    }
    const parsed = ReviewArtifactSchema.safeParse(json);
    if (!parsed.success) {
      logger.error({ error: parsed.error.message }, "Review JSON does not match schema");
      return null;
    }
    return parsed.data;
  }

  private persistPlan(sessionId: string, plan: Plan): void {
    const dir = join(this.workDir, ".poly", "plans");
    mkdirSync(dir, { recursive: true });
    const planPath = join(dir, `${sessionId}.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    logger.info({ planPath }, "Plan written");
  }

  private gitSnapshot(): string {
    try {
      return execSync("git rev-parse HEAD", {
        encoding: "utf-8",
        cwd: this.workDir,
      }).trim();
    } catch {
      logger.warn("Not in a git repository; git snapshot unavailable");
      return "";
    }
  }

  private getDiff(ref: string): string {
    try {
      return execSync(`git diff ${ref}`, { encoding: "utf-8", cwd: this.workDir });
    } catch {
      return "";
    }
  }

  private getDiffSince(ref: string): string {
    if (!ref) return "";
    try {
      // Include both staged and unstaged changes since the snapshot
      return execSync(`git diff ${ref}`, { encoding: "utf-8", cwd: this.workDir });
    } catch {
      return "";
    }
  }

  private revertTo(ref: string): void {
    if (!ref) return;
    try {
      execSync(`git checkout ${ref} -- .`, { cwd: this.workDir });
      // Also clean any untracked files added during the step
      execSync("git clean -fd", { cwd: this.workDir });
      logger.info({ ref }, "Reverted to snapshot");
    } catch (err) {
      logger.error({ err, ref }, "Failed to revert");
    }
  }

  private commitStep(stepId: string, intent: string): void {
    try {
      execSync("git add -A", { cwd: this.workDir });
      execSync(
        `git commit -m "polycode step ${stepId}: ${intent}" --allow-empty`,
        { cwd: this.workDir }
      );
    } catch {
      // If nothing to commit, that's fine
    }
  }

  private dryRun(opts: OrchestratorOptions): { sessionId: string; exitCode: number } {
    const lines = [
      "[polycode] DRY RUN — would execute:",
      `  Mode: ${opts.mode}`,
      `  Task: ${opts.task}`,
      `  Budget: $${opts.policy.budget_usd}`,
      `  Max turns/invocation: ${opts.policy.max_turns_per_invocation}`,
      `  Max review cycles/step: ${opts.policy.max_review_cycles_per_step}`,
      `  Wall clock: ${opts.policy.wall_clock_seconds}s`,
      `  Bash enabled: ${opts.policy.bash_enabled} (CLI --enable-bash: ${!!opts.enableBash})`,
      `  Planner tools: ${opts.policy.allowed_tools_by_role.planner.join(", ")}`,
      `  Implementer tools: ${opts.policy.allowed_tools_by_role.implementer.join(", ")}`,
      `  Reviewer tools: ${opts.policy.allowed_tools_by_role.reviewer.join(", ")}`,
      `  Allowed paths: ${opts.policy.allowed_paths.join(", ")}`,
      `  Denied paths: ${opts.policy.denied_paths.join(", ")}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return { sessionId: "dry-run", exitCode: 0 };
  }
}

/** Extract a JSON object from text that may contain surrounding prose. */
function extractJson(text: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // fall through
  }

  // Look for JSON in code blocks
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Look for first { ... } block
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch {
      // fall through
    }
  }

  return null;
}
