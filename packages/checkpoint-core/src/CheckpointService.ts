/**
 * CheckpointService — Shadow Git 检查点管理核心服务
 *
 * 在指定目录下维护一个隐藏的 Git 仓库，利用
 * `core.worktree` 指向用户项目目录，从而在不影响项目 .git 的
 * 前提下实现文件状态快照与恢复。
 *
 * 平台无关：Electron / Daemon / 其他环境通过构造函数注入
 * checkpointsRoot 和 logger 即可使用。
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { getCheckpointsRoot } from '@tabtin/shared/storage-paths'
import crypto from 'node:crypto'
import simpleGit, { type SimpleGit } from 'simple-git'
import { buildExcludeContent } from './exclusions.js'

// ── Constants ────────────────────────────────────────────────

const GIT_DISABLED_SUFFIX = '_disabled'
const GC_INTERVAL = 20
const LOCK_TIMEOUT_MS = 120_000
/** 单条 git 命令超时，防止 git 进程挂起导致 withLock 永久阻塞 */
const GIT_CMD_TIMEOUT_MS = 60_000
/** index.lock 残留超过此阈值视为陈旧，自动清理 */
const INDEX_LOCK_STALE_THRESHOLD_MS = 30_000
const NESTED_GIT_MAX_DEPTH = 5
const NESTED_GIT_SHALLOW_DEPTH = 4
const NESTED_GIT_CACHE_TTL_MS = 60_000
/** 磁盘占用告警阈值（500MB） */
const DISK_WARN_THRESHOLD = 500 * 1024 * 1024

const SKIP_DIRS = new Set([
  'node_modules', '.cache', 'dist', 'build', '.next',
  'vendor', '__pycache__', '.venv',
  'coverage', '.turbo', '.output', '.nuxt', '.svelte-kit',
  '.parcel-cache', 'out',
])

// ── Types ────────────────────────────────────────────────────

export interface CheckpointLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug(message: string, ...args: unknown[]): void
}

export interface CheckpointDiffEntry {
  relativePath: string
  absolutePath: string
  before: string
  after: string
}

/** git --name-status 首字母归一：A→added、D→deleted，其余（M/R/C/T）→modified。 */
export type DiffFileStatus = 'added' | 'modified' | 'deleted'

export interface DiffSummaryFileEntry {
  file: string
  insertions: number
  deletions: number
  binary: boolean
  /** 缺失 = 老数据或 name-status 解析失败，消费方需退回启发式判断。 */
  status?: DiffFileStatus
}

export interface DiffSummaryResult {
  files: DiffSummaryFileEntry[]
  summary: {
    changed: number
    insertions: number
    deletions: number
  }
}

export type CheckpointKind =
  | 'agent_turn_done'
  | 'safety_before_restore'
  | 'safety_before_replace'
  | 'tabcode_replace'
  | 'error_compensation'
  | 'tabdata_auto_anchor'
  | 'pre_approval'
  | 'manual'
  | 'system_recovery'

export interface CheckpointCommitPolicy {
  kind?: CheckpointKind
  trigger?: CheckpointKind
  allowEmpty?: boolean
  visibleInHistory?: boolean
  anchor?: string
  baselineHash?: string
}

export interface CheckpointRestoreOptions {
  /**
   * Move shadow-git HEAD to the restored commit.
   *
   * Default restore is conservative: it changes the worktree/index only, so
   * older commits remain visible in history. Chat rewind/edit needs branch-like
   * semantics instead: future checkpoints after the target should no longer be
   * on the current visible chain.
   */
  moveHead?: boolean
}

export interface NormalizedCheckpointCommitPolicy {
  kind: CheckpointKind
  trigger: CheckpointKind
  allowEmpty: boolean
  visibleInHistory: boolean
  anchor?: string
  baselineHash?: string
}

// ── Utility functions ────────────────────────────────────────

function isBinaryContent(content: string): boolean {
  return content.includes('\0')
}

