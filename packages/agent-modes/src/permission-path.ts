/**
 * permission-path — Plan 模式草稿路径判定（Phase 2 path-aware）
 *
 * 从工具入参解析出权限检查用的多路径集合：
 *   - 原路径 + symlink 链（最多 40 层）+ dangling symlink 祖先
 *   - Windows ADS / 8.3 / UNC 等可疑模式直接拒
 *
 * 仅当**所有**待检路径的扩展名均符合 plan 草稿（`.md` / `.canvas.tsx`）且
 * 解析后仍落在 workspace 内时 `isPlanDraftPath` 才返回 true。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SYMLINK_DEPTH = 40;

/** Plan / Study 模式允许 write_file / edit_file 的扩展名。 */
const PLAN_DRAFT_SUFFIXES = ['.md', '.canvas.tsx'] as const;

export type PathResolutionError = 'path_resolution_failed';

export interface PathsForPermissionCheckResult {
  paths: string[];
  resolutionError?: PathResolutionError;
}

export type PlanDraftPathDenyReason =
  | 'invalid_extension'
  | 'symlink_escape'
  | 'path_resolution_failed';

export type PlanDraftPathCheckResult =
  | { allowed: true }
  | { allowed: false; reason: PlanDraftPathDenyReason };

function expandTilde(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function isWindowsLikePlatform(): boolean {
  return process.platform === 'win32';
}

/**
 * 检测 Windows 特有路径绕过模式（ADS / 8.3 / UNC / long-path prefix 等）。
 * 检测可疑 Windows 路径模式（核心子集）。
 */
export function hasSuspiciousWindowsPathPattern(filePath: string): boolean {
  if (isWindowsLikePlatform()) {
    const colonIndex = filePath.indexOf(':', 2);
    if (colonIndex !== -1) {
      return true;
    }
  }

  if (/~\d/.test(filePath)) {
    return true;
  }

  if (
    filePath.startsWith('\\\\?\\') ||
    filePath.startsWith('\\\\.\\') ||
    filePath.startsWith('//?/') ||
    filePath.startsWith('//./')
  ) {
    return true;
  }

  if (/[.\s]+$/.test(filePath)) {
    return true;
  }

  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(filePath)) {
    return true;
  }

  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(filePath)) {
    return true;
  }

  // UNC paths — defense in depth on all platforms
  if (filePath.startsWith('\\\\') || filePath.startsWith('//')) {
    return true;
  }

  return false;
}

function resolveDeepestExistingAncestorSync(targetPath: string): string | undefined {
  let current = path.dirname(targetPath);
  const visited = new Set<string>();

  while (current && current !== path.dirname(current)) {
    if (visited.has(current)) break;
    visited.add(current);

    try {
      return fs.realpathSync(current);
    } catch {
      current = path.dirname(current);
    }
  }
  return undefined;
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

/** 解析后的 candidate 是否落在 workspaceRoot 内（含边界本身）。 */
export function isPathResolvedWithinWorkspace(
  candidatePath: string,
  workspaceRoot: string,
): boolean {
  const wsRoot = normalizeWorkspaceRoot(workspaceRoot);
  let resolvedCandidate: string;
  try {
    resolvedCandidate = fs.realpathSync(candidatePath);
  } catch {
    resolvedCandidate = path.resolve(candidatePath);
  }
  const rel = path.relative(wsRoot, resolvedCandidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function addSymlinkRewrittenPaths(normalized: string, pathSet: Set<string>): void {
  let dir = path.dirname(normalized);
  const dirsToCheck: string[] = [];
  while (dir && dir !== path.dirname(dir)) {
    dirsToCheck.unshift(dir);
    dir = path.dirname(dir);
  }
  for (const d of dirsToCheck) {
    try {
      const lst = fs.lstatSync(d);
      if (!lst.isSymbolicLink()) continue;
      const target = fs.readlinkSync(d);
      const linkTarget = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(d), target);
      pathSet.add(linkTarget);
      const suffix = path.relative(d, normalized);
      if (suffix && suffix !== '.') {
        pathSet.add(path.join(linkTarget, suffix));
      }
    } catch {
      break;
    }
  }
}

/**
 * 收集 path 的所有待检形态（原路径 + symlink 链 + realpath + dangling 祖先）。
 * fs 解析失败时 fail-closed：返回 `resolutionError: 'path_resolution_failed'`。
 */
export function getPathsForPermissionCheck(
  inputPath: string,
  workspaceRoot?: string,
): PathsForPermissionCheckResult {
  let normalized = expandTilde(inputPath.trim());
  if (!normalized) {
    return { paths: [] };
  }

  if (!path.isAbsolute(normalized) && workspaceRoot) {
    normalized = path.resolve(workspaceRoot, normalized);
  } else if (!path.isAbsolute(normalized)) {
    normalized = path.resolve(process.cwd(), normalized);
  }

  const pathSet = new Set<string>();
  pathSet.add(normalized);
  let resolutionError: PathResolutionError | undefined;

  if (normalized.startsWith('//') || normalized.startsWith('\\\\')) {
    return { paths: Array.from(pathSet) };
  }

  addSymlinkRewrittenPaths(normalized, pathSet);

  try {
    let currentPath = normalized;
    const visited = new Set<string>();

    for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
      if (visited.has(currentPath)) break;
      visited.add(currentPath);

      if (!fs.existsSync(currentPath)) {
        try {
          const lst = fs.lstatSync(currentPath);
          if (lst.isSymbolicLink()) {
            const target = fs.readlinkSync(currentPath);
            const absoluteTarget = path.isAbsolute(target)
              ? target
              : path.resolve(path.dirname(currentPath), target);
            pathSet.add(absoluteTarget);
            currentPath = absoluteTarget;
            continue;
          }
        } catch {
          // 目标文件尚不存在且非 symlink —— write_file 常见场景，非解析失败
        }
        if (currentPath === normalized) {
          const resolved = resolveDeepestExistingAncestorSync(currentPath);
          if (resolved !== undefined) {
            pathSet.add(resolved);
          }
        }
        break;
      }

      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(currentPath);
      } catch {
        resolutionError = 'path_resolution_failed';
        break;
      }

      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break;
      }

      if (!stats.isSymbolicLink()) {
        break;
      }

      try {
        const target = fs.readlinkSync(currentPath);
        const absoluteTarget = path.isAbsolute(target)
          ? target
          : path.resolve(path.dirname(currentPath), target);
        pathSet.add(absoluteTarget);
        currentPath = absoluteTarget;
      } catch {
        resolutionError = 'path_resolution_failed';
        break;
      }
    }
  } catch {
    resolutionError = 'path_resolution_failed';
  }

  try {
    const real = fs.realpathSync(normalized);
    if (real !== normalized) {
      pathSet.add(real);
    }
  } catch {
    // new file / dangling — already handled above
  }

  return {
    paths: Array.from(pathSet),
    ...(resolutionError ? { resolutionError } : {}),
  };
}

