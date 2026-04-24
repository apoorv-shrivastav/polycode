import { describe, it, expect } from "vitest";
import { createAdapter } from "../../src/providers/index.js";

describe("provider registry", () => {
  it("creates claude-code adapter", () => {
    const adapter = createAdapter("claude-code");
    expect(adapter.id).toBe("claude-code");
  });

  it("creates codex adapter", () => {
    const adapter = createAdapter("codex");
    expect(adapter.id).toBe("codex");
  });

  it("creates gemini adapter", () => {
    const adapter = createAdapter("gemini");
    expect(adapter.id).toBe("gemini");
  });

  it("throws on unknown provider", () => {
    expect(() => createAdapter("unknown" as any)).toThrow("Unknown provider");
  });
});