export function hashWorkingDir(dir: string): string {
  return crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16)
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function getLfsPatterns(workspacePath: string): Promise<string[]> {
  try {
    const attrPath = path.join(workspacePath, '.gitattributes')
    if (!(await fileExists(attrPath))) return []
    const content = await fs.readFile(attrPath, 'utf-8')
    return content
      .split('\n')
      .filter((line) => line.includes('filter=lfs'))
      .map((line) => line.split(' ')[0].trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 从已读到的 git config 文件文本中 parse 出 `[core].worktree` 值。
 *
 * 纯函数，不接触 IO —— 调用方负责自己拿 string 内容（譬如先用 `fs.readFile`
 * 读出来）。这层拆分让上层能精确区分"读不到 config 文件"（IO 失败）和
 * "读到了但配置里没 worktree 项"两种语义，UI 可以分别给出不同文案。
 *
 * 返 `null` 仅表示 `[core].worktree` 不在配置里（包括 [core] 段都没有的情况）。
 */
export function parseShadowCoreWorktreeFromConfig(content: string): string | null {
  let inCoreSection = false
  for (const rawLine of content.split('\n')) {
    const stripped = rawLine.replace(/[#;].*$/, '').trim()
    if (!stripped) continue
    if (stripped.startsWith('[')) {
      inCoreSection = /^\[core(\s|\])/i.test(stripped)
      continue
    }
    if (!inCoreSection) continue
    const m = stripped.match(/^worktree\s*=\s*(.+)$/i)
    if (m) {
      const value = m[1].trim()
      const unquoted = value.replace(/^"(.*)"$/, '$1')
      const unescaped = isWindowsAbsolutePath(unquoted)
        ? unquoted.replace(/\\\\/g, '\\')
        : unquoted
      return unescaped || null
    }
  }
  return null
}

/**
 * 直接 INI parse 一个已存在 shadow git 的 `.git/config` 拿 `[core].worktree`。
 *
 * 为什么不走 `simpleGit().getConfig()`：因为 shadow git 的 repo 不是 bare，
 * git 自己执行**任何**子命令前都会跑 `setup_git_directory`，它会 stat
 * `core.worktree` 指向的路径并解析 ancestry。一旦该路径（或其父目录）
 * 不存在，git 会直接 `fatal: Invalid path '<...>': No such file or directory`，
 * 连只读的 `git config --get-all core.worktree` 都跑不动——也就拿不到
 * worktree 值，无法给上层报"项目目录已不存在 / worktree mismatch"等可
 * 操作的错误，反而冒出原始 git fatal 吓到用户。
 *
 * 直接读文件可以绕开 git setup 流程，让我们在 Node 层做出明确判断后，
 * 再决定是否真的去执行 git 子命令。
 *
 * 返 `null` 涵盖两种情况（不区分）：config 文件读不到，或读到了但没 worktree
 * 项。需要区分时请改用 `fs.readFile` + `parseShadowCoreWorktreeFromConfig`。
 */
export async function readShadowCoreWorktree(gitDir: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(gitDir, 'config'), 'utf-8')
    return parseShadowCoreWorktreeFromConfig(content)
  } catch {
    return null
  }
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
}

function stripTrailingPathSeparators(value: string, root: string): string {
  let result = value
  while (result.length > root.length && /[\\/]+$/.test(result)) {
    result = result.slice(0, -1)
  }
  return result
}

/**
 * Normalize only for equality checks. Keep `this.cwd` and git config values
 * unchanged for display and for existing shadow repo hashes.
 */
export function normalizeWorktreePathForComparison(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  if (isWindowsAbsolutePath(trimmed)) {
    const normalized = path.win32.normalize(trimmed)
    return stripTrailingPathSeparators(normalized, path.win32.parse(normalized).root).toLowerCase()
  }

  const normalized = path.posix.normalize(trimmed)
  return stripTrailingPathSeparators(normalized, path.posix.parse(normalized).root)
}

export function normalizeCheckpointCommitPolicy(
  policy: CheckpointCommitPolicy = {},
): NormalizedCheckpointCommitPolicy {
  const kind = policy.kind ?? 'manual'
  const trigger = policy.trigger ?? kind
  return {
    kind,
    trigger,
    allowEmpty: policy.allowEmpty === true,
    visibleInHistory: policy.visibleInHistory ?? (
      kind === 'agent_turn_done' || kind === 'manual' || kind === 'error_compensation'
    ),
    anchor: policy.anchor,
    baselineHash: policy.baselineHash,
  }
}

function formatCheckpointCommitMessage(policy: NormalizedCheckpointCommitPolicy): string {
  return [
    'checkpoint',
    policy.kind,
    policy.trigger,
    policy.visibleInHistory ? 'visible' : 'hidden',
    Date.now().toString(),
  ].join(':')
}

// ── CheckpointService ───────────────────────────────────────

export class CheckpointService {
  static defaultRoot(): string {
    return getCheckpointsRoot()
  }

  private cwdHash: string
  private shadowGitDir: string
  private cwd: string
  private initialized = false
  private destroyed = false
  private initPromise: Promise<string> | null = null
  private commitCount = 0
  private pendingOp: Promise<void> = Promise.resolve()
  private lastGitattributesMtime = 0
  private lastUserExcludeMtime = 0
  private _nestedGitCache: { active: string[]; time: number } | null = null
  private readonly log: CheckpointLogger

  constructor(projectPath: string, checkpointsRoot: string, logger: CheckpointLogger) {
    this.cwd = projectPath
    this.cwdHash = hashWorkingDir(projectPath)
    this.shadowGitDir = path.join(checkpointsRoot, this.cwdHash)
    this.log = logger
  }

  get gitPath(): string {
    return path.join(this.shadowGitDir, '.git')
  }

  private createGit(): SimpleGit {
    return simpleGit(this.shadowGitDir, { timeout: { block: GIT_CMD_TIMEOUT_MS } })
  }

  // ── Initialization ──────────────────────────────────────────

  async init(): Promise<string> {
    if (this.initialized) return this.gitPath
    if (this.initPromise) return this.initPromise
    this.initPromise = this._doInit().catch((err) => {
      this.initPromise = null
      throw err
    })
    return this.initPromise
  }

  private async _doInit(): Promise<string> {
    // 任何后续 git 子命令都依赖 projectPath 真实存在（git 进程在
    // setup_git_directory 阶段会 stat core.worktree 路径，缺失时直接 fatal）。
    // 所以在动 git 之前先在 Node 层做一次 fileExists 探针，缺失时抛出
    // 带明确语义的错误，让 IPC 层归类为 'project_path_not_exist'，
    // 上层 UI 可据此降级（提示项目已不存在 / 一键清理孤儿 shadow repo），
    // 而不是把原始 "fatal: Invalid path ..." 冒到用户面前。
    if (!(await fileExists(this.cwd))) {
      throw new Error(
        `Project path does not exist: ${this.cwd}. ` +
        `The project may have been moved, deleted, or be on an unmounted volume. ` +
        `Use checkpoint:destroy to clean the orphan shadow repo.`,
      )
    }

    if (await fileExists(this.gitPath)) {
      const manifestPath = path.join(this.gitPath, 'disabled-git-dirs.json')
      try {
        const manifestContent = await fs.readFile(manifestPath, 'utf-8')
        const dirs: string[] = JSON.parse(manifestContent)
        for (const d of dirs) {
          const disabled = d + GIT_DISABLED_SUFFIX
          try {
            const disabledExists = await fileExists(disabled)
            const originalExists = await fileExists(d)
            if (disabledExists && !originalExists) {
              await fs.rename(disabled, d)
              this.log.warn(`[Checkpoint] Recovered disabled git dir from manifest: ${d}`)
            }
          } catch { /* skip */ }
        }
        await fs.unlink(manifestPath).catch(() => {})
        this.log.info('[Checkpoint] Processed crash recovery manifest')
      } catch {
        // manifest doesn't exist or is invalid — normal case
      }

      // 直接 parse .git/config 拿 worktree —— 不通过 git 进程，避免 git
      // 在 setup 阶段触发 worktree 路径解析失败（即使 cwd 现在存在，
      // 这条路径也比 git 子进程更轻量、语义更明确）。
      const worktreeValue = await readShadowCoreWorktree(this.gitPath)
      if (normalizeWorktreePathForComparison(worktreeValue) !== normalizeWorktreePathForComparison(this.cwd)) {
        throw new Error(
          `Checkpoint repo worktree mismatch: expected ${this.cwd}, got ${worktreeValue ?? '(missing)'}. ` +
          `If the project was moved, use checkpoint:destroy to clean the old shadow repo.`,
        )
      }

      const git = this.createGit()
      await this.ensureCoreConfigs(git)
      try {
        const countStr = (await git.raw(['rev-list', '--count', 'HEAD'])).trim()
        this.commitCount = parseInt(countStr, 10) || 0
      } catch {
        this.log.warn(`[Checkpoint] Shadow repo HEAD invalid for ${this.cwd}, recovering with initial commit...`)
        try {
          await this.addFiles(git)
          await git.commit(
            formatCheckpointCommitMessage(normalizeCheckpointCommitPolicy({
              kind: 'system_recovery',
              trigger: 'system_recovery',
              allowEmpty: true,
              visibleInHistory: false,
            })),
            { '--allow-empty': null, '--no-verify': null },
          )
          this.commitCount = 1
          this.log.info(`[Checkpoint] Recovery commit created for ${this.cwd}`)
        } catch (recoveryErr) {
          this.log.error('[Checkpoint] Recovery failed, destroying corrupt shadow repo:', recoveryErr)
          await fs.rm(this.shadowGitDir, { recursive: true, force: true }).catch(() => {})
          throw new Error(`Shadow repo recovery failed for ${this.cwd}: ${recoveryErr}`)
        }
      }
      this.initialized = true
      return this.gitPath
    }

    await fs.mkdir(this.shadowGitDir, { recursive: true })
    const git = this.createGit()
    await git.init()

    await git.addConfig('core.worktree', this.cwd)
    await git.addConfig('commit.gpgSign', 'false')
    await git.addConfig('user.name', 'TabTin Checkpoint')
    await git.addConfig('user.email', 'checkpoint@example.com')
    await this.ensureCoreConfigs(git)

    const lfsPatterns = await getLfsPatterns(this.cwd)
    await this.writeExcludeFile(lfsPatterns)
    await this.recordGitattributesMtime()

    await this.addFiles(git)
    await git.commit('initial checkpoint', { '--allow-empty': null, '--no-verify': null })

    this.initialized = true
    this.log.info(`[Checkpoint] Shadow repo initialized for ${this.cwd} → ${this.shadowGitDir}`)
    return this.gitPath
  }

  // ── Write-tree (lightweight snapshot) ────────────────────────

  /**
   * 轻量级工作区快照：暂存所有文件后返回 tree hash，不创建 commit。
   *
   * 与 shadow-git track() 设计一致——只在 git 对象库中生成一个 tree 对象，
   * 不创建新的 commit，因此不会污染 shadow git 的提交历史。
   *
   * 典型用途：Agent run 开始前捕获基线状态，结束后用 getDiffSummary(commit, baseline)
   * 对比，确保 diff 只包含本轮 Agent 的实际修改。
   */
  async writeTree(): Promise<string | undefined> {
    await this.init()
    return this.withLock(async () => {
      const git = this.createGit()
      try {
        await this.refreshExcludeIfNeeded()
        await this.addFiles(git)
        const result = await git.raw(['write-tree'])
        const treeHash = result.trim()
        this.log.info(`[Checkpoint] write-tree: ${treeHash}`)
        return treeHash || undefined
      } catch (error) {
        this.log.error('[Checkpoint] write-tree failed:', error)
        throw error
      }
    })
  }

  // ── Commit (create checkpoint) ──────────────────────────────

  async commit(policy: CheckpointCommitPolicy = {}): Promise<string | undefined> {
    await this.init()
    const normalizedPolicy = normalizeCheckpointCommitPolicy(policy)
    let shouldGc = false
    const result = await this.withLock(async () => {
      const git = this.createGit()

      try {
        await this.refreshExcludeIfNeeded()
        await this.addFiles(git)

        const treeHash = (await git.raw(['write-tree'])).trim()
        if (normalizedPolicy.baselineHash && treeHash === normalizedPolicy.baselineHash) {
          this.log.info(
            `[Checkpoint] Skip commit for ${this.cwd}: tree unchanged from baseline ` +
            `(kind=${normalizedPolicy.kind}, trigger=${normalizedPolicy.trigger})`,
          )
          return undefined
        }

        if (!normalizedPolicy.allowEmpty) {
          try {
            const headTreeHash = (await git.raw(['rev-parse', 'HEAD^{tree}'])).trim()
            if (treeHash && headTreeHash === treeHash) {
              this.log.info(
                `[Checkpoint] Skip empty commit for ${this.cwd} ` +
                `(kind=${normalizedPolicy.kind}, trigger=${normalizedPolicy.trigger})`,
              )
              return undefined
            }
          } catch {
            // New/corrupt repos are initialized before commit(); if HEAD cannot be
            // resolved here, let git.commit surface the real failure below.
          }
        }

        const commitMessage = formatCheckpointCommitMessage(normalizedPolicy)
        const commitOptions: Record<string, null> = { '--no-verify': null }
        if (normalizedPolicy.allowEmpty) {
          commitOptions['--allow-empty'] = null
        }
        const commitResult = await git.commit(commitMessage, commitOptions)

        let commitHash = (commitResult.commit || '').replace(/^HEAD\s+/, '').trim()

        if (!commitHash) {
          commitHash = (await git.revparse(['HEAD'])).trim()
        }

        this.log.info(
          `[Checkpoint] Created commit ${commitHash} for ${this.cwd} ` +
          `(kind=${normalizedPolicy.kind}, trigger=${normalizedPolicy.trigger}, visible=${normalizedPolicy.visibleInHistory})`,
        )
        this.commitCount++
        if (this.commitCount % GC_INTERVAL === 0) {
          shouldGc = true
        }
        return commitHash || undefined
      } catch (error) {
        this.log.error('[Checkpoint] Commit failed:', error)
        throw error
      }
    })
    if (shouldGc) {
      this.gc().catch((err) => this.log.warn('[Checkpoint] Auto GC failed:', err))
    }
    return result
  }

  async getInitialCommitHash(): Promise<string | null> {
    await this.init()
    const git = this.createGit()

    try {
      const raw = await git.raw(['rev-list', '--max-parents=0', 'HEAD'])
      const first = raw
        .split('\n')
        .map((line: string) => line.trim())
        .find(Boolean)
      return first || null
    } catch (error) {
      this.log.error('[Checkpoint] Resolve initial commit failed:', error)
      return null
    }
  }

  // ── Pre-check for restore ────────────────────────────────────

  /**
   * 获取恢复到指定 commit 时会受影响的文件相对路径列表。
   * 用于 restore 前的 deny_write_paths 预检，保证原子性拒绝。
   */
  async getAffectedPaths(commitHash: string): Promise<string[]> {
    await this.init()
    const git = this.createGit()
    const cleanHash = commitHash.replace(/[^a-f0-9]/gi, '')
    const diffRaw = await git.raw(['diff', '--name-only', cleanHash, 'HEAD'])
    return diffRaw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  }

  // ── Restore ─────────────────────────────────────────────────

  async restore(commitHash: string, options: CheckpointRestoreOptions = {}): Promise<void> {
    await this.init()
    return this.withLock(async () => {
      const git = this.createGit()

      try {
        const cleanHash = commitHash.replace(/[^a-f0-9]/gi, '')

        let agentAddedFiles: string[] = []
        let diffSucceeded = false
        try {
          const diffRaw = await git.raw([
            'diff', '--name-status', '--diff-filter=A', cleanHash, 'HEAD',
          ])
          agentAddedFiles = diffRaw
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/^A\t/, '').trim())
            .filter(Boolean)
          diffSucceeded = true
        } catch (diffErr) {
          this.log.warn('[Checkpoint] git diff failed, agent-added files cannot be identified:', diffErr)
        }

        if (options.moveHead) {
          // Rewind the current visible version chain. This is intentionally used
          // by chat rollback/edit flows so the next checkpoint is parented by
          // the restored commit instead of by superseded future commits.
          await git.reset(['--hard', cleanHash])
        } else {
          // Restore the tracked file tree without moving shadow-git HEAD.
          // Plain version-panel restore should not remove the user's ability to
          // navigate future versions.
          await git.raw(['restore', '--source', cleanHash, '--staged', '--worktree', '--', '.'])
        }

        if (agentAddedFiles.length > 0) {
          for (const file of agentAddedFiles) {
            const absPath = path.resolve(this.cwd, file)
            if (!absPath.startsWith(this.cwd + path.sep) && absPath !== this.cwd) continue
            await fs.rm(absPath, { force: true, recursive: true }).catch(() => {})
          }
        } else if (!diffSucceeded) {
          this.log.warn('[Checkpoint] git diff failed; skipping file cleanup to avoid deleting user files. Agent-added files may remain as untracked.')
        }

        this.log.info(`[Checkpoint] Restored to ${cleanHash} for ${this.cwd}`)
      } catch (error) {
        this.log.error('[Checkpoint] Restore failed:', error)
        throw error
      }
    })
  }

  // ── Diff ────────────────────────────────────────────────────

  /**
   * 获取两个检查点之间（或某个检查点到当前工作区）的文件差异。
   *
   * - `toHash` 有值：纯只读查询，比较两个已有 commit 之间的差异，不修改 shadow index。
   * - `toHash` 缺省：先执行 `addFiles` 将工作区暂存到 shadow index，
   *   然后比较 `fromHash` 到 index 的差异。
   *
   * TOCTOU 限制（DI-003）：`toHash` 缺省时，本方法释放 withLock 后到调用方读取
   * 返回值之间，Agent 可继续写文件，导致返回结果可能已过时。若后续紧跟
   * `commit()`，commit 会再次执行 `addFiles` 以捕获中间变更，因此 commit
   * 内容的正确性不受影响——代价是两次 `git add .` 的 I/O 开销。
   * 这是有意的正确性取舍：跳过 commit 内的 addFiles 会遗漏两次操作间的
   * 文件变更，导致 checkpoint 快照与实际工作区不一致。
   */
  async getDiff(
    fromHash: string,
    toHash?: string,
  ): Promise<CheckpointDiffEntry[]> {
    await this.init()
    return this.withLock(async () => {
      const git = this.createGit()

      const cleanFrom = fromHash.replace(/[^a-f0-9]/gi, '')
      const cleanTo = toHash?.replace(/[^a-f0-9]/gi, '')

      if (!cleanTo) {
        await this.addFiles(git)
      }

      const diffRange = cleanTo ? `${cleanFrom}..${cleanTo}` : cleanFrom

      const summary = await git.diffSummary([diffRange])
      const entries: CheckpointDiffEntry[] = []

      for (const file of summary.files) {
        const relativePath = file.file
        const absolutePath = path.join(this.cwd, relativePath)

        let before = ''
        try {
          before = await git.show([`${cleanFrom}:${relativePath}`])
        } catch {
          // file didn't exist in older commit
        }

        let after = ''
        if (cleanTo) {
          try {
            after = await git.show([`${cleanTo}:${relativePath}`])
          } catch {
            // file didn't exist in newer commit
          }
        } else {
          try {
            after = await git.show([`:${relativePath}`])
          } catch {
            // file may be deleted (not in index)
          }
        }

        const isBinary = isBinaryContent(before) || isBinaryContent(after)
        entries.push({
          relativePath,
          absolutePath,
          before: isBinary && before ? '(binary file)' : before,
          after: isBinary && after ? '(binary file)' : after,
        })
      }

      return entries
    })
  }

  // ── Diff Summary ───────────────────────────────────────────

  /**
   * 获取指定 commit 的变更摘要统计。
   *
   * @param commitHash - 目标 commit hash
   * @param baseHash   - 可选基线 commit hash。提供时对比 baseHash..commitHash，
   *                     不提供时对比 commitHash^..commitHash（父 commit）。
   *                     Agent run 场景应传入 run 开始时的基线 hash，确保 diff
   *                     只包含本轮 Agent 实际修改，而非两次 checkpoint 之间的
   *                     全部变更（含人工编辑、其他 Agent 修改等）。
   *
   * 返回文件级别的行增删统计，不含文件内容——适用于轻量级变更上报。
   * 首次 commit（无父节点）且无 baseHash 时返回空摘要。
   */
  async getDiffSummary(commitHash: string, baseHash?: string): Promise<DiffSummaryResult> {
    await this.init()
    const git = this.createGit()
    const cleanHash = commitHash.replace(/[^a-f0-9]/gi, '')
    const cleanBase = baseHash?.replace(/[^a-f0-9]/gi, '')

    const range = cleanBase
      ? `${cleanBase}..${cleanHash}`
      : `${cleanHash}^..${cleanHash}`

    try {
      const summary = await git.diffSummary([range])

      // 每文件 A/M/D 状态：diffSummary（--numstat）不带状态位，二进制文件
      // insertions/deletions 恒为 0，消费方无法区分「新增/删除」——产物卡
      // 会把已删除文件当产物展示。用 --name-status 补一次状态。
      // best-effort：失败时 status 缺省，消费方退回启发式。
      const statusByFile = new Map<string, DiffFileStatus>()
      try {
        const nameStatusRaw = await git.raw(['diff', '--name-status', range])
        for (const line of nameStatusRaw.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const [statusToken, ...pathParts] = trimmed.split('\t')
          if (!statusToken || pathParts.length === 0) continue
          // rename/copy（R100 / C75）有两列路径，取目标路径与 diffSummary 对齐
          const filePath = pathParts[pathParts.length - 1]
          const letter = statusToken[0]
          const status: DiffFileStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified'
          statusByFile.set(filePath, status)
        }
      } catch {
        this.log.debug('[Checkpoint] getDiffSummary: name-status failed for range %s', range)
      }

      return {
        files: summary.files.map((f) => ({
          file: f.file,
          insertions: 'insertions' in f ? (f as any).insertions : 0,
          deletions: 'deletions' in f ? (f as any).deletions : 0,
          binary: f.binary,
          status: statusByFile.get(f.file),
        })),
        summary: {
          changed: summary.changed,
          insertions: summary.insertions,
          deletions: summary.deletions,
        },
      }
    } catch {
      this.log.debug('[Checkpoint] getDiffSummary: diff failed for range %s', range)
      return { files: [], summary: { changed: 0, insertions: 0, deletions: 0 } }
    }
  }

  // ── List Commits ────────────────────────────────────────────

  /**
   * 获取 Shadow Git 的 commit 历史列表，支持分页。
   * 若仓库未初始化或无 commit，返回空数组。
   */
  async listCommits(options?: { limit?: number; skip?: number }): Promise<Array<{
    hash: string
    message: string
    date: string
  }>> {
    await this.init()
    const git = this.createGit()
    const limit = Math.min(options?.limit ?? 50, 500)
    const skip = options?.skip ?? 0

    try {
      const logResult = await git.log({
        maxCount: limit,
        ...(skip > 0 ? { '--skip': skip } : {}),
      })

      return logResult.all.map(entry => ({
        hash: entry.hash,
        message: entry.message,
        date: entry.date,
      }))
    } catch {
      this.log.debug('[Checkpoint] listCommits: no commits yet for %s', this.cwd)
      return []
    }
  }

  // ── Internal helpers ────────────────────────────────────────

  /**
   * 串行队列锁：并发调用排队等待，带超时防止永久阻塞。
   * 超时时直接 resolve gate，打断死锁链。
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const prev = this.pendingOp
    this.pendingOp = gate

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`[Checkpoint] withLock timeout: previous operation exceeded ${LOCK_TIMEOUT_MS}ms`)),
        LOCK_TIMEOUT_MS,
      )
    })

    try {
      await Promise.race([prev, timeoutPromise])
    } catch {
      resolve()
      this.log.warn('[Checkpoint] withLock: timed out — rejecting current operation to prevent concurrent writes.')
      throw new Error(
        `[Checkpoint] Lock acquisition timed out after ${LOCK_TIMEOUT_MS}ms. Operation rejected to prevent concurrent shadow git writes.`,
      )
    } finally {
      clearTimeout(timer)
    }

    try {
      return await fn()
    } finally {
      resolve()
    }
  }

  /**
   * 整合了 index.lock 自清理、单次目录树遍历、嵌套 git 目录的修复/禁用/恢复。
   */
  private async addFiles(git: SimpleGit): Promise<void> {
    await this.cleanStaleIndexLock()

    const { active, disabled } = await this.findAllNestedGitDirs(this.cwd, NESTED_GIT_MAX_DEPTH)

    const repaired: string[] = []
    for (const dir of disabled) {
      const restored = dir.slice(0, -GIT_DISABLED_SUFFIX.length)
      try {
        await fs.rename(dir, restored)
        repaired.push(restored)
        this.log.info(`[Checkpoint] Repaired orphaned disabled git dir: ${dir}`)
      } catch {
        // race condition or permission — skip
      }
    }

    const allGitDirs = [...active, ...repaired]

    const manifestPath = path.join(this.gitPath, 'disabled-git-dirs.json')
    if (allGitDirs.length > 0) {
      await fs.writeFile(manifestPath, JSON.stringify(allGitDirs), 'utf-8')
    }

    for (const d of allGitDirs) {
      try {
        await fs.rename(d, d + GIT_DISABLED_SUFFIX)
      } catch {
        // race condition or permission — skip
      }
    }

    try {
      await git.add(['.', '--ignore-errors'])
    } finally {
      for (const d of allGitDirs) {
        try {
          await fs.rename(d + GIT_DISABLED_SUFFIX, d)
        } catch {
          // race condition or permission — skip
        }
      }
    }

    await fs.unlink(manifestPath).catch(() => {})
  }

  /**
   * 确保 shadow git 拥有跨平台一致性所需的 core.* 配置。
   * 使用 --replace-all 保证幂等：新建和已有 repo 均可安全调用。
   */
  private async ensureCoreConfigs(git: SimpleGit): Promise<void> {
    const configs: [string, string][] = [
      ['core.autocrlf', 'false'],
      ['core.longpaths', 'true'],
      ['core.symlinks', 'true'],
      ['core.fsmonitor', 'false'],
    ]
    for (const [key, value] of configs) {
      await git.raw(['config', '--replace-all', key, value])
    }
  }

  private async cleanStaleIndexLock(): Promise<void> {
    const lockPath = path.join(this.gitPath, 'index.lock')
    try {
      const stat = await fs.stat(lockPath)
      const ageMs = Date.now() - stat.mtimeMs
      if (ageMs > INDEX_LOCK_STALE_THRESHOLD_MS) {
        await fs.unlink(lockPath)
        this.log.warn(`[Checkpoint] Removed stale index.lock (age: ${Math.round(ageMs / 1000)}s)`)
      }
    } catch {
      // File doesn't exist — normal case
    }
  }

  private async findAllNestedGitDirs(
    baseDir: string,
    maxDepth: number,
  ): Promise<{ active: string[]; disabled: string[] }> {
    const now = Date.now()
    if (this._nestedGitCache && (now - this._nestedGitCache.time) < NESTED_GIT_CACHE_TTL_MS) {
      return { active: [...this._nestedGitCache.active], disabled: [] }
    }

    const active: string[] = []
    const disabled: string[] = []
    await this._walkForNestedGitDirs(baseDir, maxDepth, 0, active, disabled)

    if (disabled.length === 0) {
      this._nestedGitCache = { active: [...active], time: now }
    } else {
      this._nestedGitCache = null
    }

    return { active, disabled }
  }

  private async _walkForNestedGitDirs(
    dir: string,
    maxDepth: number,
    depth: number,
    active: string[],
    disabled: string[],
  ): Promise<void> {
    if (depth > maxDepth) return
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      const recurse: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (SKIP_DIRS.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)

        if (depth > 0) {
          if (entry.name === '.git') {
            active.push(fullPath)
            if (depth > 3) {
              this.log.warn(`[Checkpoint] Deep nested .git at depth ${depth}: ${fullPath}`)
            }
            continue
          }
          if (entry.name === `.git${GIT_DISABLED_SUFFIX}`) {
            disabled.push(fullPath)
            continue
          }
        }

        if (depth < NESTED_GIT_SHALLOW_DEPTH) {
          recurse.push(fullPath)
        }
      }
      if (recurse.length > 0) {
        await Promise.all(
          recurse.map(d => this._walkForNestedGitDirs(d, maxDepth, depth + 1, active, disabled)),
        )
      }
    } catch {
      // access error — skip
    }
  }

  private async writeExcludeFile(lfsPatterns: string[]): Promise<void> {
    const excludeDir = path.join(this.gitPath, 'info')
    await fs.mkdir(excludeDir, { recursive: true })
    const userExcludes = await this.readUserExcludes()
    const content = buildExcludeContent(lfsPatterns, userExcludes)
    await fs.writeFile(path.join(excludeDir, 'exclude'), content, 'utf-8')
  }

  /**
   * 读取用户仓库 .git/info/exclude 中的自定义忽略规则。
   * 与 shadow-git sync() 设计对齐：shadow git 应尊重用户在主仓库中的排除配置。
   */
  private async readUserExcludes(): Promise<string[]> {
    try {
      const userGitDir = path.join(this.cwd, '.git')
      const userExcludePath = path.join(userGitDir, 'info', 'exclude')
      if (!(await fileExists(userExcludePath))) return []
      const content = await fs.readFile(userExcludePath, 'utf-8')
      return content
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('#'))
    } catch {
      return []
    }
  }

  private async recordGitattributesMtime(): Promise<void> {
    try {
      const stat = await fs.stat(path.join(this.cwd, '.gitattributes'))
      this.lastGitattributesMtime = stat.mtimeMs
    } catch {
      this.lastGitattributesMtime = 0
    }
  }

  private async refreshExcludeIfNeeded(): Promise<void> {
    try {
      const attrPath = path.join(this.cwd, '.gitattributes')
      const userExcludePath = path.join(this.cwd, '.git', 'info', 'exclude')
      let attrMtime = 0
      let excludeMtime = 0
      try {
        attrMtime = (await fs.stat(attrPath)).mtimeMs
      } catch { /* file doesn't exist */ }
      try {
        excludeMtime = (await fs.stat(userExcludePath)).mtimeMs
      } catch { /* file doesn't exist */ }
      if (attrMtime !== this.lastGitattributesMtime || excludeMtime !== this.lastUserExcludeMtime) {
        const lfsPatterns = await getLfsPatterns(this.cwd)
        await this.writeExcludeFile(lfsPatterns)
        this.lastGitattributesMtime = attrMtime
        this.lastUserExcludeMtime = excludeMtime
        this.log.debug('[Checkpoint] Refreshed exclude rules')
      }
    } catch {
      // non-critical
    }
  }

  // ── Disk Usage ─────────────────────────────────────────────

  /**
   * 获取 Shadow Git 仓库的磁盘占用。
   * 使用 Node.js fs 递归统计目录大小，跨平台兼容（macOS / Linux / Windows）。
   */
  async getDiskUsage(): Promise<{ sizeBytes: number; sizeHuman: string; error?: boolean }> {
    await this.init()
    try {
      const sizeBytes = await this.calcDirSize(this.shadowGitDir)
      return { sizeBytes, sizeHuman: this.formatBytes(sizeBytes) }
    } catch (err) {
      this.log.debug('[Checkpoint] getDiskUsage failed: %s', err)
      return { sizeBytes: 0, sizeHuman: '0 B', error: true }
    }
  }

  private async calcDirSize(dir: string): Promise<number> {
    let total = 0
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        total += await this.calcDirSize(fullPath)
      } else {
        const stat = await fs.stat(fullPath)
        total += stat.size
      }
    }
    return total
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
  }

  // ── Maintenance ────────────────────────────────────────────

  async gc(): Promise<void> {
    if (this.destroyed || !this.initialized) return

    try {
      await this.pendingOp
    } catch {
      // ignore — just wait for it to settle
    }

    if (this.destroyed) return
    if (!(await fileExists(this.gitPath))) return

    const git = this.createGit()
    try {
      await git.raw(['gc', '--auto', '--quiet'])
      this.log.info(`[Checkpoint] GC completed for ${this.cwd}`)

      // GC 后检查磁盘占用
      const usage = await this.getDiskUsage()
      if (usage.sizeBytes > DISK_WARN_THRESHOLD) {
        this.log.warn(
          '[Checkpoint] Shadow Git 磁盘占用超过阈值: %s (%s)',
          usage.sizeHuman,
          this.cwd,
        )
      }
    } catch (error) {
      this.log.warn('[Checkpoint] GC failed:', error)
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    await this.withLock(async () => {
      try {
        await fs.rm(this.shadowGitDir, { recursive: true, force: true })
        this.initialized = false
        this.initPromise = null
        this.log.info(`[Checkpoint] Destroyed shadow repo for ${this.cwd}`)
      } catch (error) {
        this.log.warn('[Checkpoint] Destroy failed:', error)
      }
    })
  }

  /**
   * 启动后台定时 GC，扫描 checkpointsRoot 下所有 shadow repo 执行 gc --auto。
   * 返回 interval handle，可用于清理。
   */
  static startPeriodicGC(
    checkpointsRoot: string,
    logger: CheckpointLogger,
    intervalMs = 6 * 3600_000,
  ): ReturnType<typeof setInterval> {
    const run = async () => {
      try {
        const entries = await fs.readdir(checkpointsRoot, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const gitDir = path.join(checkpointsRoot, entry.name, '.git')
          if (!(await fileExists(gitDir))) continue
          try {
            const git = simpleGit(path.join(checkpointsRoot, entry.name), { timeout: { block: GIT_CMD_TIMEOUT_MS } })
            await git.raw(['gc', '--auto', '--quiet'])
          } catch {
            // skip individual repo GC failures
          }
        }
        logger.info('[Checkpoint] Periodic GC completed')
      } catch (err) {
        logger.warn('[Checkpoint] Periodic GC scan failed:', err)
      }
    }
    setTimeout(run, 5 * 60_000)
    return setInterval(run, intervalMs)
  }
}

// ── Service cache manager factory ──────────────────────────────

export interface CheckpointServiceCache {
  get(projectPath: string): CheckpointService
  destroy(projectPath: string): Promise<void>
  destroyAll(): Promise<void>
}

/**
 * 创建一个单例缓存管理器，每个 projectPath 对应一个 CheckpointService 实例。
 * 平台通过 factory 注入 checkpointsRoot 和 logger。
 */
export function createServiceCacheManager(
  factory: (normalizedPath: string) => CheckpointService,
): CheckpointServiceCache {
  const cache = new Map<string, CheckpointService>()
  return {
    get(projectPath: string): CheckpointService {
      const normalized = path.resolve(projectPath)
      let service = cache.get(normalized)
      if (!service) {
        service = factory(normalized)
        cache.set(normalized, service)
      }
      return service
    },
    async destroy(projectPath: string): Promise<void> {
      const normalized = path.resolve(projectPath)
      const service = cache.get(normalized)
      if (service) {
        await service.destroy()
        cache.delete(normalized)
      }
    },
    async destroyAll(): Promise<void> {
      const entries = [...cache.entries()]
      cache.clear()
      await Promise.all(
        entries.map(([, svc]) => svc.destroy().catch(() => {})),
      )
    },
  }
}
