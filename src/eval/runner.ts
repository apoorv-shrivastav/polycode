import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { ClaudeCodeAdapter } from "../providers/claude-code.js";
import { DEFAULT_POLICY, type Policy } from "../models/policy.js";
import { TraceStore } from "../trace/store.js";
import { logger } from "../logger.js";
import { CorpusManifestSchema, type CorpusManifest, type Defect, type DefectRunResult, type EvalCondition } from "./types.js";
import {
  computeConditionMetrics,
  compareConditions,
  applyDecisionRule,
  resultsToCSV,
  formatSummaryReport,
} from "./metrics.js";
import type { ProviderAdapter } from "../providers/adapter.js";

const ORANGE_LINE_USD = 1000;

export interface EvalRunnerOptions {
  corpusDir: string;
  conditions: EvalCondition[];
  maxCostUsd: number;
  outputPath: string;
  adapter?: ProviderAdapter;
}

export class EvalRunner {
  private results: DefectRunResult[] = [];
  private totalCostUsd = 0;
  private aborted = false;

  async run(opts: EvalRunnerOptions): Promise<{
    results: DefectRunResult[];
    exitCode: number;
  }> {
    // Load corpus manifest
    const manifestPath = join(opts.corpusDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      logger.error({ path: manifestPath }, "Corpus manifest not found");
      return { results: [], exitCode: 1 };
    }

    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const manifest = CorpusManifestSchema.parse(rawManifest);

    logger.info({
      codebases: manifest.codebases.length,
      defects: manifest.defects.length,
      conditions: opts.conditions,
      maxCost: opts.maxCostUsd,
    }, "Starting eval run");

    // Create eval run directory
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const runDir = join(opts.corpusDir, "..", "eval", "runs", runId);
    mkdirSync(runDir, { recursive: true });

    // Run each condition × defect
    for (const condition of opts.conditions) {
      for (const defect of manifest.defects) {
        if (this.aborted) break;

        // Cost ceiling check
        if (this.totalCostUsd >= opts.maxCostUsd) {
          logger.error({ totalCost: this.totalCostUsd, ceiling: opts.maxCostUsd },
            "Cost ceiling reached — aborting eval");
          this.aborted = true;
          break;
        }

        // Orange line warning
        if (this.totalCostUsd >= ORANGE_LINE_USD && !this.aborted) {
          logger.warn({ totalCost: this.totalCostUsd },
            "ORANGE LINE: Eval cost has exceeded $1000");
        }

        try {
          const result = await this.runOneDefect(
            defect, condition, manifest, opts, runDir
          );
          this.results.push(result);
          this.totalCostUsd += result.costUsd;

          logger.info({
            defect: defect.id,
            condition,
            caught: result.caught,
            cost: result.costUsd,
          }, `${condition}:${defect.id} → ${result.caught ? "CAUGHT" : "MISSED"}`);
        } catch (err) {
          const errResult: DefectRunResult = {
            defectId: defect.id,
            codebase: defect.codebase,
            condition,
            caught: false,
            falsePositive: false,
            testCaught: false,
            costUsd: 0,
            durationMs: 0,
            sessionId: "",
            error: err instanceof Error ? err.message : String(err),
          };
          this.results.push(errResult);
          logger.error({ defect: defect.id, condition, err },
            `${condition}:${defect.id} → ERROR`);
        }
      }
    }

    // Compute metrics
    const metricsMap = new Map<EvalCondition, ReturnType<typeof computeConditionMetrics>>();
    for (const cond of opts.conditions) {
      metricsMap.set(cond, computeConditionMetrics(cond, this.results));
    }

    // Compute comparisons
    const comparisons = [];
    const metricsA = metricsMap.get("A");
    const metricsB = metricsMap.get("B");
    const metricsC = metricsMap.get("C");

    if (metricsC && metricsA) comparisons.push(compareConditions(metricsA, metricsC));
    if (metricsC && metricsB) comparisons.push(compareConditions(metricsB, metricsC));

    // Apply decision rule
    let decision = { h1Supported: false, reason: "Insufficient conditions to evaluate H1" };
    if (metricsA && metricsB && metricsC) {
      decision = applyDecisionRule({
        cVsA: compareConditions(metricsA, metricsC),
        cVsB: compareConditions(metricsB, metricsC),
      });
    }

    // Write outputs
    const csvContent = resultsToCSV(this.results);
    writeFileSync(opts.outputPath, csvContent);
    logger.info({ path: opts.outputPath }, "Results CSV written");

    const reportContent = formatSummaryReport(
      metricsMap, comparisons, decision, this.totalCostUsd, this.aborted
    );
    const reportPath = opts.outputPath.replace(/\.csv$/, ".md");
    writeFileSync(reportPath, reportContent);
    logger.info({ path: reportPath }, "Summary report written");

    // Also write to run directory
    writeFileSync(join(runDir, "results.csv"), csvContent);
    writeFileSync(join(runDir, "report.md"), reportContent);
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      runId,
      conditions: opts.conditions,
      totalCost: this.totalCostUsd,
      totalDefects: this.results.length,
      incomplete: this.aborted,
      timestamp: new Date().toISOString(),
    }, null, 2));

    // Print summary to stdout
    process.stdout.write("\n" + reportContent + "\n");

    return { results: this.results, exitCode: this.aborted ? 2 : 0 };
  }

  private async runOneDefect(
    defect: Defect,
    condition: EvalCondition,
    manifest: CorpusManifest,
    opts: EvalRunnerOptions,
    runDir: string
  ): Promise<DefectRunResult> {
    const startTime = Date.now();
    const codebaseInfo = manifest.codebases.find((c) => c.id === defect.codebase);
    if (!codebaseInfo) {
      throw new Error(`Codebase "${defect.codebase}" not found in manifest`);
    }

    // Create a working copy of the codebase
    const workDir = join(runDir, `${condition}-${defect.id}`);
    const sourceDir = join(opts.corpusDir, codebaseInfo.path);
    cpSync(sourceDir, workDir, { recursive: true });

    // Initialize git in the working copy if not already
    try {
      execSync("git rev-parse --is-inside-work-tree", { cwd: workDir, encoding: "utf-8" });
    } catch {
      execSync("git init && git add -A && git commit -m 'baseline'", {
        cwd: workDir,
        encoding: "utf-8",
        env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@polycode", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@polycode" },
      });
    }

    // Apply the fault-introducing diff
    const diffPath = join(opts.corpusDir, defect.diff_file);
    if (existsSync(diffPath)) {
      try {
        execSync(`git apply "${diffPath}"`, { cwd: workDir, encoding: "utf-8" });
        execSync("git add -A && git commit -m 'introduce defect'", {
          cwd: workDir,
          encoding: "utf-8",
          env: { ...process.env, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@polycode", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@polycode" },
        });
      } catch {
        // If git apply fails, try direct file copy approach
        logger.warn({ defect: defect.id }, "git apply failed, defect may already be present");
      }
    }

    // Get the diff that contains the defect (for reviewer)
    const defectDiff = execSync("git diff HEAD~1", { cwd: workDir, encoding: "utf-8" });

    // Per-eval DB
    const dbPath = join(workDir, ".poly", "trace.db");
    mkdirSync(join(workDir, ".poly"), { recursive: true });

    // Create the appropriate policy
    const evalPolicy: Policy = {
      ...DEFAULT_POLICY,
      budget_usd: 1.0, // per-defect budget
      wall_clock_seconds: 300,
      max_turns_per_invocation: 20,
    };

    const adapter = opts.adapter ?? new ClaudeCodeAdapter();

    let caught = false;
    let falsePositive = false;
    let testCaught = false;
    let sessionId = "";
    let costUsd = 0;

    switch (condition) {
      case "A": {
        // No review — just check if tests catch it
        testCaught = await this.runDefectTest(defect, workDir, opts.corpusDir);
        caught = testCaught;
        break;
      }

      case "B": {
        // Self-review in same session (implementer reviews own work)
        const orchestrator = new Orchestrator({ dbPath, adapter, workDir });
        try {
          const selfReviewPrompt = [
            "Review the following code change for defects.",
            "Look for: correctness issues, security vulnerabilities, missing error handling, edge cases.",
            "",
            "```diff",
            defectDiff,
            "```",
            "",
            "List any defects you find as JSON: { findings: [{ issue, path, severity }] }",
            "If no defects, respond with { findings: [] }",
          ].join("\n");

          const result = await adapter.run({
            role: "implementer", // same session as implementer
            prompt: selfReviewPrompt,
            policy: evalPolicy,
            onTurn: (turn) => { costUsd += turn.costUsd; },
            onToolEvent: () => {},
          });

          sessionId = result.turn.providerSession ?? "";
          caught = this.checkIfDefectCaught(result.textOutput, defect);
          falsePositive = this.checkForFalsePositives(result.textOutput, defect);
        } finally {
          orchestrator.close();
        }
        break;
      }

      case "C": {
        // Fresh independent reviewer (--bare, new session)
        const orchestrator = new Orchestrator({ dbPath, adapter, workDir });
        try {
          const result = await adapter.run({
            role: "reviewer",
            prompt: [
              "Review the following code change for defects.",
              "Look for: correctness issues, security vulnerabilities, missing error handling, edge cases.",
              "",
              "```diff",
              defectDiff,
              "```",
              "",
              "Output JSON: { step_id: 'eval', verdict: 'approve'|'request_changes'|'reject', findings: [{ severity, path, line, issue, suggestion }], tests_suggested: [], overall_notes: '' }",
            ].join("\n"),
            policy: evalPolicy,
            bare: true,
            onTurn: (turn) => { costUsd += turn.costUsd; },
            onToolEvent: () => {},
          });

          sessionId = result.turn.providerSession ?? "";
          caught = this.checkIfDefectCaught(result.textOutput, defect);
          falsePositive = this.checkForFalsePositives(result.textOutput, defect);
        } finally {
          orchestrator.close();
        }
        break;
      }

      case "D":
        // Different provider reviewer — deferred to v0.5
        throw new Error("Condition D not implemented in v0");
    }

    return {
      defectId: defect.id,
      codebase: defect.codebase,
      condition,
      caught,
      falsePositive,
      testCaught,
      costUsd,
      durationMs: Date.now() - startTime,
      sessionId,
      error: null,
    };
  }

  /** Run the defect's test to see if it catches the bug. */
  private async runDefectTest(
    defect: Defect,
    workDir: string,
    corpusDir: string
  ): Promise<boolean> {
    // Copy test file into the working directory if needed
    const testSource = join(corpusDir, defect.test_file);
    if (existsSync(testSource)) {
      const testDest = join(workDir, defect.test_file.split("/").slice(-1)[0]);
      cpSync(testSource, testDest);
    }

    try {
      execSync(defect.test_command, { cwd: workDir, encoding: "utf-8", timeout: 30000 });
      // Test passed → defect NOT caught
      return false;
    } catch {
      // Test failed → defect caught by test
      return true;
    }
  }

  /**
   * Check if the reviewer's output mentions the actual defect.
   * Heuristic: look for keywords from the defect description in the findings.
   */
  private checkIfDefectCaught(reviewOutput: string, defect: Defect): boolean {
    const output = reviewOutput.toLowerCase();
    const desc = defect.description.toLowerCase();

    // Extract key terms from the defect description (words ≥4 chars)
    const keyTerms = desc
      .split(/\s+/)
      .filter((w) => w.length >= 4)
      .map((w) => w.replace(/[^a-z0-9]/g, ""))
      .filter((w) => w.length >= 4);

    // Check if the reviewer mentions enough key terms
    const matched = keyTerms.filter((term) => output.includes(term));
    const matchRatio = keyTerms.length > 0 ? matched.length / keyTerms.length : 0;

    // Also check for the affected files being mentioned
    const mentionsFile = defect.affected_files.some((f) =>
      output.includes(f.toLowerCase()) || output.includes(f.split("/").pop()!.toLowerCase())
    );

    // Caught if mentions the file AND matches ≥30% of key terms, or matches ≥50%
    return (mentionsFile && matchRatio >= 0.3) || matchRatio >= 0.5;
  }

  /** Check if any findings don't relate to the actual defect (false positives). */
  private checkForFalsePositives(reviewOutput: string, defect: Defect): boolean {
    // Try to parse findings from JSON
    try {
      const jsonMatch = reviewOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const findings = parsed.findings ?? [];
        if (findings.length === 0) return false;

        // If there are findings but defect wasn't caught, they're false positives
        const caught = this.checkIfDefectCaught(reviewOutput, defect);
        if (!caught && findings.length > 0) return true;
      }
    } catch {
      // Not parseable — can't determine
    }
    return false;
  }
}
