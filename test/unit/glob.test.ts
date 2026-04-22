import { describe, it, expect } from "vitest";
import { minimatch } from "../../src/util/glob.js";

describe("minimatch", () => {
  it("matches exact filenames", () => {
    expect(minimatch("package.json", "package.json")).toBe(true);
    expect(minimatch("package.json", "tsconfig.json")).toBe(false);
  });

  it("matches single-star wildcards", () => {
    expect(minimatch("src/index.ts", "src/*.ts")).toBe(true);
    expect(minimatch("src/index.js", "src/*.ts")).toBe(false);
    // Single star does NOT match across path separators
    expect(minimatch("src/deep/index.ts", "src/*.ts")).toBe(false);
  });

  it("matches double-star globstar", () => {
    expect(minimatch("src/deep/nested/file.ts", "src/**")).toBe(true);
    expect(minimatch("src/index.ts", "src/**")).toBe(true);
  });

  it("matches double-star with trailing pattern", () => {
    expect(minimatch("src/deep/file.ts", "src/**/*.ts")).toBe(true);
    expect(minimatch("src/file.ts", "src/**/*.ts")).toBe(true);
    expect(minimatch("src/file.js", "src/**/*.ts")).toBe(false);
  });

  it("matches dot-prefixed files", () => {
    expect(minimatch(".env", "**/.env*")).toBe(true);
    expect(minimatch("src/.env.local", "**/.env*")).toBe(true);
  });

  it("matches secrets directory pattern", () => {
    expect(minimatch("src/secrets/key.pem", "**/secrets/**")).toBe(true);
    expect(minimatch("secrets/api.key", "**/secrets/**")).toBe(true);
  });

  it("handles question mark wildcards", () => {
    expect(minimatch("file1.ts", "file?.ts")).toBe(true);
    expect(minimatch("file12.ts", "file?.ts")).toBe(false);
  });
});
