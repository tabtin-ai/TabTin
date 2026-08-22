/**
 * run_terminal_command · workspace 文件回退 best-effort 追踪（ / W2-5-C）。
 *
 * 语义：`trackEdit` 必须在改盘**前**备份「改之前」内容。因此对 shell 命令：
 *   1. spawn 前对 workspace 做 mtime/size 轻量扫描；
 *   2. 对扫描到的**已存在**文件逐个 pre-track（`trackEdit`）—— 保证 modified/deleted 可回退；
 *   3. spawn 后再扫描 + diff，统计新建文件（pre-track 覆盖不到）与扫描护栏触发项；
 *   4. 把结果写入 tool_result envelope 的 `file_history` 字段（renderer 将来聚合展示）。
 *
 * 性能护栏：目录排除、深度上限、文件数上限；触发时 fail-soft 降级为 metadata 标注，不阻断命令。
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  FileHistorySink,
} from '../../engine/contracts/tools.js';

/** workspace 扫描：最多遍历的普通文件数（含 pre-track 上限）。 */
export const SHELL_FILE_HISTORY_MAX_SCAN_FILES = 500;

/** workspace 扫描：相对 workspace 根的最大目录深度。 */
export const SHELL_FILE_HISTORY_MAX_DEPTH = 12;

/**
 * envelope 中 created_paths / modified_paths 各自最多携带的路径条数。
 * 仅防 tool_result 膨胀（构建/解压类命令可能触碰大量文件），非产品语义；
 * 超限截断并置 paths_truncated。
 */
export const SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS = 50;

/** 默认排除的目录名（任意深度段命中即跳过该 subtree）。 */
export const SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  '.jj',
  '.sl',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  'target',
  '.pnpm-store',
  '.tabtin',
]);

export interface WorkspaceFileFingerprint {
  mtimeMs: number;
  size: number;
}

export type WorkspaceFileSnapshot = Map<string, WorkspaceFileFingerprint>;

export interface WorkspaceScanResult {
  snapshot: WorkspaceFileSnapshot;
  scannedFiles: number;
  scanTruncated: boolean;
  scanFailed: boolean;
}

export type WorkspaceFileChangeKind = 'modified' | 'created' | 'deleted';

export interface WorkspaceFileChange {
  absPath: string;
  kind: WorkspaceFileChangeKind;
}

export interface ShellFileHistoryPreTrackResult {
  trackedCount: number;
  trackFailedCount: number;
  scanTruncated: boolean;
  scanFailed: boolean;
  skippedReason?: 'no_workspace' | 'no_anchor' | 'no_file_history';
}

/** per-tool-call envelope 字段；renderer 可按 run 聚合 `degraded === true`。 */
export interface ShellFileHistoryEnvelope {
  status: 'complete' | 'degraded' | 'deferred' | 'skipped';
  tracked_count: number;
  changed_count: number;
  created_untracked_count: number;
  deleted_count: number;
  modified_count: number;
  /**
   * 本命令新建 / 修改的文件（workspace 相对路径，POSIX 分隔）。
   * renderer 轮末「本轮产物」收集卡据此聚合终端命令产出的文件；
   * LLM 投影不透传（file_history 整体对模型隐藏）。
   */
  created_paths?: string[];
  modified_paths?: string[];
  /**
   * 本命令删除的文件（workspace 相对路径，POSIX 分隔）。
   * renderer 轮末聚合时据此把「本轮建了又删」的中间产物净算掉——只保留轮末仍
   * 存在的文件进「本轮产物」卡。
   */
  deleted_paths?: string[];
  /** created_paths / modified_paths / deleted_paths 任一因超出条数上限被截断时为 true。 */
  paths_truncated?: boolean;
  scan_truncated: boolean;
  scan_failed: boolean;
  track_failed_count: number;
  /** 任一为 true 时 renderer 应提示「本轮 shell 回退可能不完整」。 */
  degraded: boolean;
  degraded_reason?:
    | 'scan_limit'
    | 'scan_failed'
    | 'created_files'
    | 'track_failures'
    | 'background_deferred'
    | 'no_file_history'
    | 'no_anchor'
    | 'no_workspace';
}

export interface ShellFileHistoryPrepareResult {
  preSnapshot: WorkspaceFileSnapshot | undefined;
  preTrack: ShellFileHistoryPreTrackResult;
}

