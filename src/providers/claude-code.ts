import { execa } from "execa";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { policyToClaudeFlags, redactSecrets } from "../policy/engine.js";
import { newId } from "../ids.js";
import { logger } from "../logger.js";
import {
  BinaryMissing,
  AuthExpired,
  RateLimited,
  ToolEventUnknown,
} from "../errors.js";
import type { Policy } from "../models/policy.js";
import type {
  Role,
  ExitReason,
  NormalizedTurn,
  NormalizedToolEvent,
  RunResult,
} from "../models/events.js";
import type { ProviderAdapter, ProviderCapabilities, RunOptions } from "./adapter.js";

/**
 * Known stream-json event types from Claude Code.
 * Per Appendix A rule 3: fail loudly on unknown events.
 */
const KNOWN_EVENT_TYPES = new Set([
  "system",
  "assistant",
  "user",
  "tool",
  "result",
]);

// --- Stream event types ---

interface StreamEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

interface ResultEvent extends StreamEvent {
  type: "result";
  subtype?: string;
  is_error: boolean;
  num_turns: number;
  session_id: string;
  total_cost_usd: number;
  modelUsage?: Record<string, ModelUsageEntry>;
  errors?: string[];
}

interface AssistantEvent extends StreamEvent {
  type: "assistant";
  message: {
    model: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
}

interface ToolEvent extends StreamEvent {
  type: "tool";
  tool_use_id: string;
  name: string;
  content: string;
}

interface SystemEvent extends StreamEvent {
  type: "system";
  subtype: string;
  session_id: string;
  model: string;
}

/**
 * Load the pinned version string from compat/claude-code-version.txt.
 */
function loadPinnedVersion(): string {
  try {
    // Resolve relative to this module's directory
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const compatPath = join(thisDir, "..", "..", "compat", "claude-code-version.txt");
    return readFileSync(compatPath, "utf-8").trim();
  } catch {
    return "unknown";
  }
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = "claude-code";
  readonly pinnedVersion: string;
  readonly capabilities: ProviderCapabilities = {
    supportsBudgetFlag: true,
    supportsToolAllowlist: true,
    supportsBareMode: true,
    supportsResume: true,
    supportsJsonStream: true,
    supportsModelOverride: true,
  };

  constructor(private readonly executablePath: string = "claude") {
    this.pinnedVersion = loadPinnedVersion();
  }

  /**
   * Per §6.2: check installed CLI version matches pin.
   * Refuses to proceed on mismatch unless POLYCODE_ALLOW_CC_VERSION_MISMATCH=1.
   */
  async checkVersion(): Promise<void> {
    try {
      const result = await execa(this.executablePath, ["--version"]);
      const installed = result.stdout.trim();

      if (installed !== this.pinnedVersion) {
        if (process.env.POLYCODE_ALLOW_CC_VERSION_MISMATCH === "1") {
          logger.warn(
            { installed, pinned: this.pinnedVersion },
            "Claude Code version mismatch (override enabled)"
          );
        } else {
          throw new BinaryMissing(
            `Version mismatch: installed "${installed}", pinned "${this.pinnedVersion}". ` +
              `Set POLYCODE_ALLOW_CC_VERSION_MISMATCH=1 to override.`
          );
        }
      }

      logger.info({ version: installed }, "Claude Code version verified");
    } catch (err) {
      if (err instanceof BinaryMissing) throw err;
      throw new BinaryMissing(
        `Could not run "${this.executablePath} --version": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(opts);
    const collectedText: string[] = [];
    let sessionId: string | null = null;
    let model = "unknown";
    let resultEvent: ResultEvent | null = null;
    const stderrChunks: string[] = [];

    logger.info(
      { role: opts.role, args: args.filter((a) => !a.startsWith("--max-budget")).join(" ") },
      "Spawning Claude Code"
    );

    const proc = execa(this.executablePath, args, {
      input: opts.prompt,
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      timeout: opts.policy.wall_clock_seconds * 1000,
    });

    // Capture stderr for crash diagnostics
    if (proc.stderr) {
      const decoder = new TextDecoder();
      (async () => {
        for await (const chunk of proc.stderr!) {
          const text = decoder.decode(chunk as Buffer, { stream: true });
          stderrChunks.push(text);
          // Keep only last ~200 lines worth
          if (stderrChunks.length > 200) stderrChunks.shift();
        }
      })().catch(() => {});
    }

    // Parse streaming JSON line by line
    if (proc.stdout) {
      const decoder = new TextDecoder();
      let buffer = "";

      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk as Buffer, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          if (!KNOWN_EVENT_TYPES.has(event.type)) {
            // Per Appendix A rule 3: fail loudly, do not drop silently
            throw new ToolEventUnknown(event.type, trimmed.slice(0, 300));
          }

          this.processEvent(event, opts, collectedText, (info) => {
            sessionId = info.sessionId ?? sessionId;
            model = info.model ?? model;
            if (info.result) resultEvent = info.result;
          });
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event: StreamEvent = JSON.parse(buffer.trim());
          if (!KNOWN_EVENT_TYPES.has(event.type)) {
            throw new ToolEventUnknown(event.type, buffer.trim().slice(0, 300));
          }
          this.processEvent(event, opts, collectedText, (info) => {
            sessionId = info.sessionId ?? sessionId;
            model = info.model ?? model;
            if (info.result) resultEvent = info.result;
          });
        } catch (err) {
          if (err instanceof ToolEventUnknown) throw err;
          // ignore trailing non-JSON
        }
      }
    }

    // Wait for process to complete
    const result = await proc;

    // TypeScript's control-flow can't track `let` assignments inside for-await,
    // so we snapshot to a typed const before narrowing.
    const finalResult = resultEvent as ResultEvent | null;

    // Crash capture per §3.3
    if (result.exitCode !== 0 && !finalResult) {
      this.writeCrashDump(stderrChunks, null, opts.role);
    }

    // Check for auth errors in result
    if (finalResult?.errors?.some((e: string) => /auth|login|credential/i.test(e))) {
      throw new AuthExpired();
    }

    // Check for rate limiting
    if (finalResult?.errors?.some((e: string) => /rate.?limit/i.test(e))) {
      throw new RateLimited(null, true);
    }

    // Build normalized turn from result event
    // execa sets timedOut=true when the wall-clock timeout fires
    const timedOut = "timedOut" in result && (result as unknown as Record<string, unknown>).timedOut === true;
    const turn = this.buildNormalizedTurn(finalResult, model, sessionId, result.exitCode, timedOut);
    opts.onTurn(turn);

    return {
      turn,
      textOutput: collectedText.join(""),
    };
  }

  private buildArgs(opts: RunOptions): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
    ];

    // Policy-derived flags (includes per-role tool allowlist)
    const policyFlags = policyToClaudeFlags(opts.policy, opts.role, {
      enableBash: opts.enableBash,
    });
    args.push(...policyFlags);

    // Bare mode for reviewer (may already be in policyFlags)
    if (opts.bare && !policyFlags.includes("--bare")) {
      args.push("--bare");
    }

    // Model override
    if (opts.model) {
      args.push("--model", opts.model);
    }

    // Session management
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId, "--fork-session");
    }

    // Additional directories
    if (opts.addDirs) {
      for (const dir of opts.addDirs) {
        args.push("--add-dir", dir);
      }
    }

    // Append system prompt with role-specific rubric
    const rubric = this.getRoleRubric(opts.role);
    if (rubric) {
      args.push("--append-system-prompt", rubric);
    }

    return args;
  }

  private processEvent(
    event: StreamEvent,
    opts: RunOptions,
    collectedText: string[],
    onInfo: (info: {
      sessionId?: string;
      model?: string;
      result?: ResultEvent;
    }) => void
  ): void {
    switch (event.type) {
      case "system": {
        const sysEvt = event as SystemEvent;
        onInfo({ sessionId: sysEvt.session_id, model: sysEvt.model });
        break;
      }

      case "assistant": {
        const aEvt = event as AssistantEvent;
        if (aEvt.message?.content) {
          for (const block of aEvt.message.content) {
            if (block.type === "text" && block.text) {
              collectedText.push(block.text);
            }
            if (block.type === "tool_use" && block.name) {
              const toolEvent: NormalizedToolEvent = {
                toolName: block.name,
                argsJson: block.input ? redactSecrets(JSON.stringify(block.input)) : null,
                resultSummary: null,
                path: extractPathFromToolInput(block.name, block.input),
              };
              opts.onToolEvent(toolEvent);
            }
          }
        }
        break;
      }

      case "tool": {
        const tEvt = event as ToolEvent;
        const summary = typeof tEvt.content === "string"
          ? tEvt.content.slice(0, 500)
          : JSON.stringify(tEvt.content).slice(0, 500);
        opts.onToolEvent({
          toolName: tEvt.name ?? "unknown",
          argsJson: null,
          resultSummary: redactSecrets(summary),
          path: null,
        });
        break;
      }

      case "result": {
        onInfo({ result: event as ResultEvent });
        break;
      }

      case "user":
        // Our own prompts echoed back — ignore
        break;
    }
  }

  private buildNormalizedTurn(
    resultEvent: ResultEvent | null,
    model: string,
    sessionId: string | null,
    exitCode: number | undefined,
    timedOut = false
  ): NormalizedTurn {
    if (!resultEvent) {
      return {
        provider: "claude-code",
        model,
        providerSession: sessionId,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        numTurns: 0,
        isError: true,
        exitReason: "cli_error",
        rawResultJson: "{}",
      };
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;

    if (resultEvent.modelUsage) {
      for (const usage of Object.values(resultEvent.modelUsage)) {
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        cacheReadTokens += usage.cacheReadInputTokens ?? 0;
        cacheWriteTokens += usage.cacheCreationInputTokens ?? 0;
        costUsd += usage.costUSD ?? 0;
      }
    }

    const exitReason = this.classifyExitReason(resultEvent, exitCode, timedOut);

    return {
      provider: "claude-code",
      model,
      providerSession: resultEvent.session_id ?? sessionId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      numTurns: resultEvent.num_turns ?? 0,
      isError: resultEvent.is_error ?? false,
      exitReason,
      rawResultJson: redactSecrets(JSON.stringify(resultEvent)),
    };
  }

  private classifyExitReason(result: ResultEvent, exitCode: number | undefined, timedOut = false): ExitReason {
    if (timedOut) return "deadline_kill";
    if (result.subtype === "error_max_budget_usd") return "budget_kill";
    if (result.subtype === "error_max_turns") return "max_turns_kill";
    if (result.errors?.some((e) => /rate.?limit/i.test(e))) return "rate_limited";
    if (result.errors?.some((e) => /auth|login/i.test(e))) return "auth_expired";
    if (result.is_error) return "cli_error";
    if (exitCode !== 0 && exitCode !== undefined) return "cli_error";
    return "ok";
  }

  private getRoleRubric(role: Role): string {
    switch (role) {
      case "planner":
        return [
          "You are a PLANNER. Your job is to analyze the task and produce a structured plan.",
          "You MUST NOT edit any files. Only use Read, Grep, and Glob tools.",
          "Output your plan as a JSON object with this schema: { task, steps: [{ id, intent, touches_paths, verification }], assumptions, out_of_scope }.",
          "Each step should be a discrete, reviewable unit of work.",
          "Be specific about which files each step touches.",
        ].join("\n");

      case "implementer":
        return [
          "You are an IMPLEMENTER executing one step of a plan.",
          "Focus only on the step described. Do not work on other steps.",
          "After making changes, run the verification command if one was provided.",
          "If you encounter an issue outside the step scope, note it but do not fix it.",
        ].join("\n");

      case "reviewer":
        return [
          "You are an independent CODE REVIEWER. You have NO context about this project beyond the diff and step description provided.",
          "Review the diff for: correctness, security vulnerabilities, missing error handling, edge cases, test coverage gaps.",
          "Output your review as a JSON object with this schema: { step_id, verdict: 'approve'|'request_changes'|'reject', findings: [{ severity, path, line, issue, suggestion }], tests_suggested, overall_notes }.",
          "Be specific. Cite line numbers. Do not rubber-stamp.",
          "verdict='reject' means the change is fundamentally wrong. 'request_changes' means fixable issues. 'approve' means production-ready.",
        ].join("\n");
    }
  }

  /**
   * Write a crash dump per §3.3.
   * Captures last stderr lines and last parsed event.
   */
  private writeCrashDump(
    stderrChunks: string[],
    lastEvent: StreamEvent | null,
    role: Role
  ): void {
    try {
      const crashId = newId();
      const dir = join(process.cwd(), ".poly");
      mkdirSync(dir, { recursive: true });
      const crashPath = join(dir, `crash-${crashId}.json`);
      const dump = {
        id: crashId,
        timestamp: new Date().toISOString(),
        role,
        stderr: stderrChunks.join("").slice(-10000), // last ~10KB
        lastEvent: lastEvent ? redactSecrets(JSON.stringify(lastEvent)) : null,
      };
      writeFileSync(crashPath, JSON.stringify(dump, null, 2));
      logger.error({ crashPath }, "Subprocess crash dump written");
    } catch {
      // Best-effort — don't fail the main flow over crash logging
    }
  }
}

/** Extract file path from tool input if present. */
function extractPathFromToolInput(
  toolName: string,
  input?: Record<string, unknown>
): string | null {
  if (!input) return null;
  const pathFields = ["file_path", "path"];
  for (const field of pathFields) {
    if (typeof input[field] === "string") {
      return input[field] as string;
    }
  }
  return null;
}
