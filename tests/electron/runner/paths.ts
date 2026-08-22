import fs from "node:fs";
import path from "node:path";

export function resolveRepoRoot(): string {
  let current = process.cwd();
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (fs.existsSync(packageJsonPath)) return current;

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to resolve repository root from current working directory.");
    }
    current = parent;
  }
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

export function toRepoRelative(repoRoot: string, filePath: string): string {
  return toPosixPath(path.relative(repoRoot, filePath));
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function createRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(".", "").replace("Z", "Z");
  const suffix = Math.random().toString(36).slice(2, 7);
  return `e2e-${stamp}-${suffix}`;
}
