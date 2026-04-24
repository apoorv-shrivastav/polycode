import { describe, it, expect } from "vitest";
import { CodexAdapter } from "../../src/providers/codex.js";

describe("CodexAdapter", () => {
  it("has correct id and capabilities", () => {
    const adapter = new CodexAdapter("nonexistent-codex");
    expect(adapter.id).toBe("codex");
    expect(adapter.capabilities.supportsBudgetFlag).toBe(false);
    expect(adapter.capabilities.supportsBareMode).toBe(true);
    expect(adapter.capabilities.supportsJsonStream).toBe(true);
  });

  it("checkVersion throws BinaryMissing for nonexistent binary", async () => {
    const adapter = new CodexAdapter("nonexistent-codex-binary");
    await expect(adapter.checkVersion()).rejects.toThrow("Could not run");
  });
});
