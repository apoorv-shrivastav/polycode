import pino from "pino";
import { redactSecrets } from "./policy/engine.js";

/**
 * Structured logging per §3.3.
 * - JSON lines to stderr at levels debug, info, warn, error.
 * - Secrets are redacted at the logger layer before serialization.
 */

const transport = pino.transport({
  target: "pino/file",
  options: { destination: 2 }, // stderr (fd 2)
});

export const logger = pino(
  {
    level: process.env.POLYCODE_LOG_LEVEL ?? "info",
    formatters: {
      log(obj: Record<string, unknown>) {
        // Redact secrets from all string values
        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          if (typeof value === "string") {
            redacted[key] = redactSecrets(value);
          } else {
            redacted[key] = value;
          }
        }
        return redacted;
      },
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
  },
  transport
);

/**
 * Human-friendly one-line summary to stdout per §3.3.
 * Role, model, cost, duration, exit reason.
 */
export function printTurnSummary(info: {
  role: string;
  model: string;
  costUsd: number;
  durationMs: number;
  exitReason: string;
  stepId?: string;
  reviewCycle?: number;
}): void {
  const step = info.stepId ? ` step=${info.stepId}` : "";
  const cycle = info.reviewCycle ? ` cycle=${info.reviewCycle}` : "";
  const line = `[${info.role}] model=${info.model}${step}${cycle} cost=$${info.costUsd.toFixed(4)} duration=${(info.durationMs / 1000).toFixed(1)}s exit=${info.exitReason}`;
  process.stdout.write(line + "\n");
}

/**
 * Print the wrapper-mode gaps to stderr at session start.
 * Per §8.1 — printed verbatim, every session.
 */
export function printWrapperGaps(gaps: string): void {
  process.stderr.write("\n" + gaps + "\n\n");
}
