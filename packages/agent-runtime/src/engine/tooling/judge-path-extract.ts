/**
 * ：file 类工具审批路径提取。
 *
 * judge 只消费已按 Workspace 根收口的路径。相对路径与「省略目录」
 * 在这里对齐执行层：base = workspaceRoot，而不是 process.cwd()。
 */

import path from 'node:path';

interface JudgePathToolMeta {
  extractPath?: (input: unknown) => string | readonly string[] | undefined;
  extractPolicyParams?: (input: unknown) => Record<string, unknown>;
  policyActionKind?: string;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return arr.length > 0 ? arr : undefined;
}

function asPathList(value: string | readonly string[] | undefined): string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return [];
}

function extractDefaultJudgePath(input: unknown): string | string[] | undefined {
  const inp = input as Record<string, unknown>;
  const single = (inp.file_path ?? inp.path ?? inp.cwd) as string | undefined;
  if (typeof single === 'string' && single.length > 0) return single;
  return (
    nonEmptyStringArray(inp.target_directories) ??
    firstNonEmptyString(inp.target_directory) ??
    nonEmptyStringArray(inp.paths)
  );
}

function collectRawJudgePaths(
  tool: JudgePathToolMeta,
  input: unknown,
): string | readonly string[] | undefined {
  if (typeof tool.extractPath === 'function') {
    return tool.extractPath(input);
  }
  if (typeof tool.extractPolicyParams === 'function') {
    const params = tool.extractPolicyParams(input) as Record<string, unknown>;
    return (params.file_path as string | undefined) ?? (params.path as string | undefined);
  }
  return extractDefaultJudgePath(input);
}

function resolveAgainstWorkspace(rawPath: string, workspaceRoot: string): string {
  const cleaned = rawPath.trim();
  if (!cleaned) return cleaned;
  if (path.isAbsolute(cleaned) || cleaned.startsWith('~')) return cleaned;
  return path.resolve(workspaceRoot, cleaned);
}

/**
 * file 类必须能抽出至少一条路径：工具自报、默认字段，或省略目录时回落到 workspaceRoot。
 */
export function extractJudgePath(
  tool: JudgePathToolMeta,
  input: unknown,
  workspaceRoot: string | undefined,
): string | string[] | undefined {
  const rawList = asPathList(collectRawJudgePaths(tool, input));
  const hasRoot = typeof workspaceRoot === 'string' && workspaceRoot.length > 0;
  if (rawList.length === 0) {
    return tool.policyActionKind === 'file' && hasRoot ? workspaceRoot : undefined;
  }
  if (!hasRoot) {
    return rawList.length === 1 ? rawList[0] : rawList;
  }
  const resolved = rawList.map((item) => resolveAgainstWorkspace(item, workspaceRoot));
  return resolved.length === 1 ? resolved[0] : resolved;
}