/** 同一轮内 shell workspace baseline 复用的最多条目数，防止长生命周期 runtime 无界增长。 */
export const SHELL_FILE_HISTORY_TURN_BASELINE_CACHE_MAX_ENTRIES = 64;

interface ShellFileHistoryTurnBaselineCacheEntry {
  key: string;
  preSnapshot: WorkspaceFileSnapshot;
  preTrack: ShellFileHistoryPreTrackResult;
}

const shellFileHistoryTurnBaselineCache = new WeakMap<
  FileHistorySink,
  Map<string, ShellFileHistoryTurnBaselineCacheEntry>
>();

function isExcludedDirName(name: string): boolean {
  return SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES.has(name);
}

/**
 * 轻量 workspace 扫描：只 stat 普通文件，收集 mtimeMs + size。
 * 遇上限提前停止并置 `scanTruncated`；单文件 stat 失败跳过（不 fail 整次扫描）。
 */
export async function scanWorkspaceFiles(
  workspaceRoot: string | undefined,
  options?: {
    maxFiles?: number;
    maxDepth?: number;
    excludedDirNames?: ReadonlySet<string>;
  },
): Promise<WorkspaceScanResult> {
  const maxFiles = options?.maxFiles ?? SHELL_FILE_HISTORY_MAX_SCAN_FILES;
  const maxDepth = options?.maxDepth ?? SHELL_FILE_HISTORY_MAX_DEPTH;
  const excluded = options?.excludedDirNames ?? SHELL_FILE_HISTORY_EXCLUDED_DIR_NAMES;

  const snapshot: WorkspaceFileSnapshot = new Map();
  if (!workspaceRoot) {
    return { snapshot, scannedFiles: 0, scanTruncated: false, scanFailed: true };
  }

  let root: string;
  try {
    root = path.resolve(workspaceRoot);
  } catch {
    return { snapshot, scannedFiles: 0, scanTruncated: false, scanFailed: true };
  }

  let scanTruncated = false;
  let scanFailed = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (scanTruncated || snapshot.size >= maxFiles) return;
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanTruncated || snapshot.size >= maxFiles) break;

      const name = entry.name;
      if (entry.isDirectory()) {
        if (isExcludedDirName(name) || excluded.has(name)) continue;
        await walk(path.join(dir, name), depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const absPath = path.resolve(path.join(dir, name));
      try {
        const st = await stat(absPath);
        if (!st.isFile()) continue;
        snapshot.set(absPath, {
          mtimeMs: Math.floor(st.mtimeMs),
          size: st.size,
        });
        if (snapshot.size >= maxFiles) {
          scanTruncated = true;
        }
      } catch {
        // 单文件失败跳过
      }
    }
  };

  try {
    await walk(root, 0);
  } catch {
    scanFailed = true;
  }

  return {
    snapshot,
    scannedFiles: snapshot.size,
    scanTruncated,
    scanFailed,
  };
}

/** 对比两次扫描快照，找出 modified / created / deleted。 */
export function diffWorkspaceSnapshots(
  before: WorkspaceFileSnapshot,
  after: WorkspaceFileSnapshot,
): WorkspaceFileChange[] {
  const changes: WorkspaceFileChange[] = [];

  for (const [absPath, afterFp] of after) {
    const beforeFp = before.get(absPath);
    if (!beforeFp) {
      changes.push({ absPath, kind: 'created' });
      continue;
    }
    if (beforeFp.mtimeMs !== afterFp.mtimeMs || beforeFp.size !== afterFp.size) {
      changes.push({ absPath, kind: 'modified' });
    }
  }

  for (const absPath of before.keys()) {
    if (!after.has(absPath)) {
      changes.push({ absPath, kind: 'deleted' });
    }
  }

  return changes;
}

function resolveFileHistoryAnchorId(context: {
  fileHistoryAnchorId?: string;
  agentRunId?: string;
}): string | undefined {
  return context.fileHistoryAnchorId ?? context.agentRunId;
}

function resolveTurnBaselineCacheKey(anchorId: string, workspaceRoot: string): string {
  return `${anchorId}:${path.resolve(workspaceRoot)}`;
}

function getCachedTurnBaseline(
  fileHistory: FileHistorySink,
  cacheKey: string,
): ShellFileHistoryTurnBaselineCacheEntry | undefined {
  return shellFileHistoryTurnBaselineCache.get(fileHistory)?.get(cacheKey);
}

