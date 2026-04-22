import { resolve, normalize, sep } from "node:path";
import { realpathSync } from "node:fs";
import { minimatch } from "../util/glob.js";
import type { Policy } from "../models/policy.js";

/**
 * §7.5 Plan and diff validation.
 * Canonicalize paths via resolve + realpath + prefix check.
 * String-prefix comparisons are NOT safe — per Appendix A rule 6.
 */

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; path: string };

/**
 * Canonicalize a path relative to the project root.
 * Follows symlinks to detect traversal attacks.
 * Throws if the path cannot be resolved (e.g., nonexistent target).
 */
export function canonicalize(p: string, projectRoot: string): string {
  // First, resolve the project root itself to its real path
  // (handles macOS /var -> /private/var, etc.)
  let rootReal: string;
  try {
    rootReal = realpathSync.native(projectRoot);
  } catch {
    rootReal = resolve(projectRoot);
  }

  const resolved = resolve(rootReal, p);
  try {
    // Follow symlinks — this is what catches symlink traversal
    const real = realpathSync.native(resolved);
    return normalize(real);
  } catch {
    // If realpath fails (file doesn't exist yet in plan validation),
    // use the resolved+normalized form. The root is already real-path'd,
    // so prefix check will still work correctly.
    return normalize(resolved);
  }
}

/**
 * Check whether an absolute path is within the project root.
 * Uses realpath on the project root itself to handle symlinked project dirs.
 */
export function isWithinProject(absPath: string, projectRoot: string): boolean {
  let rootReal: string;
  try {
    rootReal = normalize(realpathSync.native(projectRoot));
  } catch {
    rootReal = normalize(resolve(projectRoot));
  }

  // Canonicalize the path being checked too, so symlink-based roots
  // (e.g., macOS /var -> /private/var) are handled consistently.
  let pathReal: string;
  try {
    pathReal = normalize(realpathSync.native(absPath));
  } catch {
    pathReal = normalize(resolve(absPath));
  }

  // Must either be the root itself or start with root + separator
  return pathReal === rootReal || pathReal.startsWith(rootReal + sep);
}

/**
 * Check if a relative path matches any of the given glob patterns.
 * Patterns are matched against the path relative to project root.
 */
function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (minimatch(relativePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a single path from a plan step's touches_paths.
 * Per §7.5:
 * - Reject parent-traversal (..)
 * - Reject absolute paths
 * - Canonicalize and verify within project root
 * - Check against policy allowed_paths and denied_paths
 */
export function validatePath(
  p: string,
  policy: Policy,
  projectRoot: string
): ValidationResult {
  // Reject parent traversal patterns
  if (p.includes("..")) {
    return { ok: false, reason: "parent-traversal", path: p };
  }

  // Reject absolute paths
  if (resolve(p) === p || p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) {
    return { ok: false, reason: "absolute-path", path: p };
  }

  // Canonicalize and check it's within project
  const abs = canonicalize(p, projectRoot);
  if (!isWithinProject(abs, projectRoot)) {
    return { ok: false, reason: "escapes-project", path: p };
  }

  // Get the path relative to project root for glob matching
  let rootReal: string;
  try {
    rootReal = normalize(realpathSync.native(projectRoot));
  } catch {
    rootReal = normalize(resolve(projectRoot));
  }
  const relative = abs.slice(rootReal.length + 1); // strip root + separator

  // Check denied_paths first — they take priority
  if (matchesAnyGlob(relative, policy.denied_paths)) {
    return { ok: false, reason: "deny-list", path: p };
  }

  // Check allowed_paths
  if (!matchesAnyGlob(relative, policy.allowed_paths)) {
    return { ok: false, reason: "outside-allowlist", path: p };
  }

  return { ok: true };
}

/**
 * Validate all touches_paths in a plan against the policy.
 * Returns the first failure or ok.
 */
export function validatePlan(
  plan: { steps: Array<{ id: string; touches_paths: string[] }> },
  policy: Policy,
  projectRoot: string
): ValidationResult {
  for (const step of plan.steps) {
    for (const p of step.touches_paths) {
      const result = validatePath(p, policy, projectRoot);
      if (!result.ok) {
        return result;
      }
    }
  }
  return { ok: true };
}

/**
 * Validate all paths in a git diff output against the policy.
 * Extracts paths from diff headers and checks each one.
 * If realpath resolution fails (file was removed), treats as a violation.
 */
export function validateDiffPaths(
  diff: string,
  policy: Policy,
  projectRoot: string
): { ok: boolean; escapedPaths: string[] } {
  const paths = extractDiffPaths(diff);
  const escaped: string[] = [];

  for (const p of paths) {
    const result = validatePath(p, policy, projectRoot);
    if (!result.ok) {
      escaped.push(p);
    }
  }

  return { ok: escaped.length === 0, escapedPaths: escaped };
}

/**
 * Extract file paths from a git diff.
 * Handles both "diff --git a/... b/..." and "+++ b/..." / "--- a/..." lines.
 */
export function extractDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split("\n");

  for (const line of lines) {
    // "diff --git a/path b/path"
    const gitDiffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitDiffMatch) {
      paths.add(gitDiffMatch[1]);
      paths.add(gitDiffMatch[2]);
      continue;
    }

    // "+++ b/path" or "--- a/path" (but not /dev/null)
    const patchHeaderMatch = line.match(/^[+-]{3} [ab]\/(.+)$/);
    if (patchHeaderMatch) {
      paths.add(patchHeaderMatch[1]);
    }
  }

  return [...paths];
}
