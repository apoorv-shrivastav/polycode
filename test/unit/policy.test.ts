import { describe, it, expect } from "vitest";
import {
  policyToClaudeFlags,
  isPathInAllowlist,
  isBashCommandAllowed,
  redactSecrets,
} from "../../src/policy/engine.js";
import { DEFAULT_POLICY } from "../../src/models/policy.js";

describe("policyToClaudeFlags", () => {
  it("generates budget flag", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "implementer");
    expect(flags).toContain("--max-budget-usd");
    expect(flags[flags.indexOf("--max-budget-usd") + 1]).toBe("2.5");
  });

  it("uses per-role tool allowlist for planner (read-only)", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "planner");
    const toolIdx = flags.indexOf("--allowedTools");
    expect(toolIdx).toBeGreaterThan(-1);
    const tools = flags[toolIdx + 1].split(",");
    expect(tools).toContain("Read");
    expect(tools).toContain("Grep");
    expect(tools).toContain("Glob");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Bash");
  });

  it("uses per-role tool allowlist for implementer", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "implementer");
    const toolIdx = flags.indexOf("--allowedTools");
    const tools = flags[toolIdx + 1].split(",");
    expect(tools).toContain("Read");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
    // Bash is default-off in DEFAULT_POLICY
    expect(tools).not.toContain("Bash");
  });

  it("uses per-role tool allowlist for reviewer (read-only)", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "reviewer");
    const toolIdx = flags.indexOf("--allowedTools");
    const tools = flags[toolIdx + 1].split(",");
    expect(tools).toEqual(["Read"]);
  });

  it("adds --bare for reviewer role", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "reviewer");
    expect(flags).toContain("--bare");
  });

  it("does not add --bare for implementer or planner", () => {
    expect(policyToClaudeFlags(DEFAULT_POLICY, "implementer")).not.toContain("--bare");
    expect(policyToClaudeFlags(DEFAULT_POLICY, "planner")).not.toContain("--bare");
  });

  it("adds --disallowedTools for network deny mode", () => {
    const flags = policyToClaudeFlags(DEFAULT_POLICY, "implementer");
    expect(flags).toContain("--disallowedTools");
    const idx = flags.indexOf("--disallowedTools");
    expect(flags[idx + 1]).toBe("WebFetch,WebSearch");
  });

  describe("bash gating", () => {
    const bashPolicy = {
      ...DEFAULT_POLICY,
      bash_enabled: true,
      allowed_bash_prefixes: ["npm test", "npm run"],
    };

    it("does NOT give bash to planner even when bash_enabled", () => {
      const flags = policyToClaudeFlags(bashPolicy, "planner", { enableBash: true });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).not.toContain("Bash");
    });

    it("does NOT give bash to reviewer even when bash_enabled", () => {
      const flags = policyToClaudeFlags(bashPolicy, "reviewer", { enableBash: true });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).not.toContain("Bash");
    });

    it("gives bash to implementer only when BOTH bash_enabled AND enableBash CLI flag", () => {
      // Both on
      const flags = policyToClaudeFlags(bashPolicy, "implementer", { enableBash: true });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).toContain("Bash");
    });

    it("does NOT give bash when policy.bash_enabled but no --enable-bash flag", () => {
      const flags = policyToClaudeFlags(bashPolicy, "implementer", { enableBash: false });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).not.toContain("Bash");
    });

    it("does NOT give bash when --enable-bash but policy.bash_enabled is false", () => {
      const flags = policyToClaudeFlags(DEFAULT_POLICY, "implementer", { enableBash: true });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).not.toContain("Bash");
    });

    it("does NOT give bash when bash_enabled but allowed_bash_prefixes is empty", () => {
      const emptyPrefixPolicy = { ...bashPolicy, allowed_bash_prefixes: [] };
      const flags = policyToClaudeFlags(emptyPrefixPolicy, "implementer", { enableBash: true });
      const toolIdx = flags.indexOf("--allowedTools");
      const tools = flags[toolIdx + 1].split(",");
      expect(tools).not.toContain("Bash");
    });
  });
});

describe("isPathInAllowlist", () => {
  const policy = {
    ...DEFAULT_POLICY,
    allowed_paths: ["src/**", "test/**", "package.json"],
    denied_paths: ["**/.env*", "**/secrets/**", "**/id_*", "**/.ssh/**"],
  };

  it("allows paths matching allowed_paths", () => {
    expect(isPathInAllowlist("src/index.ts", policy)).toBe(true);
    expect(isPathInAllowlist("test/unit/foo.test.ts", policy)).toBe(true);
    expect(isPathInAllowlist("package.json", policy)).toBe(true);
  });

  it("denies paths not in allowed_paths", () => {
    expect(isPathInAllowlist("docs/README.md", policy)).toBe(false);
  });

  it("denied_paths takes priority over allowed_paths", () => {
    expect(isPathInAllowlist("src/.env.local", policy)).toBe(false);
    expect(isPathInAllowlist("src/secrets/key.pem", policy)).toBe(false);
  });

  it("denies SSH keys per v0.2 denied_paths", () => {
    expect(isPathInAllowlist("src/id_rsa", policy)).toBe(false);
    expect(isPathInAllowlist(".ssh/config", policy)).toBe(false);
  });
});

describe("isBashCommandAllowed", () => {
  const bashPolicy = {
    ...DEFAULT_POLICY,
    bash_enabled: true,
    allowed_bash_prefixes: ["npm test", "npm run", "git diff", "git status"],
  };

  it("returns false when bash_enabled is false", () => {
    expect(isBashCommandAllowed("npm test", DEFAULT_POLICY)).toBe(false);
  });

  it("matches allowed prefixes with word boundary", () => {
    expect(isBashCommandAllowed("npm test", bashPolicy)).toBe(true);
    expect(isBashCommandAllowed("npm test -- auth", bashPolicy)).toBe(true);
    expect(isBashCommandAllowed("npm run build", bashPolicy)).toBe(true);
    expect(isBashCommandAllowed("git diff HEAD", bashPolicy)).toBe(true);
  });

  it("rejects commands that are prefix-matches but not word-boundary matches", () => {
    // "npm test" should NOT match "npm test-rogue-script"
    expect(isBashCommandAllowed("npm test-rogue-script", bashPolicy)).toBe(false);
  });

  it("rejects disallowed commands", () => {
    expect(isBashCommandAllowed("rm -rf /", bashPolicy)).toBe(false);
    expect(isBashCommandAllowed("curl evil.com", bashPolicy)).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("redacts API keys", () => {
    const text = "ANTHROPIC_API_KEY=sk-ant-123 and OPENAI_API_KEY=sk-456";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("sk-ant-123");
    expect(redacted).not.toContain("sk-456");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const text = "Bearer mytoken123";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("mytoken123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts Authorization headers", () => {
    const text = "Authorization: Bearer mytoken123";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("mytoken123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("leaves non-secret text unchanged", () => {
    const text = "Just a normal log message";
    expect(redactSecrets(text)).toBe(text);
  });
});