function rememberTurnBaseline(
  fileHistory: FileHistorySink,
  entry: ShellFileHistoryTurnBaselineCacheEntry,
): void {
  let cache = shellFileHistoryTurnBaselineCache.get(fileHistory);
  if (!cache) {
    cache = new Map();
    shellFileHistoryTurnBaselineCache.set(fileHistory, cache);
  }
  cache.delete(entry.key);
  cache.set(entry.key, entry);

  while (cache.size > SHELL_FILE_HISTORY_TURN_BASELINE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function resetShellFileHistoryTurnBaselineCacheForTests(fileHistory?: FileHistorySink): void {
  if (fileHistory) {
    shellFileHistoryTurnBaselineCache.delete(fileHistory);
  }
}

/**
 * spawn 前：扫描 workspace + 对扫描到的已存在文件 pre-track。
 * modified/deleted 文件靠此路径获得正确的 before-backup。
 */
export async function prepareShellFileHistoryTracking(context: {
  workspaceRoot?: string;
  fileHistory?: FileHistorySink;
  fileHistoryAnchorId?: string;
  agentRunId?: string;
}): Promise<ShellFileHistoryPrepareResult> {
  const anchorId = resolveFileHistoryAnchorId(context);
  if (!context.workspaceRoot) {
    return {
      preSnapshot: undefined,
      preTrack: {
        trackedCount: 0,
        trackFailedCount: 0,
        scanTruncated: false,
        scanFailed: true,
        skippedReason: 'no_workspace',
      },
    };
  }
  if (!context.fileHistory) {
    return {
      preSnapshot: undefined,
      preTrack: {
        trackedCount: 0,
        trackFailedCount: 0,
        scanTruncated: false,
        scanFailed: false,
        skippedReason: 'no_file_history',
      },
    };
  }
  if (!anchorId) {
    return {
      preSnapshot: undefined,
      preTrack: {
        trackedCount: 0,
        trackFailedCount: 0,
        scanTruncated: false,
        scanFailed: false,
        skippedReason: 'no_anchor',
      },
    };
  }

  const cacheKey = resolveTurnBaselineCacheKey(anchorId, context.workspaceRoot);
  const cached = getCachedTurnBaseline(context.fileHistory, cacheKey);
  if (cached) {
    return {
      preSnapshot: cached.preSnapshot,
      preTrack: cached.preTrack,
    };
  }

  const scan = await scanWorkspaceFiles(context.workspaceRoot);
  let trackedCount = 0;
  let trackFailedCount = 0;

  for (const absPath of scan.snapshot.keys()) {
    try {
      await context.fileHistory.trackEdit(anchorId, absPath);
      trackedCount += 1;
    } catch {
      trackFailedCount += 1;
    }
  }

  const preTrack: ShellFileHistoryPreTrackResult = {
    trackedCount,
    trackFailedCount,
    scanTruncated: scan.scanTruncated,
    scanFailed: scan.scanFailed,
  };
  rememberTurnBaseline(context.fileHistory, {
    key: cacheKey,
    preSnapshot: scan.snapshot,
    preTrack,
  });

  return {
    preSnapshot: scan.snapshot,
    preTrack,
  };
}

/** 命令同步结束（completed / user-kill）后：post-scan + 生成 envelope 字段。 */
export async function buildShellFileHistoryEnvelope(params: {
  workspaceRoot?: string;
  preSnapshot?: WorkspaceFileSnapshot;
  preTrack: ShellFileHistoryPreTrackResult;
  deferred?: boolean;
}): Promise<ShellFileHistoryEnvelope | undefined> {
  const { preTrack, preSnapshot, workspaceRoot, deferred } = params;

  if (deferred) {
    return {
      status: 'deferred',
      tracked_count: preTrack.trackedCount,
      changed_count: 0,
      created_untracked_count: 0,
      deleted_count: 0,
      modified_count: 0,
      scan_truncated: preTrack.scanTruncated,
      scan_failed: preTrack.scanFailed,
      track_failed_count: preTrack.trackFailedCount,
      degraded: true,
      degraded_reason: 'background_deferred',
    };
  }

  if (preTrack.skippedReason === 'no_workspace') {
    return {
      status: 'skipped',
      tracked_count: 0,
      changed_count: 0,
      created_untracked_count: 0,
      deleted_count: 0,
      modified_count: 0,
      scan_truncated: false,
      scan_failed: true,
      track_failed_count: 0,
      degraded: true,
      degraded_reason: 'no_workspace',
    };
  }

  if (preTrack.skippedReason === 'no_file_history') {
    return {
      status: 'skipped',
      tracked_count: 0,
      changed_count: 0,
      created_untracked_count: 0,
      deleted_count: 0,
      modified_count: 0,
      scan_truncated: preTrack.scanTruncated,
      scan_failed: preTrack.scanFailed,
      track_failed_count: 0,
      degraded: true,
      degraded_reason: 'no_file_history',
    };
  }

  if (preTrack.skippedReason === 'no_anchor') {
    return {
      status: 'skipped',
      tracked_count: 0,
      changed_count: 0,
      created_untracked_count: 0,
      deleted_count: 0,
      modified_count: 0,
      scan_truncated: preTrack.scanTruncated,
      scan_failed: preTrack.scanFailed,
      track_failed_count: 0,
      degraded: true,
      degraded_reason: 'no_anchor',
    };
  }

  if (!preSnapshot || !workspaceRoot) {
    return undefined;
  }

  const postScan = await scanWorkspaceFiles(workspaceRoot);
  const changes = diffWorkspaceSnapshots(preSnapshot, postScan.snapshot);
  const created = changes.filter((c) => c.kind === 'created');
  const deleted = changes.filter((c) => c.kind === 'deleted');
  const modified = changes.filter((c) => c.kind === 'modified');

  const createdPaths = toWorkspaceRelativePaths(workspaceRoot, created);
  const modifiedPaths = toWorkspaceRelativePaths(workspaceRoot, modified);
  const deletedPaths = toWorkspaceRelativePaths(workspaceRoot, deleted);
  const pathsTruncated =
    created.length > SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS
    || modified.length > SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS
    || deleted.length > SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS;

  const scanTruncated = preTrack.scanTruncated || postScan.scanTruncated;
  const scanFailed = preTrack.scanFailed || postScan.scanFailed;
  const createdUntracked = created.length;
  const trackFailures = preTrack.trackFailedCount > 0;

  let degraded = false;
  let degradedReason: ShellFileHistoryEnvelope['degraded_reason'];

  if (scanTruncated) {
    degraded = true;
    degradedReason = 'scan_limit';
  } else if (scanFailed) {
    degraded = true;
    degradedReason = 'scan_failed';
  } else if (createdUntracked > 0) {
    degraded = true;
    degradedReason = 'created_files';
  } else if (trackFailures) {
    degraded = true;
    degradedReason = 'track_failures';
  }

  return {
    status: degraded ? 'degraded' : 'complete',
    tracked_count: preTrack.trackedCount,
    changed_count: changes.length,
    created_untracked_count: createdUntracked,
    deleted_count: deleted.length,
    modified_count: modified.length,
    ...(createdPaths.length > 0 ? { created_paths: createdPaths } : {}),
    ...(modifiedPaths.length > 0 ? { modified_paths: modifiedPaths } : {}),
    ...(deletedPaths.length > 0 ? { deleted_paths: deletedPaths } : {}),
    ...(pathsTruncated ? { paths_truncated: true } : {}),
    scan_truncated: scanTruncated,
    scan_failed: scanFailed,
    track_failed_count: preTrack.trackFailedCount,
    degraded,
    ...(degradedReason ? { degraded_reason: degradedReason } : {}),
  };
}

/**
 * 绝对路径 → workspace 相对路径（POSIX 分隔），按 envelope 上限截断。
 * 越界（不在 workspace 内）或空路径丢弃。
 */
function toWorkspaceRelativePaths(
  workspaceRoot: string,
  changes: WorkspaceFileChange[],
): string[] {
  const root = path.resolve(workspaceRoot);
  const result: string[] = [];
  for (const change of changes) {
    if (result.length >= SHELL_FILE_HISTORY_MAX_ENVELOPE_PATHS) break;
    const relative = path.relative(root, change.absPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    result.push(relative.split(path.sep).join('/'));
  }
  return result;
}

/** 把 `file_history` 合入 envelope 对象（仅当有内容时写入）。 */
export function attachShellFileHistoryToEnvelope(
  envelope: Record<string, unknown>,
  fileHistory: ShellFileHistoryEnvelope | undefined,
): void {
  if (fileHistory) {
    envelope.file_history = fileHistory;
  }
}
