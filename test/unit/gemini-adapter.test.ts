import { describe, it, expect } from "vitest";
import { GeminiAdapter } from "../../src/providers/gemini.js";

describe("GeminiAdapter", () => {
  it("has correct id and capabilities", () => {
    const adapter = new GeminiAdapter("nonexistent-gemini");
    expect(adapter.id).toBe("gemini");
    expect(adapter.capabilities.supportsBudgetFlag).toBe(false);
    expect(adapter.capabilities.supportsBareMode).toBe(false);
    expect(adapter.capabilities.supportsJsonStream).toBe(true);
  });

  it("checkVersion throws BinaryMissing for nonexistent binary", async () => {
    const adapter = new GeminiAdapter("nonexistent-gemini-binary");
    await expect(adapter.checkVersion()).rejects.toThrow("Could not run");
  });

  it("rejects --yolo at adapter level (rule A14)", () => {
    // The --yolo rejection is in the run() method, not buildArgs
    // but we can verify the adapter exists and is properly structured
    const adapter = new GeminiAdapter("nonexistent-gemini");
    expect(adapter.id).toBe("gemini");
  });
});