/** 从路径字符串提取扩展名（小写）；`.canvas.tsx` 优先于 `.tsx`。 */
export function getPlanDraftPathExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.canvas.tsx')) {
    return '.canvas.tsx';
  }
  const ext = path.extname(lower);
  return ext;
}

/** 单条路径（已 canonical 形态）是否为允许的 plan 草稿扩展名。 */
export function isAllowedPlanDraftExtension(filePath: string): boolean {
  const ext = getPlanDraftPathExtension(filePath);
  return (PLAN_DRAFT_SUFFIXES as readonly string[]).includes(ext);
}

function normalizeInputPath(inputPath: string, workspaceRoot?: string): string {
  let normalized = expandTilde(inputPath.trim());
  if (!path.isAbsolute(normalized) && workspaceRoot) {
    normalized = path.resolve(workspaceRoot, normalized);
  } else if (!path.isAbsolute(normalized)) {
    normalized = path.resolve(process.cwd(), normalized);
  }
  return normalized;
}

/**
 * 结构化 plan 草稿路径判定（供 guard 区分 deny 原因）。
 */
export function checkPlanDraftPath(
  filePath: string | undefined | null,
  workspaceRoot?: string,
): PlanDraftPathCheckResult {
  if (filePath == null) return { allowed: false, reason: 'invalid_extension' };
  const trimmed = String(filePath).trim();
  if (trimmed.length === 0) return { allowed: false, reason: 'invalid_extension' };

  if (hasSuspiciousWindowsPathPattern(trimmed)) {
    return { allowed: false, reason: 'invalid_extension' };
  }

  const primary = normalizeInputPath(trimmed, workspaceRoot);
  if (!isAllowedPlanDraftExtension(primary)) {
    return { allowed: false, reason: 'invalid_extension' };
  }

  const { paths: pathsToCheck, resolutionError } = getPathsForPermissionCheck(trimmed, workspaceRoot);
  if (resolutionError) {
    return { allowed: false, reason: 'path_resolution_failed' };
  }

  if (workspaceRoot) {
    const wsNorm = normalizeWorkspaceRoot(workspaceRoot);
    const primaryResolved = path.resolve(primary);
    const pathIsWorkspaceScoped =
      !path.isAbsolute(trimmed) ||
      primaryResolved === wsNorm ||
      primaryResolved.startsWith(`${wsNorm}${path.sep}`);
    if (pathIsWorkspaceScoped) {
      for (const candidate of pathsToCheck) {
        if (!isPathResolvedWithinWorkspace(candidate, workspaceRoot)) {
          return { allowed: false, reason: 'symlink_escape' };
        }
      }
    }
  }

  for (const candidate of pathsToCheck) {
    if (candidate === primary) continue;
    const base = path.basename(candidate);
    // dangling symlink 祖先解析会落到目录 —— 不参与扩展名判定
    if (!base.includes('.')) continue;
    if (!isAllowedPlanDraftExtension(candidate)) {
      return { allowed: false, reason: 'invalid_extension' };
    }
  }

  return { allowed: true };
}

/**
 * Plan / Study 模式下 write_file / edit_file 的 path 是否为允许的草稿路径。
 */
export function isPlanDraftPath(filePath: string | undefined | null, workspaceRoot?: string): boolean {
  return checkPlanDraftPath(filePath, workspaceRoot).allowed;
}
