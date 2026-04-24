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

function loadPinnedVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(thisDir, "..", "..", "compat", "gemini-version.txt"), "utf-8").trim();
  } catch {
    return "unknown";
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini";
  readonly pinnedVersion: string;
  readonly capabilities: ProviderCapabilities = {
    supportsBudgetFlag: false,
    supportsToolAllowlist: false,
    supportsBareMode: false,       // No native --bare; uses HOME redirection
    supportsResume: false,          // Limited; version-dependent
    supportsJsonStream: true,       // --output-format stream-json
    supportsModelOverride: true,    // --model
  };

  private pricingTable = loadPricingTable("gemini-pricing.json");

  constructor(private readonly executablePath: string = "gemini") {
    this.pinnedVersion = loadPinnedVersion();
  }

  async checkVersion(): Promise<void> {
    try {
      const result = await execa(this.executablePath, ["--version"]);
      const installed = result.stdout.trim();
      if (installed !== this.pinnedVersion) {
        if (process.env.POLYCODE_ALLOW_GEMINI_VERSION_MISMATCH === "1") {
          logger.warn({ installed, pinned: this.pinnedVersion }, "Gemini version mismatch (override)");
        } else {
          throw new BinaryMissing(
            `Gemini version mismatch: installed "${installed}", pinned "${this.pinnedVersion}"`
          );
        }
      }
      logger.info({ version: installed }, "Gemini version verified");
    } catch (err) {
      if (err instanceof BinaryMissing) throw err;
      throw new BinaryMissing(
        `Could not run "${this.executablePath} --version": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const args = this.buildArgs(opts);

    // Per §5.5 rule A14: reject --yolo at adapter level, hard-coded
    if (args.includes("--yolo")) {
      throw new Error("FORBIDDEN: --yolo is never allowed in polycode invocations (rule A14)");
    }

    const collectedText: string[] = [];
    let model = "unknown";
    let requestedModel = opts.model ?? "gemini-2.5-pro";
    let inputTokens = 0;
    let outputTokens = 0;
    let isError = false;
    let exitReason: ExitReason = "ok";
    let modelDowngrade = false;

    logger.info({ role: opts.role }, "Spawning Gemini");

    // Build environment — reviewer gets HOME redirection per §5.3
    const env = this.buildEnv(opts.role);
    const cwd = opts.role === "reviewer" ? this.createIsolatedWorkdir() : undefined;

    const proc = execa(this.executablePath, args, {
      input: opts.prompt,
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      timeout: Math.min(opts.policy.wall_clock_seconds * 1000, 600_000), // §4.5: 10-min cap for reviewer
      env,
      cwd,
    });

    // Parse output — Gemini with --output-format json returns a single JSON object
    let rawOutput = "";
    if (proc.stdout) {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        rawOutput += decoder.decode(chunk as Buffer, { stream: true });
      }
    }

    const result = await proc;
    const timedOut = "timedOut" in result && (result as unknown as Record<string, unknown>).timedOut === true;
    if (timedOut) exitReason = "deadline_kill";

    // Parse the JSON output
    try {
      const parsed = JSON.parse(rawOutput.trim());

      // Extract response text
      if (typeof parsed.response === "string") {
        collectedText.push(parsed.response);
      } else if (parsed.candidates) {
        // Alternative format
        for (const candidate of parsed.candidates) {
          if (candidate.content?.parts) {
            for (const part of candidate.content.parts) {
              if (part.text) collectedText.push(part.text);
            }
          }
        }
      }

      // Extract stats
      const stats = parsed.stats ?? parsed.usageMetadata ?? {};
      inputTokens = stats.input_tokens ?? stats.promptTokenCount ?? 0;
      outputTokens = stats.output_tokens ?? stats.candidatesTokenCount ?? 0;

      // Model downgrade detection per §5.4
      const usedModels = stats.models ?? parsed.modelVersion;
      if (usedModels) {
        const actualModel = typeof usedModels === "string" ? usedModels : Object.keys(usedModels)[0];
        model = actualModel ?? requestedModel;

        if (actualModel && !actualModel.includes(requestedModel.replace("gemini-", ""))) {
          modelDowngrade = true;
          logger.warn(
            { requested: requestedModel, actual: actualModel },
            "MODEL DOWNGRADE: Gemini used a different model than requested"
          );
          // Emit a tool event for the trace
          opts.onToolEvent({
            toolName: "ModelDowngrade",
            argsJson: JSON.stringify({ requested: requestedModel, actual: actualModel }),
            resultSummary: `Model downgraded from ${requestedModel} to ${actualModel}`,
            path: null,
          });
        }
      } else {
        model = requestedModel;
      }

      // Extract tool calls from response
      if (parsed.tool_calls || parsed.functionCalls) {
        const calls = parsed.tool_calls ?? parsed.functionCalls ?? [];
        for (const call of calls) {
          opts.onToolEvent({
            toolName: call.name ?? "unknown",
            argsJson: call.arguments ? redactSecrets(JSON.stringify(call.arguments)) : null,
            resultSummary: null,
            path: null,
          });
        }
      }
    } catch {
      // If JSON parse fails, treat raw output as text
      if (rawOutput.trim()) {
        collectedText.push(rawOutput.trim());
      }
      if (result.exitCode !== 0) {
        isError = true;
        exitReason = "cli_error";
      }
    }

    // Auth check
    if (result.stderr?.includes("API key") || result.stderr?.includes("auth")) {
      throw new AuthExpired();
    }

    const costUsd = computeCostFromTokens(this.pricingTable, model, inputTokens, outputTokens);

    const turn: NormalizedTurn = {
      provider: "gemini",
      model,
      providerSession: null,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      numTurns: 1,
      isError,
      exitReason,
      rawResultJson: redactSecrets(JSON.stringify({
        exitCode: result.exitCode,
        model,
        inputTokens,
        outputTokens,
        modelDowngrade,
      })),
    };

    opts.onTurn(turn);
    return { turn, textOutput: collectedText.join("") };
  }

  private buildArgs(opts: RunOptions): string[] {
    const args = [
      "--prompt", opts.prompt,
      "--output-format", "json",
      "--non-interactive",
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    return args;
  }

  /**
   * Build environment for subprocess.
   * Per §5.3: reviewer gets HOME redirected to a temp dir
   * to avoid reading ~/.gemini/ config.
   */
  private buildEnv(role: Role): Record<string, string | undefined> {
    const env = { ...process.env };

    if (role === "reviewer") {
      // Redirect HOME to isolate from user config
      const fakeHome = join(tmpdir(), `polycode-gemini-home-${newId()}`);
      mkdirSync(fakeHome, { recursive: true });
      env.HOME = fakeHome;

      // Unset Gemini-specific env vars per §5.3
      delete env.GEMINI_MEMORY_DIR;
      delete env.GEMINI_CONFIG_DIR;

      logger.info({ fakeHome }, "Gemini reviewer running with isolated HOME");
    }

    return env;
  }

  /** Create isolated workdir for reviewer per §5.3 */
  private createIsolatedWorkdir(): string {
    const dir = join(tmpdir(), `polycode-gemini-review-${newId()}`);
    mkdirSync(dir, { recursive: true });
    // No GEMINI.md — intentionally empty so discovery finds nothing
    return dir;
  }
}
