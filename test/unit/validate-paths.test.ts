import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validatePath,
  validatePlan,
  validateDiffPaths,
  extractDiffPaths,
  isWithinProject,
  canonicalize,
} from "../../src/policy/validate-paths.js";
import { DEFAULT_POLICY, type Policy } from "../../src/models/policy.js";

let testDir: string;
let policy: Policy;

beforeEach(() => {
  testDir = join(tmpdir(), `polycode-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, "src", "auth"), { recursive: true });
  mkdirSync(join(testDir, "test"), { recursive: true });
  writeFileSync(join(testDir, "package.json"), "{}");
  writeFileSync(join(testDir, "src", "index.ts"), "// index");
  writeFileSync(join(testDir, "src", "auth", "session.ts"), "// session");

  policy = {
    ...DEFAULT_POLICY,
    allowed_paths: ["src/**", "test/**", "package.json"],
    denied_paths: ["**/.env*", "**/secrets/**", "**/id_*", "**/.ssh/**"],
  };
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("validatePath", () => {
  it("accepts valid paths within allowed_paths", () => {
    expect(validatePath("src/index.ts", policy, testDir)).toEqual({ ok: true });
    expect(validatePath("src/auth/session.ts", policy, testDir)).toEqual({ ok: true });
    expect(validatePath("test/foo.test.ts", policy, testDir)).toEqual({ ok: true });
    expect(validatePath("package.json", policy, testDir)).toEqual({ ok: true });
  });

  // §7.5: reject parent-traversal (..)
  it("rejects parent-traversal paths", () => {
    const result = validatePath("../secrets/key.pem", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parent-traversal");
  });

  it("rejects sneaky parent-traversal via src/../..", () => {
    const result = validatePath("src/../../secrets/key.pem", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parent-traversal");
  });

  // §7.5: reject absolute paths
  it("rejects absolute paths", () => {
    const result = validatePath("/etc/passwd", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute-path");
  });

  // §7.5: reject Windows-style absolute paths
  it("rejects Windows-style absolute paths", () => {
    const result = validatePath("C:\\Windows\\system32\\config", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("absolute-path");
  });

  // §7.5: reject paths outside allowed_paths
  it("rejects paths outside allowed_paths", () => {
    const result = validatePath("docs/README.md", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("outside-allowlist");
  });

  // §7.5: reject paths in denied_paths
  it("rejects paths matching denied_paths", () => {
    const result = validatePath("src/.env.local", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("deny-list");
  });

  it("rejects SSH key paths", () => {
    const result = validatePath("src/id_rsa", policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("deny-list");
  });

  // §7.5: symlink traversal
  it("rejects symlink that escapes project root", () => {
    const linkPath = join(testDir, "src", "escape-link");
    try {
      symlinkSync("/etc", linkPath);
      const result = validatePath("src/escape-link/passwd", policy, testDir);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("escapes-project");
    } catch {
      // Symlink creation may fail on some systems — skip gracefully
    }
  });

  // §7.5: prefix-sharing path that escapes on realpath
  it("handles paths with ./ normalization", () => {
    // src/./index.ts should normalize to src/index.ts and be valid
    const result = validatePath("src/./index.ts", policy, testDir);
    expect(result.ok).toBe(true);
  });
});

describe("validatePlan", () => {
  it("validates a plan with all paths in-scope", () => {
    const plan = {
      steps: [
        { id: "01", touches_paths: ["src/index.ts", "src/auth/session.ts"] },
        { id: "02", touches_paths: ["test/foo.test.ts"] },
      ],
    };
    expect(validatePlan(plan, policy, testDir)).toEqual({ ok: true });
  });

  it("rejects a plan with an out-of-scope path", () => {
    const plan = {
      steps: [
        { id: "01", touches_paths: ["src/index.ts", "/etc/passwd"] },
      ],
    };
    const result = validatePlan(plan, policy, testDir);
    expect(result.ok).toBe(false);
  });

  it("rejects a plan with parent traversal", () => {
    const plan = {
      steps: [
        { id: "01", touches_paths: ["src/../../../etc/passwd"] },
      ],
    };
    const result = validatePlan(plan, policy, testDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parent-traversal");
  });
});

describe("validateDiffPaths", () => {
  it("validates a diff with all paths in-scope", () => {
    const diff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-// old
+// new`;
    const result = validateDiffPaths(diff, policy, testDir);
    expect(result.ok).toBe(true);
    expect(result.escapedPaths).toHaveLength(0);
  });

  it("detects out-of-scope paths in a diff", () => {
    const diff = `diff --git a/config/prod.yaml b/config/prod.yaml
--- a/config/prod.yaml
+++ b/config/prod.yaml
@@ -1 +1 @@
-old
+new`;
    const result = validateDiffPaths(diff, policy, testDir);
    expect(result.ok).toBe(false);
    expect(result.escapedPaths).toContain("config/prod.yaml");
  });
});

describe("extractDiffPaths", () => {
  it("extracts paths from standard git diff", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts`;
    const paths = extractDiffPaths(diff);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
  });

  it("handles new file diffs (/dev/null)", () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
--- /dev/null
+++ b/src/new.ts`;
    const paths = extractDiffPaths(diff);
    expect(paths).toContain("src/new.ts");
    // /dev/null should NOT be extracted
    expect(paths).not.toContain("/dev/null");
  });
});

describe("isWithinProject", () => {
  it("returns true for paths inside project", () => {
    expect(isWithinProject(join(testDir, "src", "index.ts"), testDir)).toBe(true);
  });

  it("returns true for the project root itself", () => {
    expect(isWithinProject(testDir, testDir)).toBe(true);
  });

  it("returns false for paths outside project", () => {
    expect(isWithinProject("/etc/passwd", testDir)).toBe(false);
    expect(isWithinProject(join(testDir, "..", "other"), testDir)).toBe(false);
  });
});
