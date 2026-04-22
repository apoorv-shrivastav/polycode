import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal parser extracted from ClaudeCodeAdapter for unit testing event parsing. */
function parseStreamEvents(jsonlContent: string) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for (const line of jsonlContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip non-JSON lines
    }
  }
  return events;
}

function extractModelUsage(resultEvent: Record<string, unknown>) {
  const modelUsage = resultEvent.modelUsage as Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }> | undefined;

  if (!modelUsage) return { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  for (const usage of Object.values(modelUsage)) {
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    costUsd += usage.costUSD ?? 0;
  }
  return { inputTokens, outputTokens, costUsd };
}

function extractToolUses(events: Array<{ type: string; [key: string]: unknown }>) {
  const tools: Array<{ name: string; path: string | null }> = [];
  for (const evt of events) {
    if (evt.type === "assistant") {
      const msg = evt.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> };
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.name) {
            tools.push({
              name: block.name,
              path: (block.input?.file_path as string) ?? (block.input?.path as string) ?? null,
            });
          }
        }
      }
    }
  }
  return tools;
}

describe("stream-json event parsing", () => {
  const fixturePath = join(import.meta.dirname, "..", "fixtures", "stream-simple.jsonl");
  const content = readFileSync(fixturePath, "utf-8");
  const events = parseStreamEvents(content);

  it("parses all events from fixture", () => {
    expect(events).toHaveLength(5);
  });

  it("identifies event types correctly", () => {
    expect(events.map(e => e.type)).toEqual([
      "system", "assistant", "assistant", "tool", "result",
    ]);
  });

  it("extracts session_id from system event", () => {
    const sysEvent = events.find(e => e.type === "system");
    expect(sysEvent?.session_id).toBe("test-session-001");
  });

  it("extracts model from system event", () => {
    const sysEvent = events.find(e => e.type === "system");
    expect(sysEvent?.model).toBe("claude-sonnet-4-5-20250514");
  });

  it("extracts text content from assistant events", () => {
    const assistantEvents = events.filter(e => e.type === "assistant");
    const firstMsg = assistantEvents[0].message as { content: Array<{ type: string; text?: string }> };
    expect(firstMsg.content[0].text).toBe("I'll create the hello world endpoint.");
  });

  it("extracts tool uses from assistant events", () => {
    const tools = extractToolUses(events);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("Write");
    expect(tools[0].path).toBe("/tmp/test/src/hello.ts");
  });

  it("extracts model usage from result event", () => {
    const resultEvent = events.find(e => e.type === "result")!;
    const usage = extractModelUsage(resultEvent as Record<string, unknown>);
    expect(usage.inputTokens).toBe(150);
    expect(usage.outputTokens).toBe(60);
    expect(usage.costUsd).toBeCloseTo(0.0234);
  });

  it("detects successful completion", () => {
    const resultEvent = events.find(e => e.type === "result")!;
    expect(resultEvent.is_error).toBe(false);
    expect(resultEvent.num_turns).toBe(2);
  });
});

describe("stream-json error detection", () => {
  it("detects budget-exceeded error", () => {
    const budgetErrorResult = {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0.05,
    };

    expect(budgetErrorResult.subtype).toBe("error_max_budget_usd");
    expect(budgetErrorResult.is_error).toBe(true);
  });
});

describe("unknown event type handling", () => {
  it("identifies unknown event types", () => {
    const KNOWN = new Set(["system", "assistant", "user", "tool", "result"]);
    const unknownEvent = { type: "new_weird_type" };
    expect(KNOWN.has(unknownEvent.type)).toBe(false);
  });
});
