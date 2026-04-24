import { execa } from "execa";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { redactSecrets } from "../policy/engine.js";
import { newId } from "../ids.js";
import { logger } from "../logger.js";
import { loadPricingTable, computeCostFromTokens } from "./pricing.js";
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
 * Known Codex JSONL event types per §4.1.
 */
const KNOWN_CODEX_EVENTS = new Set([
  "thread.started",
  "turn.started",
  "item.started",
  "item.updated",
  "item.completed",
  "turn.completed",
  "turn.failed",
]);

function loadPinnedVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(thisDir, "..", "..", "compat", "codex-version.txt"), "utf-8").trim();
  } catch {
    return "unknown";
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly pinnedVersion: string;
  readonly capabilities: ProviderCapabilities = {
    supportsBudgetFlag: false,      // §4.4: Codex has no native budget flag
    supportsToolAllowlist: false,    // via sandbox mode, mapped post-hoc
    supportsBareMode: true,          // --ignore-user-config + --ignore-rules
    supportsResume: true,            // codex exec resume
    supportsJsonStream: true,        // --json
    supportsModelOverride: true,     // --model
  };

  private pricingTable = loadPricingTable("codex-pricing.json");

  constructor(private readonly executablePath: string = "codex") {
    this.pinnedVersion = loadPinnedVersion();
  }

  async checkVersion(): Promise<void> {
    try {
      const result = await execa(this.executablePath, ["--version"]);
      const installed = result.stdout.trim();
      if (installed !== this.pinnedVersion) {
        if (process.env.POLYCODE_ALLOW_CODEX_VERSION_MISMATCH === "1") {
          logger.warn({ installed, pinned: this.pinnedVersion }, "Codex version mismatch (override)");
        } else {
          throw new BinaryMissing(
            `Codex version mismatch: installed "${installed}", pinned "${this.pinnedVersion}"`
          );
        }
      }
      logger.info({ version: installed }, "Codex version verified");
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
    let model = "unknown";
    let inputTokens = 0;
    let outputTokens = 0;
    let numTurns = 0;
    let isError = false;
    let exitReason: ExitReason = "ok";

    logger.info({ role: opts.role }, "Spawning Codex");

    // For reviewer, run in isolated workdir per §4.3
    const cwd = opts.role === "reviewer" ? this.createIsolatedWorkdir() : undefined;

    const proc = execa(this.executablePath, ["exec", ...args, opts.prompt], {
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      timeout: opts.policy.wall_clock_seconds * 1000,
      cwd,
    });

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

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(trimmed);
          } catch {
            continue;
          }

          const type = event.type as string;
          if (!KNOWN_CODEX_EVENTS.has(type)) {
            throw new ToolEventUnknown(type, trimmed.slice(0, 300));
          }

          this.processEvent(event, opts, collectedText, (info) => {
            if (info.model) model = info.model;
            if (info.inputTokens) inputTokens += info.inputTokens;
            if (info.outputTokens) outputTokens += info.outputTokens;
            if (info.turnCompleted) numTurns++;
            if (info.failed) { isError = true; exitReason = "cli_error"; }
          });
        }
      }
    }

    const result = await proc;
    const timedOut = "timedOut" in result && (result as unknown as Record<string, unknown>).timedOut === true;
    if (timedOut) exitReason = "deadline_kill";

    // Check for auth errors
    if (result.stderr?.includes("auth") || result.stderr?.includes("API key")) {
      throw new AuthExpired();
    }
    if (result.stderr?.includes("rate limit")) {
      throw new RateLimited(null, true);
    }

    // Compute cost from token counts (no native $ reporting)
    const costUsd = computeCostFromTokens(this.pricingTable, model, inputTokens, outputTokens);

    const turn: NormalizedTurn = {
      provider: "codex",
      model,
      providerSession: null,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      numTurns,
      isError,
      exitReason,
      rawResultJson: redactSecrets(JSON.stringify({ exitCode: result.exitCode, model, inputTokens, outputTokens })),
    };

    opts.onTurn(turn);
    return { turn, textOutput: collectedText.join("") };
  }

  private buildArgs(opts: RunOptions): string[] {
    const args = ["--json", "--skip-git-repo-check", "--ephemeral"];

    // Reviewer isolation per §4.3
    if (opts.role === "reviewer") {
      args.push("--ignore-user-config", "--ignore-rules");
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    // Codex has no --allowedTools equivalent; tool control is via sandbox presets
    // We rely on post-hoc audit like CC's bash audit

    return args;
  }

  private processEvent(
    event: Record<string, unknown>,
    opts: RunOptions,
    collectedText: string[],
    onInfo: (info: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      turnCompleted?: boolean;
      failed?: boolean;
    }) => void
  ): void {
    const type = event.type as string;

    switch (type) {
      case "item.completed": {
        // Extract text output
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const block of item.content as Array<Record<string, unknown>>) {
            if (block.type === "output_text" && typeof block.text === "string") {
              collectedText.push(block.text);
            }
          }
        }
        // Extract tool calls
        if (item?.type === "function_call") {
          opts.onToolEvent({
            toolName: (item.name as string) ?? "unknown",
            argsJson: item.arguments ? redactSecrets(JSON.stringify(item.arguments)) : null,
            resultSummary: null,
            path: null,
          });
        }
        break;
      }

      case "turn.completed": {
        const usage = event.usage as Record<string, number> | undefined;
        onInfo({
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          turnCompleted: true,
          model: event.model as string | undefined,
        });
        break;
      }

      case "turn.failed":
        onInfo({ failed: true });
        break;
    }
  }

  /** Create a minimal isolated workdir for reviewer per §4.3 */
  private createIsolatedWorkdir(): string {
    const dir = join(tmpdir(), `polycode-codex-review-${newId()}`);
    mkdirSync(dir, { recursive: true });
    // Empty AGENTS.md so Codex doesn't complain
    writeFileSync(join(dir, "AGENTS.md"), "");
    // Must be a git repo for codex exec
    const { execSync } = require("node:child_process");
    execSync("git init", { cwd: dir, stdio: "ignore" });
    return dir;
  }
}
