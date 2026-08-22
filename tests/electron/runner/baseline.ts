import fs from "node:fs/promises";
import path from "node:path";
import type { BaselineDiff, BaselineSnapshot } from "./types";
import { toRepoRelative } from "./paths";

export function baselinePath(repoRoot: string, scenarioId: string): string {
  return path.join(repoRoot, "tests", "electron", "baselines", `${scenarioId}.baseline.json`);
}

export async function compareOrUpdateBaseline(
  repoRoot: string,
  snapshot: BaselineSnapshot | null,
  update: boolean
): Promise<BaselineDiff> {
  if (!snapshot) return { status: "not-collected" };

  const target = baselinePath(repoRoot, snapshot.scenarioId);
  const relativeTarget = toRepoRelative(repoRoot, target);

  if (update) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    return { status: "updated", baselinePath: relativeTarget };
  }

  const existing = await readExistingBaseline(target);
  if (!existing) {
    return { status: "missing", baselinePath: relativeTarget };
  }

  const changes = diffJson(existing, snapshot);
  if (changes.length === 0) {
    return { status: "matched", baselinePath: relativeTarget };
  }
  return { status: "changed", baselinePath: relativeTarget, changes };
}

async function readExistingBaseline(target: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function diffJson(
  expected: unknown,
  actual: unknown,
  prefix = "$"
): NonNullable<BaselineDiff["changes"]> {
  if (Object.is(expected, actual)) return [];
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [{ path: prefix, expected, actual }];
    }
    const changes: NonNullable<BaselineDiff["changes"]> = [];
    const maxLength = Math.max(expected.length, actual.length);
    for (let index = 0; index < maxLength; index += 1) {
      changes.push(...diffJson(expected[index], actual[index], `${prefix}[${index}]`));
    }
    return changes;
  }
  if (!isRecord(expected) || !isRecord(actual)) {
    return [{ path: prefix, expected, actual }];
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const changes: NonNullable<BaselineDiff["changes"]> = [];
  for (const key of [...keys].sort()) {
    changes.push(...diffJson(expected[key], actual[key], `${prefix}.${key}`));
  }
  return changes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
