import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from '../logging/logger.js';
import { parseStatusV2 } from './parsers/parse-status-v2.js';
import { parseDiffNumstat } from './parsers/parse-diff-numstat.js';
import type { GitStatusData } from './parsers/types.js';
import { emptyGitStatus } from './parsers/types.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 8_000;
const MIN_COLLECT_INTERVAL_MS = 10_000;
const MAX_FILES_IN_STATUS = 100;
const DEBOUNCE_COLLECT_MS = 2_000;

export type GitStatusReadyCallback = (status: GitStatusData) => void;

export class GitStatusCollector {
  private readonly logger: Logger;

  private repoPath: string | null = null;
  private lastStatus: GitStatusData | null = null;
  private lastCollectAt = 0;
  private collecting = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatusReady: GitStatusReadyCallback | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Register a callback invoked when a fresh git status is collected
   * after a tool-triggered invalidation (Phase 2 instant push).
   */
  setOnStatusReady(callback: GitStatusReadyCallback): void {
    this.onStatusReady = callback;
  }

  /**
   * Schedule a debounced collect + notify cycle.
   * Multiple rapid calls within DEBOUNCE_COLLECT_MS are merged into one.
   * On completion, invokes onStatusReady callback for WS push.
   */
  scheduleCollectAndNotify(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.collect()
        .then((status) => {
          if (status && this.onStatusReady) {
            this.onStatusReady(status);
          }
        })
        .catch(() => {});
    }, DEBOUNCE_COLLECT_MS);
  }

  /**
   * Update the repo path when it becomes known (e.g. from action params).
   * Accepts a project directory; the collector will verify it's a git repo.
   */
  setRepoPath(path: string): void {
    if (!path || path === this.repoPath) return;
    this.logger.debug(`GitStatusCollector: repo path set to ${path}`);
    this.repoPath = path;
    this.lastStatus = null;
    this.resolveGitRoot(path)
      .then((root) => {
        if (root && root !== this.repoPath) {
          this.logger.debug(`GitStatusCollector: resolved git root: ${root}`);
          this.repoPath = root;
          this.lastStatus = null;
        }
      })
      .catch(() => {});
  }

  getRepoPath(): string | null {
    return this.repoPath;
  }

  /**
   * Returns the latest cached git status, or null if never collected.
   * Does not trigger a new collection.
   */
  getCachedStatus(): GitStatusData | null {
    return this.lastStatus;
  }

  /**
   * Collect git status. Respects minimum interval to avoid excessive calls.
   * Returns cached value if collected recently.
   * On first call, tries process.cwd() as fallback if no repo path has been set.
   */
  async collect(): Promise<GitStatusData | null> {
    if (!this.repoPath) {
      await this.tryDetectRepoPath();
    }
    if (!this.repoPath) return null;
    if (this.collecting) return this.lastStatus;

    const now = Date.now();
    if (now - this.lastCollectAt < MIN_COLLECT_INTERVAL_MS && this.lastStatus) {
      return this.lastStatus;
    }

    this.collecting = true;
    try {
      this.lastStatus = await this.doCollect(this.repoPath);
      this.lastCollectAt = Date.now();
      return this.lastStatus;
    } catch (err) {
      this.logger.debug(`GitStatusCollector: collect failed — ${err instanceof Error ? err.message : err}`);
      return this.lastStatus;
    } finally {
      this.collecting = false;
    }
  }

  /**
   * Force invalidation so next collect() runs immediately regardless of throttle.
   */
  invalidate(): void {
    this.lastCollectAt = 0;
  }

  /**
   * RM-P1-1: 清理资源，取消 debounce 定时器，防止关闭后仍向已关闭 WS 写入数据
   */
  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.onStatusReady = null;
  }

  private static readonly MAX_DIFF_BYTES = 500_000;

  /**
   * Get unified diff for a single file. Used by Phase 4 on-demand diff preview.
   * Returns empty string if repo path unknown or git command fails.
   * Truncates output exceeding MAX_DIFF_BYTES to stay within WS message limits.
   */
  async getFileDiff(filePath: string, staged: boolean = false): Promise<string> {
    if (!this.repoPath) return '';
    const args = staged
      ? ['diff', '--cached', '--', filePath]
      : ['diff', '--', filePath];
    let diff = await this.runGit(this.repoPath, args);
    if (Buffer.byteLength(diff, 'utf-8') > GitStatusCollector.MAX_DIFF_BYTES) {
      const truncated = Buffer.from(diff, 'utf-8').subarray(0, GitStatusCollector.MAX_DIFF_BYTES).toString('utf-8');
      const lastNewline = truncated.lastIndexOf('\n');
      diff = (lastNewline > 0 ? truncated.substring(0, lastNewline) : truncated)
        + '\n\n... [diff truncated — file too large for preview]';
    }
    return diff;
  }

  private autoDetectAttempts = 0;
  private static readonly MAX_AUTO_DETECT_ATTEMPTS = 3;

  private async tryDetectRepoPath(): Promise<void> {
    if (this.autoDetectAttempts >= GitStatusCollector.MAX_AUTO_DETECT_ATTEMPTS) return;
    this.autoDetectAttempts++;

    try {
      const cwd = process.cwd();
      if (await this.isGitRepo(cwd)) {
        this.logger.info(`GitStatusCollector: auto-detected git repo at ${cwd}`);
        this.repoPath = await this.resolveGitRoot(cwd) ?? cwd;
        return;
      }

      const envRoot = process.env.TABTIN_WORKSPACE_ROOT;
      if (envRoot && await this.isGitRepo(envRoot)) {
        this.logger.info(`GitStatusCollector: detected git repo from TABTIN_WORKSPACE_ROOT: ${envRoot}`);
        this.repoPath = await this.resolveGitRoot(envRoot) ?? envRoot;
        return;
      }
    } catch {
      // transient failure — allow retry on next collect()
    }
  }

  private async doCollect(cwd: string): Promise<GitStatusData> {
    const isRepo = await this.isGitRepo(cwd);
    if (!isRepo) {
      return emptyGitStatus(cwd);
    }

    const [statusOutput, unstagedDiff, stagedDiff] = await Promise.all([
      this.runGit(cwd, ['status', '--porcelain=v2', '--branch', '--show-stash', '--untracked-files=all']),
      this.runGit(cwd, ['diff', '--numstat']),
      this.runGit(cwd, ['diff', '--cached', '--numstat']),
    ]);

    const status = parseStatusV2(statusOutput);
    const unstaged = parseDiffNumstat(unstagedDiff);
    const staged = parseDiffNumstat(stagedDiff);

    // Merge line stats into file entries
    for (const file of status.files) {
      const uStat = unstaged.files.get(file.path);
      const sStat = staged.files.get(file.path);
      if (file.is_staged && sStat) {
        file.lines_added = sStat.added;
        file.lines_removed = sStat.removed;
      } else if (!file.is_staged && uStat) {
        file.lines_added = uStat.added;
        file.lines_removed = uStat.removed;
      }
    }

    const isDirty =
      status.modified_count > 0 ||
      status.staged_count > 0 ||
      status.untracked_count > 0 ||
      status.deleted_count > 0 ||
      status.conflict_count > 0;

    return {
      is_repo: true,
      repo_path: cwd,
      branch: status.branch.head,
      upstream_branch: status.branch.upstream,
      ahead_count: status.branch.ahead,
      behind_count: status.branch.behind,
      is_dirty: isDirty,
      modified_count: status.modified_count,
      staged_count: status.staged_count,
      untracked_count: status.untracked_count,
      deleted_count: status.deleted_count,
      conflict_count: status.conflict_count,
      stash_count: status.stash_count,
      staged_lines_added: staged.total_added,
      staged_lines_removed: staged.total_removed,
      unstaged_lines_added: unstaged.total_added,
      unstaged_lines_removed: unstaged.total_removed,
      files: status.files.length > MAX_FILES_IN_STATUS
        ? status.files.slice(0, MAX_FILES_IN_STATUS)
        : status.files,
      total_file_count: status.files.length,
      collected_at: new Date().toISOString(),
    };
  }

  private async resolveGitRoot(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async isGitRepo(cwd: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async runGit(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isBufferOverflow = msg.includes('maxBuffer') || msg.includes('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      const level = isBufferOverflow ? 'warn' : 'debug';
      this.logger[level](`GitStatusCollector: git ${args[0]} failed — ${msg}`);
      return '';
    }
  }
}
