/**
 * Git IPC Handlers
 *
 * 使用 child_process.execFile 调用 git CLI，轻量无第三方依赖。
 * 所有 handler 接收 cwd（工作目录）参数，在指定目录执行 git 命令。
 */

import { type IpcMainInvokeEvent } from 'electron'
import { execFile } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { guardedHandle } from './utils/guarded-handle'
import { createLogger } from './logger'
import type {
  GitRemoteInfo,
  GitBranchMeta,
  GitDiffFileSummary,
  GitDiffSummary,
  GitDiffStatGroup,
  GitDiffStatResult,
  GitStatusEntry,
  GitFullStatusResult,
  GitCommitListItem,
  GitCommitDetailResult,
  GitLogOptions,
  GitStashEntry,
  ParsedRemoteUrl,
  PullRequestContext,
  WorktreeRemovePreflightResult,
  WorktreeRemoveResult,
} from '@shared/git-types'
import type { GitActionWarning } from '@shared/git-action-result'
import {
  isEmptyRepositoryLogError,
  type GitLogFailureReason,
} from '@shared/git-log-errors'
import { buildGitLogArgs, parseGitLogLine } from '@shared/git-log-format'
import {
  getDefaultPathAccessChecker,
  type PathAccessAction,
} from './security/path-access-checker'
import {
  GIT_INDEX_LOCK_ERROR_MESSAGE,
  isGitIndexLockError,
  type CwdWriteQueueStart,
  type IndexLockRetryEvent,
  withCwdWriteQueue,
  withCwdWriteQueues,
  withIndexLockRetry,
} from './git-ipc-lock'
import {
  collectGitIndexLockDiagnostics,
  INDEX_LOCK_STALE_THRESHOLD_MS,
  isStaleIndexLockCandidate,
  tryRemoveStaleIndexLock,
  type GitIndexLockDiagnostics,
} from './git-index-lock-diagnostics'
import { classifyGitFailure, classifyGitErrorCode, redactGitDetail } from './git-error-classifier'
import { getWorktreeRemoveRuntimeProbe } from './git/worktree-remove-runtime-probe'
import {
  buildCreateWorktreeArgs,
  parseWorktrees,
} from './git/worktree-service'

export { parseWorktrees } from './git/worktree-service'

const log = createLogger('GitIPC')

function safeGitLog(
  level: 'info' | 'warn',
  message: string,
  diagnostics: object,
): void {
  try {
    log[level](message, diagnostics)
  } catch {
    // 可观测性绝不能阻止 Git 命令、覆盖原始错误或把成功操作误报为失败。
  }
}

/**
 * 路径权限治理 Wave 2：git IPC 路径权限单源化。
 *
 * 老模型一并退役：
 *   - O11 `isGitPathAllowed`（与 fs 的 `isPathAllowed` 几乎一字不差）
 *   - O12 `getGitAllowedDirs`（硬编码 home + spacesRoot + platformDataRoot）
 *   - O13 `validateCwd`（基于 O11 + 目录存在性 + isPathSafe）
 *   - 重复的 `matchDenyPattern` / `DEFAULT_DENY_READ_PATHS` 等
 *   - `updateGitSpaceDenyPaths` / `resetGitSpaceDenyPaths`（O8 死代码兄弟版）
 *
 * 替换方案：调 `path-access-checker.check(path, 'read'|'write')`——它
 * 消费当前 session 的 v3 `WorkspaceSnapshot.allowedPaths`，与 LLM 工具
 * 链路同源，让"用户在外接盘 `/Volumes/外接盘/项目/` 用 git 面板"这种
 * 老模型撞墙场景跑通。
 */

/**
 * 包一层 result envelope——把 path-access-checker 的判定转成 IPC 标准
 * `{ success: false, error }` / `{ ok: true }`，兼容现有 git handler 风格。
 */
function checkAndFormat(
  filePath: string,
  action: PathAccessAction,
): { ok: true } | { ok: false; error: string } {
  const result = getDefaultPathAccessChecker().check(filePath, action)
  if (result.allowed) return { ok: true }
  return { ok: false, error: result.reason?.message ?? 'access denied' }
}

/**
 * `validateCwd` 替代实现——git handler 入口闸门。
 *
 * 与原版差异：
 *   - 不再调 `isPathSafe(cwd, getGitAllowedDirs())` 做硬白名单（外接盘项目放行）
 *   - 仍要求 cwd 必须是真实存在的目录（git 命令的前置条件）
 *   - 路径权限走 path-access-checker（消费 v3 snapshot）
 *
 * **action 必须明确传**（Wave 2 第二轮独立验证 P1-Q2 修复）。
 *
 * 历史上这里默认走 'read' —— 但 git 命令分两类副作用：
 *   - **read 副作用**：status / branch / show / diff / remotes / worktrees / fetch
 *     等只读 cwd 内容、不改工作树或 .git 的命令；
 *   - **write 副作用**：checkout 分支 / stage / unstage / commit / push / pull /
 *     discardFiles / stash 写操作 / worktree 增删 / merge 等会改工作树
 *     或 .git 的命令。
 *
 * 用 'read' 投影所有 git 命令在当前 deny pattern 集合（仅 `.env`/`.env.*`
 * basename，cwd 是目录不撞）下"巧合"无差异——但语义错位。一旦未来 deny WRITE
 * 集合扩展（路径前缀型），用 'read' 投影会让真正的写操作绕过 write 检查。
 * D4 不允许这种隐性耦合：handler 必须按真实副作用声明 action。
 *
 * 返回 type guard，让 caller 可在分支后无 cast 用 cwd 作 string。
 */
function validateCwd(cwd: unknown, action: PathAccessAction): cwd is string {
  if (!cwd || typeof cwd !== 'string') return false
  try {
    const resolved = path.resolve(cwd)
    if (!fs.statSync(resolved).isDirectory()) return false
    const access = checkAndFormat(resolved, action)
    return access.ok
  } catch {
    return false
  }
}

/** 只读 Git 历史等场景：区分路径不存在 / 权限拒绝 / 非法 cwd。 */
function diagnoseCwdRead(cwd: unknown):
  | { ok: true; cwd: string }
  | { ok: false; reason: GitLogFailureReason; error: string } {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, reason: 'invalid_cwd', error: 'invalid working directory' }
  }
  try {
    const resolved = path.resolve(cwd)
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { ok: false, reason: 'path_not_found', error: 'working directory not found' }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, reason: 'permission_denied', error: 'permission denied for working directory' }
      }
      return { ok: false, reason: 'invalid_cwd', error: 'invalid working directory' }
    }
    if (!stat.isDirectory()) {
      return { ok: false, reason: 'path_not_found', error: 'working directory not found' }
    }
    const access = checkAndFormat(resolved, 'read')
    if (!access.ok) {
      return {
        ok: false,
        reason: 'permission_denied',
        error: access.error || 'permission denied for working directory',
      }
    }
    return { ok: true, cwd: resolved }
  } catch {
    return { ok: false, reason: 'invalid_cwd', error: 'invalid working directory' }
  }
}

/**
 * 检查一组 cwd-relative 路径的写权限。
 *
 * 路径权限治理 Wave 2 第二轮独立验证 P1-Q1 修复：
 *
 * 历史问题：`git:discardFiles(cwd, ['.env'])` / `git:stage(cwd, ['.env'])` 等
 * IPC 操作把 cwd-relative 文件名传进来，过去只检查 cwd 整体的 'read' 权限就放行。
 * 实际上：
 *   - `git checkout -- .env` 把 HEAD 的 `.env` 写回工作树（覆盖磁盘）
 *   - `git add .env` 把磁盘 `.env` 加入 staged（暴露到 git 历史）
 * `.env` 命中 `DEFAULT_DENY_WRITE_PATTERNS` —— 应该被 deny 列表拦下来。
 *
 * 本 helper 把每条 path 解析为 `cwd + relPath` 后跑 `checkAndFormat(_, 'write')`，
 * 任一不过即拒绝整批。renderer 调用方通过统一的 `{ ok, error }` envelope 拿到
 * 第一条不过的路径的拒绝原因。
 *
 * 调用方约定：先跑 `sanitizeRelativePath` 过滤掉 `..` / 绝对路径等不安全形态。
 */
type PathWriteDenial = { path: string; error: string }

/**
 * 按条检查 cwd-relative 路径的写权限，拆成可写 / 被拒两组。
 *
 * stage / unstage 用这个做「跳过 deny、继续其余」——根目录分组里若夹着
 * `.env`，不应拖垮同组 `README.md` 的暂存。discard 仍走下方
 * 全有或全无的 `checkPathsWriteAccess`，避免部分丢弃语义含糊。
 */
function partitionPathsWriteAccess(
  cwd: string,
  relPaths: readonly string[],
): { allowed: string[]; denied: PathWriteDenial[] } {
  const allowed: string[] = []
  const denied: PathWriteDenial[] = []
  for (const rel of relPaths) {
    const abs = path.resolve(cwd, rel)
    const access = checkAndFormat(abs, 'write')
    if (!access.ok) denied.push({ path: rel, error: access.error })
    else allowed.push(rel)
  }
  return { allowed, denied }
}

function checkPathsWriteAccess(
  cwd: string,
  relPaths: readonly string[],
): { ok: true } | { ok: false; error: string } {
  const { denied } = partitionPathsWriteAccess(cwd, relPaths)
  if (denied.length > 0) return { ok: false, error: denied[0]!.error }
  return { ok: true }
}

const UNSAFE_GIT_REF_PATTERN = /[\x00-\x1f\x7f~^:\\?*\[\]]/

/**
 * Validate a git ref (branch name, tag, startPoint) for safety.
 * Rejects refs that could inject git CLI flags or abuse refspec syntax.
 */
function sanitizeGitRef(ref: string): string | null {
  if (!ref) return null
  if (ref.startsWith('-')) return null
  if (ref.includes('..')) return null
  if (ref.includes('@{')) return null
  if (UNSAFE_GIT_REF_PATTERN.test(ref)) return null
  if (ref.endsWith('.lock')) return null
  if (ref.endsWith('.')) return null
  if (ref.includes(' ')) return null
  return ref
}

const execFileAsync = promisify(execFile)

/**
 * 防御性回退：解码 Git C-style quoted path（`"a\346\265\213b"` 这种带引号 +
 * 八进制转义的形式）。
 *
 * [#4915] 正常链路已经把所有消费 porcelain 路径的 `status` /
 * `diff --numstat` / `diff --name-status` 调用统一改成 `-z` + NUL 解析
 * （见 `parsePorcelainV1StatusZ` / `parseNumstatZ` / `parseNameStatusZ`），
 * `-z` 输出本身不受 `core.quotepath` 影响、也不会带引号转义，因此正常情况下
 * 这里传入的 rawPath 已经是解码好的真实路径，直接原样返回。
 * 保留本函数只是为了在个别调用方未来不小心又接回非 `-z` 输出时兜底，避免
 * 引号和 `\NNN` 转义直接回传给 `git add` 等写命令。
 */
function decodeGitQuotedPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return rawPath.trim()
  }
  const inner = trimmed.slice(1, -1)
  const simpleEscapes: Record<string, number> = {
    '\\': 0x5c, '"': 0x22, 'a': 0x07, 'b': 0x08, 'f': 0x0c,
    'n': 0x0a, 'r': 0x0d, 't': 0x09, 'v': 0x0b,
  }
  const bytes: number[] = []
  let i = 0
  while (i < inner.length) {
    const ch = inner[i]
    if (ch === '\\' && i + 1 < inner.length) {
      const octalMatch = inner.slice(i + 1, i + 4).match(/^[0-7]{3}/)
      if (octalMatch) {
        bytes.push(Number.parseInt(octalMatch[0], 8))
        i += 4
        continue
      }
      const next = inner[i + 1] || ''
      if (next in simpleEscapes) {
        bytes.push(simpleEscapes[next])
        i += 2
        continue
      }
    }
    bytes.push(ch.charCodeAt(0))
    i += 1
  }
  try {
    return Buffer.from(bytes).toString('utf8')
  } catch {
    return rawPath.trim()
  }
}

function normalizePorcelainPath(rawPath: string): string {
  const renameMarker = ' -> '
  if (rawPath.includes(renameMarker)) {
    const parts = rawPath.split(renameMarker)
    const target = parts[parts.length - 1]?.trim() || rawPath.trim()
    return decodeGitQuotedPath(target)
  }
  return decodeGitQuotedPath(rawPath)
}

/**
 * 解析 `git status --porcelain=v1 -uall -z` 输出。
 *
 * [#4915] `-z` 让 Git 用 NUL 分隔记录、放弃默认的 quotepath 转义与引号包裹，
 * 中文 / 空格 / 引号等特殊字符的路径都以原始字节直传，从根上避免
 * `"temp/\346\265\213\350\257\225/111"` 这种转义串混进 UI 和 `git add` 的
 * pathspec。rename/copy 记录格式为 `XY <newpath>\0<oldpath>\0`——X 为
 * `R`/`C` 时需要多消费一个 token（原路径），否则后续记录会错位。
 */
function parsePorcelainV1StatusZ(
  raw: string,
): { files: Record<string, string>; entries: Record<string, GitStatusEntry> } {
  const files: Record<string, string> = {}
  const entries: Record<string, GitStatusEntry> = {}
  const tokens = raw.split('\0')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    i += 1
    if (!token || token.length < 4) continue
    const x = token[0] || ' '
    const y = token[1] || ' '
    const filePath = normalizePorcelainPath(token.slice(3))
    if (x === 'R' || x === 'C') {
      // 原路径 token，当前只展示新路径，消费掉避免污染下一条记录的解析。
      i += 1
    }
    if (!filePath) continue
    const status = `${x}${y}`.trim()
    entries[filePath] = { x, y, status }
    files[filePath] = status
  }
  return { files, entries }
}

function normalizeFsPath(p: string): string {
  if (!p) return ''
  const resolved = path.resolve(p.trim())
  let canonical = path.normalize(resolved)
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    // Stale worktree entries may no longer exist. Exact normalized spelling is
    // the safe fallback on case-sensitive filesystems.
  }
  const withSlash = canonical.replace(/\\/g, '/').normalize('NFC')
  return process.platform === 'win32' ? withSlash.toLowerCase() : withSlash
}

function isBindingsUnknownError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: string; code?: string }
  return candidate.name === 'SessionCodeRootBindingsUnknownError'
    || candidate.code === 'BINDINGS_UNKNOWN'
}

function extractGitErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const withText = error as { stderr?: string; stdout?: string; message?: string }
    const detail = [withText.stderr, withText.stdout, withText.message]
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean)
      .join('\n')
    if (detail) return detail
  }
  return String(error)
}

function getGitErrorMessage(error: unknown): string {
  if (isGitIndexLockError(error)) return GIT_INDEX_LOCK_ERROR_MESSAGE
  return extractGitErrorText(error)
}

const GIT_WRITE_OPERATION_ID = Symbol('gitWriteOperationId')

type GitWriteError = {
  [GIT_WRITE_OPERATION_ID]?: string
}

function tagGitWriteError(error: unknown, operationId: string): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return
  try {
    Object.defineProperty(error, GIT_WRITE_OPERATION_ID, {
      value: operationId,
      configurable: true,
    })
  } catch {
    // 冻结的第三方 Error 不能附加诊断 ID；保留原始错误语义。
  }
}

function getGitWriteOperationId(error: unknown): string | undefined {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  return (error as GitWriteError)[GIT_WRITE_OPERATION_ID]
}

type GitWriteAction = 'stage' | 'unstage' | 'discard'

interface NormalizedGitPathspecs {
  rawPathCount: number
  cleanPaths: string[]
  droppedPathCount: number
  pathArrayProvided: boolean
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function basenameForLog(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return path.posix.basename(normalized) || normalized || '(empty)'
}

function normalizeGitPathspecs(paths?: string[]): NormalizedGitPathspecs {
  if (!Array.isArray(paths)) {
    return { rawPathCount: 0, cleanPaths: [], droppedPathCount: 0, pathArrayProvided: false }
  }

  const rawPathCount = paths.length
  const cleanPaths = paths
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((p) => sanitizeRelativePath(p) !== null)

  return {
    rawPathCount,
    cleanPaths,
    droppedPathCount: rawPathCount - cleanPaths.length,
    pathArrayProvided: true,
  }
}

function redactKnownPath(text: string, knownPath: string, replacement: string): string {
  if (!knownPath) return text
  const normalized = knownPath.replace(/\\/g, '/')
  return text
    .split(knownPath).join(replacement)
    .split(normalized).join(replacement)
}

function redactGitDiagnosticText(text: string, cwd: string, cleanPaths: readonly string[]): string {
  let redacted = text
  redacted = redactKnownPath(redacted, cwd, '<git-cwd>')
  for (const rel of cleanPaths) {
    redacted = redactKnownPath(redacted, path.resolve(cwd, rel), `<git-path:${shortHash(rel)}>`)
  }
  redacted = redacted.replace(/\/Users\/[^/\s'"]+/g, '/Users/<user>')
  redacted = redacted.replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<abs-path>')
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}…` : redacted
}

function buildGitWriteDiagnostics(
  action: GitWriteAction,
  cwd: unknown,
  paths: NormalizedGitPathspecs,
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {
    action,
    cwdType: typeof cwd,
    pathArrayProvided: paths.pathArrayProvided,
    rawPathCount: paths.rawPathCount,
    cleanPathCount: paths.cleanPaths.length,
    droppedPathCount: paths.droppedPathCount,
    pathMode: paths.cleanPaths.length === 0 ? 'all' : 'explicit',
    pathSamples: paths.cleanPaths.slice(0, 5).map((rel) => ({
      name: basenameForLog(rel),
      pathHash: shortHash(rel),
      depth: rel.replace(/\\/g, '/').split('/').filter(Boolean).length,
    })),
  }

  if (typeof cwd === 'string') {
    const resolved = path.resolve(cwd)
    diagnostics.cwdBase = basenameForLog(resolved)
    diagnostics.cwdHash = shortHash(resolved)
  }

  return diagnostics
}

function logGitWriteSuccess(action: GitWriteAction, cwd: string, paths: NormalizedGitPathspecs): void {
  safeGitLog('info', 'git write succeeded', buildGitWriteDiagnostics(action, cwd, paths))
}

function logGitWriteBlocked(
  action: GitWriteAction,
  cwd: unknown,
  paths: NormalizedGitPathspecs,
  reason: string,
  error?: string,
): void {
  safeGitLog('warn', 'git write blocked', {
    ...buildGitWriteDiagnostics(action, cwd, paths),
    reason,
    errorSummary: typeof cwd === 'string' && error
      ? redactGitDiagnosticText(error, cwd, paths.cleanPaths)
      : error,
  })
}

function logGitWriteFailure(
  action: GitWriteAction,
  cwd: string,
  paths: NormalizedGitPathspecs,
  errorMessage: string,
  operationId?: string,
): void {
  safeGitLog('warn', 'git write failed', {
    ...buildGitWriteDiagnostics(action, cwd, paths),
    ...(operationId ? { operationId } : {}),
    errorSummary: redactGitDiagnosticText(errorMessage, cwd, paths.cleanPaths),
  })
}

function rejectInvalidGitPathspecs(
  action: GitWriteAction,
  cwd: unknown,
  paths: NormalizedGitPathspecs,
): { success: false; error: string } | null {
  if (paths.droppedPathCount === 0) return null
  const error = 'one or more file paths are invalid'
  logGitWriteBlocked(action, cwd, paths, 'invalid pathspec', error)
  return { success: false, error }
}

/** 执行 git 命令的封装，统一超时和错误处理 */
async function runGit(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
  timeout = 20_000,
): Promise<string> {
  // GIT_OPTIONAL_LOCKS=0：status 等读操作不刷新 index，避免与 git add 抢 index.lock
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      // 所有来自 renderer 的路径都按字面值解释，避免 `:(glob)**` / `*.ts`
      // 被 Git 当成 pathspec 魔法而扩大 stage/unstage/discard 的影响范围。
      GIT_LITERAL_PATHSPECS: '1',
    },
  })
  return stdout
}

/**
 * 会改 index / 工作树 / refs 的写命令：按 cwd 串行 + index.lock 短重试。
 */
interface GitWriteOperationContext extends CwdWriteQueueStart {
  operationId: string
  command: string
  cwdBase: string
  cwdHash: string
}

function buildGitWriteOperationContext(
  cwd: string,
  args: readonly string[],
  operationId: string,
  queue: CwdWriteQueueStart,
): GitWriteOperationContext {
  const resolved = path.resolve(cwd)
  return {
    operationId,
    command: args[0] || '(unknown)',
    cwdBase: basenameForLog(resolved),
    cwdHash: shortHash(resolved),
    queuedAhead: queue.queuedAhead,
    waitMs: queue.waitMs,
  }
}

async function attemptStaleIndexLockCleanup(
  cwd: string,
  context: GitWriteOperationContext,
  phase: 'pre-write' | 'before-retry',
): Promise<void> {
  const removal = await tryRemoveStaleIndexLock(cwd)
  if (removal.removed) {
    safeGitLog('warn', 'removed stale git index lock', {
      ...context,
      phase,
      staleLockCandidate: true,
    })
    return
  }
  if (removal.staleLockCandidate) {
    safeGitLog('warn', 'stale git index lock cleanup skipped', {
      ...context,
      phase,
      staleLockCandidate: true,
      ...(removal.removeErrorCode ? { removeErrorCode: removal.removeErrorCode } : {}),
    })
  }
}

function buildIndexLockConflictDiagnostics(
  context: GitWriteOperationContext,
  event: IndexLockRetryEvent,
  snapshot?: GitIndexLockDiagnostics,
  staleLockCandidate?: boolean,
  agedLockBlockedByActiveGit?: boolean,
): Record<string, unknown> {
  return {
    ...context,
    phase: event.exhausted ? 'exhausted' : 'retry-scheduled',
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    nextDelayMs: event.nextDelayMs,
    elapsedMs: event.elapsedMs,
    ...(snapshot ?? {}),
    ...(staleLockCandidate ? { staleLockCandidate: true } : {}),
    ...(agedLockBlockedByActiveGit ? { agedLockBlockedByActiveGit: true } : {}),
  }
}

async function executeGitWrite(
  cwd: string,
  args: string[],
  operationId: string,
  queue: CwdWriteQueueStart,
  maxBuffer: number,
  timeout: number,
): Promise<string> {
  const context = buildGitWriteOperationContext(cwd, args, operationId, queue)
  const startedAt = Date.now()
  let lockConflictCount = 0
  safeGitLog('info', 'git write started', context)

  try {
    // 写操作前先尝试清理陈旧锁，避免 0.0.66 式「只诊断不动作」白白耗尽重试。
    await attemptStaleIndexLockCleanup(cwd, context, 'pre-write')

    const result = await withIndexLockRetry(
      () => runGit(cwd, args, maxBuffer, timeout),
      {
        beforeRetry: async () => {
          await attemptStaleIndexLockCleanup(cwd, context, 'before-retry')
        },
        onLockConflict: async (event) => {
          lockConflictCount = event.attempt
          // 只在重试耗尽时做进程扫描，避免诊断逻辑拉长正常的短暂锁重试。
          const snapshot = event.exhausted
            ? await collectGitIndexLockDiagnostics(cwd)
            : undefined
          const staleLockCandidate = snapshot
            ? isStaleIndexLockCandidate(snapshot)
            : false
          const agedLockBlockedByActiveGit = Boolean(
            snapshot &&
              snapshot.lockState === 'present' &&
              snapshot.lockAgeMs != null &&
              snapshot.lockAgeMs > INDEX_LOCK_STALE_THRESHOLD_MS &&
              snapshot.processProbe === 'ok' &&
              (snapshot.activeGitProcessCount ?? 0) > 0,
          )
          safeGitLog(
            'warn',
            'git index lock conflict',
            buildIndexLockConflictDiagnostics(
              context,
              event,
              snapshot,
              staleLockCandidate,
              agedLockBlockedByActiveGit,
            ),
          )
        },
      },
    )
    safeGitLog('info', 'git write completed', {
      ...context,
      durationMs: Date.now() - startedAt,
      attemptCount: lockConflictCount + 1,
      recoveredFromIndexLock: lockConflictCount > 0,
    })
    return result
  } catch (error) {
    const indexLockConflict = isGitIndexLockError(error)
    safeGitLog('warn', 'git write command failed', {
      ...context,
      durationMs: Date.now() - startedAt,
      attemptCount: indexLockConflict ? lockConflictCount : 1,
      indexLockConflict,
    })
    tagGitWriteError(error, operationId)
    throw error
  }
}

async function runGitWrite(
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
  timeout = 20_000,
): Promise<string> {
  const operationId = randomUUID()
  let queue: CwdWriteQueueStart = { queuedAhead: 0, waitMs: 0 }
  return withCwdWriteQueue(
    cwd,
    () => executeGitWrite(cwd, args, operationId, queue, maxBuffer, timeout),
    { onStart: (event) => { queue = event } },
  )
}

/**
 * 取消暂存需要区分仓库是否已有首个提交：
 * - 有 HEAD：使用 restore/reset，把 index 恢复到 HEAD；
 * - 无 HEAD：没有可恢复的树，只从 index 删除条目，保留工作区文件。
 *
 * HEAD 判断和写入放在同一 cwd 写队列内，避免应用内并发提交改变判断结果。
 */
async function runGitUnstage(
  cwd: string,
  paths: readonly string[],
  maxBuffer = 1024 * 1024,
  timeout = 20_000,
): Promise<string> {
  const operationId = randomUUID()
  let queue: CwdWriteQueueStart = { queuedAhead: 0, waitMs: 0 }
  return withCwdWriteQueue(
    cwd,
    async () => {
      let hasHead: boolean
      try {
        await runGit(cwd, ['rev-parse', '--verify', 'HEAD'])
        hasHead = true
      } catch (error) {
        // 不根据 stderr 文案猜测：损坏 HEAD、权限失败和 unborn branch 可能给出
        // 相似错误。porcelain v2 的 `(initial)` 是 Git 对“尚无首个提交”的稳定标识。
        const status = await runGit(cwd, [
          'status',
          '--porcelain=2',
          '--branch',
          '--untracked-files=no',
        ])
        if (!status.split(/\r?\n/).includes('# branch.oid (initial)')) {
          throw error
        }
        hasHead = false
      }
      const args = hasHead
        ? (paths.length === 0
            ? ['reset']
            : ['restore', '--staged', '--', ...paths])
        : (paths.length === 0
            ? ['read-tree', '--empty']
            : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...paths])

      return executeGitWrite(cwd, args, operationId, queue, maxBuffer, timeout)
    },
    { onStart: (event) => { queue = event } },
  )
}

async function runCommand(
  command: string,
  cwd: string,
  args: string[],
  maxBuffer = 1024 * 1024,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer,
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

async function commandExists(command: string, cwd: string): Promise<boolean> {
  try {
    await runCommand(command, cwd, ['--version'], 256 * 1024, 10_000)
    return true
  } catch {
    return false
  }
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/i)
  return match ? match[0] || null : null
}

/**
 * 把 gh / glab 创建 PR/MR 的原始错误映射成用户可读的提示。
 * 远端服务返回的 GraphQL / API 原文（如 "Head sha can't be blank"）对用户不可读，
 * 这里识别几类高频原因并给出可操作说明；无法识别时回退原文。
 */
function describePrCreateError(
  rawMessage: string,
  context: { baseBranch: string; headBranch: string },
): string {
  const raw = rawMessage || ''
  const lower = raw.toLowerCase()

  // base 与 head 之间没有提交差异——真正无内容可 PR。
  if (lower.includes('no commits between')) {
    return `分支 '${context.headBranch}' 相对 '${context.baseBranch}' 没有提交差异，无需创建 PR`
  }
  // base 分支在远端不存在（常见于 main/master 命名不一致或目标分支未推送）。
  if (lower.includes('base ref must be a branch') || lower.includes("base sha can't be blank")) {
    return `目标分支 '${context.baseBranch}' 在远端不存在，请确认它已存在于远端（注意 main 与 master 命名差异）`
  }
  // head 分支在远端不存在——自动推送后仍出现说明推送未生效。
  if (lower.includes("head sha can't be blank")) {
    return `源分支 '${context.headBranch}' 未能推送到远端，请检查推送权限或网络后重试`
  }
  return raw
}

/**
 * 解析 `git diff --numstat -z <range>` 输出。
 *
 * [#4915] `-z` 下的 numstat 记录比 status/name-status 多一层花样：普通记录是
 * `added\tdeleted\t<path>\0`，但 rename/copy 记录是
 * `added\tdeleted\t\0<oldpath>\0<newpath>\0`——第二个 TAB 后先插入一个额外
 * 的 NUL 再跟旧路径、新路径。因此不能直接 `split('\0')`，需要按位置扫描来
 * 区分这两种记录形态，否则会把旧路径当成本条记录的路径、把新路径错位归给
 * 下一条记录。
 */
function parseNumstatZ(raw: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>()
  const len = raw.length
  let pos = 0
  while (pos < len) {
    const tab1 = raw.indexOf('\t', pos)
    if (tab1 === -1) break
    const tab2 = raw.indexOf('\t', tab1 + 1)
    if (tab2 === -1) break
    const addedRaw = raw.slice(pos, tab1)
    const deletedRaw = raw.slice(tab1 + 1, tab2)
    const afterTabs = tab2 + 1

    let filePath: string
    let nextPos: number
    if (raw[afterTabs] === '\0') {
      const oldEnd = raw.indexOf('\0', afterTabs + 1)
      if (oldEnd === -1) break
      const newEnd = raw.indexOf('\0', oldEnd + 1)
      if (newEnd === -1) break
      filePath = raw.slice(oldEnd + 1, newEnd)
      nextPos = newEnd + 1
    } else {
      const pathEnd = raw.indexOf('\0', afterTabs)
      if (pathEnd === -1) break
      filePath = raw.slice(afterTabs, pathEnd)
      nextPos = pathEnd + 1
    }
    pos = nextPos

    if (!filePath) continue
    const added = Number.parseInt(addedRaw, 10)
    const deleted = Number.parseInt(deletedRaw, 10)
    map.set(normalizePorcelainPath(filePath), {
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
    })
  }
  return map
}

/**
 * 解析 `git diff --name-status -z <range>` 输出。
 *
 * [#4915] 普通记录是 `status\0path\0`；rename/copy（状态形如 `R100`/`C100`）
 * 是 `status\0oldpath\0newpath\0`——与 numstat 不同，这里没有多余的 NUL，
 * 三个字段直接顺序排列，可以安全地整体 `split('\0')` 后按 token 游标消费。
 */
function parseNameStatusZ(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  const tokens = raw.split('\0')
  let i = 0
  while (i < tokens.length) {
    const statusRaw = tokens[i]
    i += 1
    if (!statusRaw) continue
    const statusChar = statusRaw.trim().charAt(0).toUpperCase() || 'M'
    let filePath: string | undefined
    if (statusChar === 'R' || statusChar === 'C') {
      i += 1 // 旧路径，仅用新路径作为 map key
      filePath = tokens[i]
      i += 1
    } else {
      filePath = tokens[i]
      i += 1
    }
    if (!filePath) continue
    map.set(normalizePorcelainPath(filePath), statusChar)
  }
  return map
}

function parseBranchMeta(raw: string): GitBranchMeta {
  const meta: GitBranchMeta = {
    branch: '',
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
  }

  for (const line of raw.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head === '(detached)') {
        meta.isDetached = true
        meta.branch = ''
      } else {
        meta.branch = head
      }
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      const upstream = line.slice('# branch.upstream '.length).trim()
      meta.upstream = upstream || null
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+\-(\d+)/)
      if (match) {
        meta.ahead = parseInt(match[1] || '0', 10) || 0
        meta.behind = parseInt(match[2] || '0', 10) || 0
      }
      continue
    }
  }

  return meta
}

function parseRemotes(raw: string): GitRemoteInfo[] {
  const map = new Map<string, GitRemoteInfo>()
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!match) continue
    const name = match[1] || ''
    const url = match[2] || ''
    const type = match[3] || ''
    if (!name || !url || !type) continue
    const prev = map.get(name) ?? {
      name,
      fetchUrl: null,
      pushUrl: null,
    }
    if (type === 'fetch') prev.fetchUrl = url
    if (type === 'push') prev.pushUrl = url
    map.set(name, prev)
  }
  return Array.from(map.values())
}

function parseRemoteUrl(remoteUrl: string): ParsedRemoteUrl {
  const ssh = remoteUrl.match(/^(?:ssh:\/\/)?(?:git@)?([^:/]+)[:/]([^/]+(?:\/[^/]+)*)\/([^/]+?)(?:\.git)?$/i)
  const http = remoteUrl.match(/^(?:https?:\/\/|git:\/\/)([^/]+)\/([^/]+(?:\/[^/]+)*)\/([^/]+?)(?:\.git)?$/i)
  const match = ssh || http
  if (!match) {
    return { provider: 'unknown', webRepoUrl: null }
  }

  const host = (match[1] || '').toLowerCase()
  const ownerPath = match[2] || ''
  const repoName = match[3] || ''
  if (!host || !ownerPath || !repoName) {
    return { provider: 'unknown', webRepoUrl: null }
  }

  const webRepoUrl = `https://${host}/${ownerPath}/${repoName}`
  if (host.includes('github.com')) {
    return { provider: 'github', webRepoUrl }
  }
  if (host.includes('gitlab')) {
    return { provider: 'gitlab', webRepoUrl }
  }

  return { provider: 'unknown', webRepoUrl }
}

async function getRemoteDefaultBranch(cwd: string, remoteName: string): Promise<string | null> {
  try {
    const ref = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remoteName}/HEAD`])
    const value = ref.trim()
    if (!value) return null
    const prefix = `${remoteName}/`
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  } catch {
    return null
  }
}

export type WorkingTreeProbeState = 'clean' | 'dirty' | 'unknown'

export interface WorkingTreeProbe {
  state: WorkingTreeProbeState
  detail?: string
  fingerprint?: string
}

export async function probeWorkingTree(cwd: string): Promise<WorkingTreeProbe> {
  try {
    const status = await runGit(cwd, ['status', '--porcelain=v1', '-uall'], 5 * 1024 * 1024)
    return {
      state: status.trim().length > 0 ? 'dirty' : 'clean',
      fingerprint: createHash('sha256').update(status).digest('hex').slice(0, 16),
    }
  } catch (error) {
    const detail = redactGitDetail(getGitErrorMessage(error), cwd)
    safeGitLog('warn', 'git working tree probe failed', {
      cwdHash: createHash('sha256').update(cwd).digest('hex').slice(0, 12),
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return { state: 'unknown', detail }
  }
}

async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    return (await runGit(cwd, ['branch', '--show-current'])).trim()
  } catch {
    return ''
  }
}

async function getBranchMeta(cwd: string): Promise<GitBranchMeta> {
  try {
    const raw = await runGit(cwd, ['status', '--porcelain=2', '--branch'])
    return parseBranchMeta(raw)
  } catch {
    return {
      branch: '',
      upstream: null,
      ahead: 0,
      behind: 0,
      isDetached: false,
    }
  }
}

async function resolvePullRequestContext(
  cwd: string,
  options?: { remote?: string; baseBranch?: string; headBranch?: string },
): Promise<{ success: true; context: PullRequestContext } | { success: false; error: string }> {
  try {
    const remotesRaw = await runGit(cwd, ['remote', '-v'], 2 * 1024 * 1024)
    const remotes = parseRemotes(remotesRaw)
    const remoteName = options?.remote?.trim()
      || remotes.find((item) => item.name === 'origin')?.name
      || remotes[0]?.name
      || ''
    if (!remoteName) {
      return { success: false, error: 'remote not found' }
    }

    const remoteInfo = remotes.find((item) => item.name === remoteName)
    const remoteUrl = remoteInfo?.pushUrl || remoteInfo?.fetchUrl || ''
    if (!remoteUrl) {
      return { success: false, error: 'remote url not found' }
    }

    const parsedRemote = parseRemoteUrl(remoteUrl)
    if (!parsedRemote.webRepoUrl || parsedRemote.provider === 'unknown') {
      return { success: false, error: 'provider not supported' }
    }

    const headBranch = options?.headBranch?.trim() || (await getCurrentBranch(cwd))
    if (!headBranch) {
      return { success: false, error: 'current branch not found' }
    }

    const baseBranch = options?.baseBranch?.trim()
      || (await getRemoteDefaultBranch(cwd, remoteName))
      || 'main'

    return {
      success: true,
      context: {
        provider: parsedRemote.provider,
        remoteName,
        baseBranch,
        headBranch,
        webRepoUrl: parsedRemote.webRepoUrl,
      },
    }
  } catch (error) {
    return { success: false, error: getGitErrorMessage(error) }
  }
}

async function buildDiffSummary(cwd: string, range: string): Promise<GitDiffSummary> {
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    runGit(cwd, ['diff', '--numstat', '-z', range], 8 * 1024 * 1024, 120_000),
    runGit(cwd, ['diff', '--name-status', '-z', range], 8 * 1024 * 1024, 120_000),
  ])

  const numstatMap = parseNumstatZ(numstatRaw)
  const statusMap = parseNameStatusZ(nameStatusRaw)
  const paths = new Set<string>([
    ...Array.from(numstatMap.keys()),
    ...Array.from(statusMap.keys()),
  ])

  let insertions = 0
  let deletions = 0
  const files: GitDiffFileSummary[] = []

  for (const path of paths) {
    const num = numstatMap.get(path) ?? { added: 0, deleted: 0 }
    insertions += num.added
    deletions += num.deleted
    files.push({
      path,
      status: statusMap.get(path) || 'M',
      added: num.added,
      deleted: num.deleted,
    })
  }

  files.sort((a, b) => {
    const aDelta = a.added + a.deleted
    const bDelta = b.added + b.deleted
    if (aDelta !== bDelta) return bDelta - aDelta
    return a.path.localeCompare(b.path)
  })

  return {
    range,
    filesChanged: files.length,
    insertions,
    deletions,
    files,
  }
}

function sanitizeRelativePath(filePath: string): string | null {
  if (!filePath) return null
  const slashPath = filePath.trim().replace(/\\/g, '/')
  if (
    !slashPath ||
    path.isAbsolute(filePath) ||
    path.win32.isAbsolute(slashPath) ||
    path.posix.isAbsolute(slashPath) ||
    /^[a-zA-Z]:/.test(slashPath)
  ) {
    return null
  }
  const normalized = path.posix.normalize(slashPath)
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

const CWD_ERROR = {
  success: false,
  code: 'INVALID_REPOSITORY',
  error: 'invalid working directory',
} as const
const PATH_ERROR = {
  success: false,
  code: 'INVALID_PATH',
  error: 'invalid file path',
} as const

/** 归一化仓库根路径，供与 `rev-parse --show-toplevel` 结果比对（Windows 大小写不敏感）。 */
function normalizeGitRepoRootPath(p: string): string {
  const resolved = path.resolve(p.trim())
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 判断 cwd 本身是否为 Git 仓库根（而非仅位于某仓库的工作树内）。
 * 用于 Space 绑定目录是否展示「Git 流程模式」——子目录不应因祖先仓库误判。
 */
async function cwdIsGitRepoRoot(cwd: string): Promise<boolean> {
  try {
    const topLevel = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
    return normalizeGitRepoRootPath(topLevel) === normalizeGitRepoRootPath(cwd)
  } catch {
    return false
  }
}

function worktreeAssessmentToken(input: {
  path: string
  commitHash: string | null
  dirty: boolean
  fingerprint?: string
  bindings: Array<{ sessionId: string; revision: number; busy: boolean }>
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      path: normalizeFsPath(input.path),
      commitHash: input.commitHash,
      dirty: input.dirty,
      fingerprint: input.fingerprint,
      bindings: input.bindings
        .map((binding) => ({
          sessionId: binding.sessionId,
          revision: binding.revision,
          busy: binding.busy,
        }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    }))
    .digest('hex')
    .slice(0, 32)
}

async function assessWorktreeRemoval(
  cwd: string,
  worktreePath: string,
): Promise<WorktreeRemovePreflightResult> {
  if (!validateCwd(cwd, 'write')) {
    return {
      success: false,
      canRemove: false,
      reason: 'invalid_cwd',
      code: 'INVALID_REPOSITORY',
      error: CWD_ERROR.error,
    }
  }
  const normalizedTarget = path.resolve(cwd, worktreePath.trim())
  if (!worktreePath.trim()) {
    return {
      success: false,
      canRemove: false,
      reason: 'path_required',
      code: 'WORKTREE_PATH_REQUIRED',
      error: 'worktree path is required',
    }
  }
  const targetAccess = checkAndFormat(normalizedTarget, 'write')
  if (!targetAccess.ok) {
    return {
      success: false,
      canRemove: false,
      reason: 'path_access_denied',
      code: 'PERMISSION_DENIED',
      error: targetAccess.error,
      detail: targetAccess.error,
    }
  }

  try {
    const [currentPathRaw, worktreeRaw] = await Promise.all([
      runGit(cwd, ['rev-parse', '--show-toplevel']),
      runGit(cwd, ['worktree', 'list', '--porcelain'], 5 * 1024 * 1024),
    ])
    const worktrees = parseWorktrees(worktreeRaw, currentPathRaw.trim())
    const target = worktrees.find(
      (item) => normalizeFsPath(item.path) === normalizeFsPath(normalizedTarget),
    )
    if (!target) {
      return {
        success: false,
        canRemove: false,
        reason: 'worktree_not_found',
        code: 'WORKTREE_NOT_FOUND',
        error: 'worktree not found',
      }
    }
    if (target.isMainWorktree) {
      return {
        success: true,
        canRemove: false,
        reason: 'main_worktree',
        code: 'MAIN_WORKTREE',
        error: 'cannot remove the main worktree',
        targetPath: target.path,
        branch: target.branch,
        isMainWorktree: true,
        isCurrentWorktree: target.isCurrent,
      }
    }
    if (target.isCurrent) {
      return {
        success: true,
        canRemove: false,
        reason: 'current_worktree',
        code: 'WORKTREE_IN_USE',
        error: 'cannot remove the current worktree',
        targetPath: target.path,
        branch: target.branch,
        isMainWorktree: false,
        isCurrentWorktree: true,
      }
    }
    if (target.isLocked) {
      return {
        success: true,
        canRemove: false,
        reason: 'worktree_locked',
        code: 'WORKTREE_LOCKED',
        error: 'worktree is locked',
        targetPath: target.path,
        branch: target.branch,
        isMainWorktree: false,
        isLocked: true,
        lockReason: target.lockReason,
      }
    }

    const workingTree = await probeWorkingTree(target.path)
    if (workingTree.state === 'unknown') {
      return {
        success: true,
        canRemove: false,
        reason: 'working_tree_unknown',
        code: 'WORKING_TREE_UNKNOWN',
        error: 'unable to determine whether the worktree is clean',
        detail: workingTree.detail,
        targetPath: target.path,
        branch: target.branch,
      }
    }

    const probe = getWorktreeRemoveRuntimeProbe()
    if (!probe) {
      return {
        success: true,
        canRemove: false,
        reason: 'runtime_unavailable',
        code: 'RUNTIME_UNAVAILABLE',
        error: 'worktree runtime is not ready',
        targetPath: target.path,
        branch: target.branch,
      }
    }
    let bindings
    try {
      bindings = await probe.listBindingsForRoot(target.path)
    } catch (error) {
      if (isBindingsUnknownError(error)) {
        return {
          success: true,
          canRemove: false,
          reason: 'bindings_unknown',
          code: 'RUNTIME_UNAVAILABLE',
          error: 'session code-root bindings are not restored yet',
          targetPath: target.path,
          branch: target.branch,
        }
      }
      throw error
    }
    const base = {
      targetPath: target.path,
      branch: target.branch,
      isMainWorktree: false,
      isCurrentWorktree: false,
      isLocked: false,
      dirty: workingTree.state === 'dirty',
      bindings,
      assessmentToken: worktreeAssessmentToken({
        path: target.path,
        commitHash: target.commitHash,
        dirty: workingTree.state === 'dirty',
        fingerprint: workingTree.fingerprint,
        bindings,
      }),
    }
    if (bindings.length > 0) {
      const busy = bindings.some((binding) => binding.busy)
      return {
        success: true,
        canRemove: false,
        reason: busy ? 'session_busy' : 'session_bound',
        code: 'WORKTREE_IN_USE',
        error: busy
          ? 'worktree is used by a running session'
          : 'worktree is still bound to a session',
        ...base,
      }
    }
    if (workingTree.state === 'dirty') {
      return {
        success: true,
        canRemove: false,
        canForce: true,
        reason: 'worktree_dirty',
        code: 'WORKTREE_REMOVE_BLOCKED',
        error: 'worktree contains modified or untracked files; use --force to delete it',
        ...base,
      }
    }
    return {
      success: true,
      canRemove: true,
      ...base,
    }
  } catch (error) {
    const message = getGitErrorMessage(error)
    return {
      success: false,
      canRemove: false,
      code: classifyGitErrorCode(message),
      error: message,
      detail: redactGitDetail(message, cwd),
    }
  }
}

async function removeWorktreeSafely(
  cwd: string,
  worktreePath: string,
  options?: { force?: boolean; assessmentToken?: string; timeout?: number },
): Promise<WorktreeRemoveResult> {
  if (!validateCwd(cwd, 'write')) return CWD_ERROR
  const trimmedPath = worktreePath.trim()
  if (!trimmedPath) {
    return {
      success: false,
      code: 'WORKTREE_PATH_REQUIRED',
      error: 'worktree path is required',
    }
  }
  const requestedPath = path.resolve(cwd, trimmedPath)
  const targetAccess = checkAndFormat(requestedPath, 'write')
  if (!targetAccess.ok) {
    return {
      success: false,
      code: 'PERMISSION_DENIED',
      error: targetAccess.error,
      detail: targetAccess.error,
    }
  }

  const operationId = randomUUID()
  let queue: CwdWriteQueueStart = { queuedAhead: 0, waitMs: 0 }
  return withCwdWriteQueues(
    [cwd, requestedPath],
    async () => {
      const probe = getWorktreeRemoveRuntimeProbe()
      if (!probe) {
        return {
          success: false,
          code: 'RUNTIME_UNAVAILABLE',
          error: 'worktree runtime is not ready',
        }
      }

      let releaseReservation: (() => void) | null = null
      try {
        releaseReservation = await probe.reserveRootForRemoval(requestedPath)
        if (!releaseReservation) {
          return {
            success: false,
            code: 'WORKTREE_IN_USE',
            error: 'worktree removal is already in progress',
          }
        }

        const preflight = await assessWorktreeRemoval(cwd, trimmedPath)
        if (!preflight.success || !preflight.canRemove) {
          const forceAllowed = Boolean(
            options?.force
            && preflight.reason === 'worktree_dirty'
            && preflight.canForce
            && options.assessmentToken
            && options.assessmentToken === preflight.assessmentToken,
          )
          if (!forceAllowed) {
            return {
              success: false,
              code: preflight.code,
              error: preflight.error,
              detail: preflight.detail,
              assessmentToken: preflight.assessmentToken,
            }
          }
        }

        const targetPath = preflight.targetPath ?? requestedPath
        const args = ['worktree', 'remove', ...(options?.force ? ['--force'] : []), targetPath]
        await executeGitWrite(cwd, args, operationId, queue, 8 * 1024 * 1024, options?.timeout ?? 20_000)

        const clearedSessionIds: string[] = []
        const warnings: GitActionWarning[] = []
        try {
          clearedSessionIds.push(...await probe.clearBindingsForRoot(targetPath))
        } catch (cleanupError) {
          warnings.push({
            code: 'BINDING_CLEANUP_FAILED',
            error: 'worktree removed but session binding cleanup failed',
            detail: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          })
          safeGitLog('warn', 'worktree removed but session binding cleanup failed', {
            errorType: cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
          })
        }
        return {
          success: true,
          ...(clearedSessionIds.length ? { clearedSessionIds } : {}),
          ...(warnings.length ? { warnings } : {}),
        }
      } catch (error) {
        return classifyGitFailure({
          message: getGitErrorMessage(error),
          cwd,
        })
      } finally {
        releaseReservation?.()
      }
    },
    { onStart: (event) => { queue = event } },
  )
}

export function registerGitIpcHandlers(): void {
  /**
   * 判断路径本身是否为 Git 仓库根（不是「位于任意仓库内」）。
   */
  guardedHandle('git:isRepo', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { success: true, isRepo: false }
    const isRepo = await cwdIsGitRepoRoot(cwd)
    return { success: true, isRepo }
  })

  /**
   * 获取当前分支名
   */
  guardedHandle('git:branch', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { ...CWD_ERROR, branch: '' }
    try {
      const result = await runGit(cwd, ['branch', '--show-current'])
      return { success: true, branch: result.trim() }
    } catch {
      return { success: false, branch: '' }
    }
  })

  /**
   * 获取当前分支元信息（upstream/ahead/behind）
   */
  guardedHandle('git:branchMeta', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return CWD_ERROR
    try {
      const raw = await runGit(cwd, ['status', '--porcelain=2', '--branch'])
      return { success: true, meta: parseBranchMeta(raw) }
    } catch (error) {
      return {
        success: false,
        meta: {
          branch: '',
          upstream: null,
          ahead: 0,
          behind: 0,
          isDetached: false,
        },
        error: getGitErrorMessage(error),
      }
    }
  })

  /**
   * 获取本地/远程分支列表
   */
  guardedHandle('git:branches', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { ...CWD_ERROR, localBranches: [], remoteBranches: [] }
    try {
      const [localsRaw, remotesRaw] = await Promise.all([
        runGit(
          cwd,
          ['for-each-ref', '--format=%(refname:short)|%(upstream:short)|%(HEAD)|%(objectname:short)', 'refs/heads'],
          2 * 1024 * 1024,
        ),
        runGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], 2 * 1024 * 1024),
      ])

      const localBranches = localsRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name = '', upstream = '', head = '', commitHash = ''] = line.split('|')
          return {
            name: name.trim(),
            upstream: upstream.trim() || null,
            isCurrent: head.trim() === '*',
            commitHash: commitHash.trim() || null,
          }
        })
        .filter((item) => Boolean(item.name))

      const remoteBranches = remotesRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.endsWith('/HEAD'))

      return { success: true, localBranches, remoteBranches }
    } catch (error) {
      return {
        success: false,
        localBranches: [],
        remoteBranches: [],
        error: getGitErrorMessage(error),
      }
    }
  })

  /**
   * 切换分支（可选创建新分支）
   */
  guardedHandle(
    'git:checkout',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { branch?: string; create?: boolean; startPoint?: string; allowDirty?: boolean },
    ) => {
      // P1-Q2 修：checkout 分支会重写整个工作树（含 deny WRITE 列表里的文件），
      // 必须按 'write' 验 cwd 才能让 deny pattern 在路径前缀级别生效。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      const branch = options?.branch?.trim() || ''
      const create = Boolean(options?.create)
      const startPoint = options?.startPoint?.trim() || ''
      const allowDirty = Boolean(options?.allowDirty)
      if (!branch) {
        return { success: false, error: 'branch is required' }
      }
      if (!sanitizeGitRef(branch)) {
        return { success: false, error: 'invalid branch name: contains disallowed characters or patterns' }
      }
      if (startPoint && !sanitizeGitRef(startPoint)) {
        return { success: false, error: 'invalid startPoint: contains disallowed characters or patterns' }
      }

      try {
        const workingTree = await probeWorkingTree(cwd)
        if (workingTree.state === 'unknown') {
          return classifyGitFailure({
            code: 'WORKING_TREE_UNKNOWN',
            message: 'unable to determine whether the working tree is clean',
            detail: workingTree.detail,
            cwd,
          })
        }
        if (workingTree.state === 'dirty' && !allowDirty) {
          safeGitLog('warn', 'git checkout blocked: dirty worktree', {
            action: 'checkout',
            create,
            allowDirty: false,
          })
          return classifyGitFailure({
            code: 'WORKING_TREE_DIRTY',
            message: 'working tree has uncommitted changes, please commit/stash first',
            cwd,
          })
        }

        const args = create
          ? ['checkout', '-b', branch, ...(startPoint ? [startPoint] : [])]
          : ['checkout', branch]
        await runGitWrite(cwd, args, 2 * 1024 * 1024)
        return { success: true }
      } catch (error) {
        const message = getGitErrorMessage(error)
        safeGitLog('warn', 'git checkout failed', {
          action: 'checkout',
          create,
          allowDirty,
          error: message.slice(0, 300),
        })
        return { success: false, error: message }
      }
    },
  )

  /**
   * 获取 Git 状态（porcelain v1 格式）
   * 返回 { path: status } 映射
   */
  guardedHandle('git:status', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { success: false, files: {}, entries: {}, error: 'invalid working directory' }
    try {
      // [#4915] `-z`：NUL 分隔 + 禁用 quotepath 转义，中文/空格/引号路径原样直传。
      const result = await runGit(cwd, ['status', '--porcelain=v1', '-uall', '-z'], 5 * 1024 * 1024)
      const { files, entries } = parsePorcelainV1StatusZ(result)
      return { success: true, files, entries }
    } catch (error) {
      return { success: false, files: {}, entries: {}, error: getGitErrorMessage(error) }
    }
  })

  /**
   * 获取 diff 统计信息（total = HEAD vs worktree, staged = HEAD vs index, unstaged = index vs worktree）
   */
  guardedHandle('git:diffStat', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return CWD_ERROR
    const emptyGroup: GitDiffStatGroup = { added: 0, deleted: 0, changed: 0 }
    try {
      const [totalRaw, unstagedRaw, stagedRaw] = await Promise.all([
        runGit(cwd, ['diff', 'HEAD', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
        runGit(cwd, ['diff', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
        runGit(cwd, ['diff', '--cached', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
      ])

      const parseDiffNumstat = (raw: string): GitDiffStatGroup => {
        let added = 0, deleted = 0, changed = 0
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          const parts = line.split('\t')
          if (parts.length < 3) continue
          const a = parseInt(parts[0], 10) || 0
          const d = parseInt(parts[1], 10) || 0
          added += a
          deleted += d
          changed++
        }
        return { added, deleted, changed }
      }

      const stat: GitDiffStatResult = {
        total: parseDiffNumstat(totalRaw),
        unstaged: parseDiffNumstat(unstagedRaw),
        staged: parseDiffNumstat(stagedRaw),
      }

      return { success: true, stat }
    } catch {
      return { success: false, stat: { total: emptyGroup, unstaged: emptyGroup, staged: emptyGroup } }
    }
  })

  /**
   * 获取 HEAD 版本的文件内容（用于 DiffEditor 左侧）
   * 使用 cat-file 避免 git show 的路径歧义问题
   */
  guardedHandle('git:showFile', async (_event, cwd: string, filePath: string) => {
    if (!validateCwd(cwd, 'read')) return { success: true, content: '' }
    const safePath = sanitizeRelativePath(filePath)
    if (!safePath) return { ...PATH_ERROR, content: '' }
    const fullPath = path.resolve(cwd, safePath)
    if (!checkAndFormat(fullPath, 'read').ok) return { ...PATH_ERROR, content: '' }
    try {
      const content = await runGit(cwd, ['cat-file', 'blob', `HEAD:${safePath}`], 2 * 1024 * 1024)
      return { success: true, content }
    } catch {
      return { success: true, content: '' }
    }
  })

  /**
   * 获取暂存区版本的文件内容（staged diff 左侧 / unstaged diff 右侧）
   */
  guardedHandle('git:showStaged', async (_event, cwd: string, filePath: string) => {
    if (!validateCwd(cwd, 'read')) return { success: true, content: '' }
    const safePath = sanitizeRelativePath(filePath)
    if (!safePath) return { ...PATH_ERROR, content: '' }
    const fullPath = path.resolve(cwd, safePath)
    if (!checkAndFormat(fullPath, 'read').ok) return { ...PATH_ERROR, content: '' }
    try {
      const content = await runGit(cwd, ['cat-file', 'blob', `:0:${safePath}`], 2 * 1024 * 1024)
      return { success: true, content }
    } catch {
      return { success: true, content: '' }
    }
  })

  /**
   * 获取指定 commit 上的文件内容（提交历史 Diff 左右侧）。
   * parent=true 时取父提交（根提交无 parent → 空内容）。
   */
  guardedHandle(
    'git:showAtCommit',
    async (
      _event,
      cwd: string,
      options?: { filePath?: string; commitHash?: string; parent?: boolean },
    ) => {
      if (!validateCwd(cwd, 'read')) return { success: true, content: '' }
      const safePath = sanitizeRelativePath(options?.filePath || '')
      const commitHash = options?.commitHash?.trim() || ''
      if (!safePath || !commitHash || !sanitizeGitRef(commitHash)) {
        return { ...PATH_ERROR, content: '' }
      }
      const fullPath = path.resolve(cwd, safePath)
      if (!checkAndFormat(fullPath, 'read').ok) return { ...PATH_ERROR, content: '' }
      const rev = options?.parent ? `${commitHash}^` : commitHash
      try {
        const content = await runGit(
          cwd,
          ['cat-file', 'blob', `${rev}:${safePath}`],
          2 * 1024 * 1024,
        )
        return { success: true, content }
      } catch {
        return { success: true, content: '' }
      }
    },
  )

  /**
   * 获取原始 diff 输出（Agent 工具用）
   */
  guardedHandle('git:rawDiff', async (_event, cwd: string, extraArgs?: string[]) => {
    if (!validateCwd(cwd, 'read')) return CWD_ERROR
    const safeFlags = new Set(['--cached', '--staged', '--', '--numstat', '--stat', '--name-only', '--name-status'])
    const safeRevisions = new Set(['HEAD'])
    const resolvedCwd = path.resolve(cwd)
    const normalizedCwd = resolvedCwd.normalize('NFC')
    const args = ['diff']
    let pathspecMode = false
    if (Array.isArray(extraArgs)) {
      for (const a of extraArgs) {
        if (typeof a !== 'string') return PATH_ERROR
        if (a === '--') {
          args.push(a)
          pathspecMode = true
        } else if (!pathspecMode && safeFlags.has(a)) {
          args.push(a)
        } else if (!pathspecMode && safeRevisions.has(a)) {
          args.push(a)
        } else if (!pathspecMode && a.startsWith('-')) {
          return PATH_ERROR
        } else {
          const safePath = sanitizeRelativePath(a)
          if (!safePath) return PATH_ERROR
          const resolved = path.resolve(cwd, safePath)
          const normalizedResolved = resolved.normalize('NFC')
          if (!(normalizedResolved.startsWith(normalizedCwd + path.sep) || normalizedResolved === normalizedCwd)) {
            return PATH_ERROR
          }
          const access = checkAndFormat(resolved, 'read')
          if (!access.ok) return PATH_ERROR
          args.push(a)
        }
      }
    }
    try {
      const result = await runGit(cwd, args, 8 * 1024 * 1024, 30_000)
      return { success: true, diff: result }
    } catch (error) {
      return { success: false, error: getGitErrorMessage(error) }
    }
  })

  /**
   * 暂存文件（paths 为空时暂存全部）
   */
  guardedHandle('git:stage', async (_event: IpcMainInvokeEvent, cwd: string, paths?: string[]) => {
    const pathspecs = normalizeGitPathspecs(paths)
    // P1-Q2 修：stage 写 .git/index 是写副作用，必须按 'write' 验 cwd。
    if (!validateCwd(cwd, 'write')) {
      logGitWriteBlocked('stage', cwd, pathspecs, 'invalid working directory')
      return CWD_ERROR
    }
    const invalidPathspecs = rejectInvalidGitPathspecs('stage', cwd, pathspecs)
    if (invalidPathspecs) return invalidPathspecs
    // P1-Q1 / ：显式 paths 逐条验 write deny。命中 `.env` 等只跳过该
    // 路径，其余照常 `git add`——避免「(根目录)」分组里夹着 deny 文件时
    // 整组暂存失败。全部被拒才返回 error。`add -A`（无 paths）仍只验 cwd；
    // 单点 deny 与 gitignore 的缺口另见 follow-up。
    let pathsToStage = pathspecs.cleanPaths
    let skippedPaths: string[] = []
    if (pathspecs.cleanPaths.length > 0) {
      const { allowed, denied } = partitionPathsWriteAccess(cwd, pathspecs.cleanPaths)
      if (allowed.length === 0) {
        const error = denied[0]?.error ?? 'path write access denied'
        logGitWriteBlocked('stage', cwd, pathspecs, 'path write access denied', error)
        return { success: false, error }
      }
      if (denied.length > 0) {
        skippedPaths = denied.map((item) => item.path)
        logGitWriteBlocked(
          'stage',
          cwd,
          pathspecs,
          'path write access denied (skipped)',
          denied[0]!.error,
        )
      }
      pathsToStage = allowed
    }
    try {
      if (pathspecs.cleanPaths.length === 0) {
        await runGitWrite(cwd, ['add', '-A'], 6 * 1024 * 1024)
      } else {
        await runGitWrite(cwd, ['add', '--', ...pathsToStage], 6 * 1024 * 1024)
      }
      const stagedPathspecs = pathspecs.cleanPaths.length === 0
        ? pathspecs
        : {
            ...pathspecs,
            cleanPaths: pathsToStage,
            droppedPathCount: pathspecs.droppedPathCount + skippedPaths.length,
          }
      logGitWriteSuccess('stage', cwd, stagedPathspecs)
      return skippedPaths.length > 0
        ? { success: true, skippedPaths, skippedCount: skippedPaths.length }
        : { success: true }
    } catch (error) {
      const errorMessage = getGitErrorMessage(error)
      logGitWriteFailure('stage', cwd, pathspecs, errorMessage, getGitWriteOperationId(error))
      return { success: false, error: errorMessage }
    }
  })

  /**
   * 取消暂存（paths 为空时取消全部）
   */
  guardedHandle('git:unstage', async (_event: IpcMainInvokeEvent, cwd: string, paths?: string[]) => {
    const pathspecs = normalizeGitPathspecs(paths)
    // P1-Q2 修：unstage 写 .git/index 是写副作用，必须按 'write' 验 cwd。
    if (!validateCwd(cwd, 'write')) {
      logGitWriteBlocked('unstage', cwd, pathspecs, 'invalid working directory')
      return CWD_ERROR
    }
    const invalidPathspecs = rejectInvalidGitPathspecs('unstage', cwd, pathspecs)
    if (invalidPathspecs) return invalidPathspecs
    // 与 stage 对称：deny 路径跳过，其余继续；全部被拒才失败。
    let pathsToUnstage = pathspecs.cleanPaths
    let skippedPaths: string[] = []
    if (pathspecs.cleanPaths.length > 0) {
      const { allowed, denied } = partitionPathsWriteAccess(cwd, pathspecs.cleanPaths)
      if (allowed.length === 0) {
        const error = denied[0]?.error ?? 'path write access denied'
        logGitWriteBlocked('unstage', cwd, pathspecs, 'path write access denied', error)
        return { success: false, error }
      }
      if (denied.length > 0) {
        skippedPaths = denied.map((item) => item.path)
        logGitWriteBlocked(
          'unstage',
          cwd,
          pathspecs,
          'path write access denied (skipped)',
          denied[0]!.error,
        )
      }
      pathsToUnstage = allowed
    }
    try {
      await runGitUnstage(cwd, pathsToUnstage, 6 * 1024 * 1024)
      const unstagedPathspecs = pathspecs.cleanPaths.length === 0
        ? pathspecs
        : {
            ...pathspecs,
            cleanPaths: pathsToUnstage,
            droppedPathCount: pathspecs.droppedPathCount + skippedPaths.length,
          }
      logGitWriteSuccess('unstage', cwd, unstagedPathspecs)
      return skippedPaths.length > 0
        ? { success: true, skippedPaths, skippedCount: skippedPaths.length }
        : { success: true }
    } catch (error) {
      const errorMessage = getGitErrorMessage(error)
      logGitWriteFailure('unstage', cwd, pathspecs, errorMessage, getGitWriteOperationId(error))
      return { success: false, error: errorMessage }
    }
  })

  /**
   * 提交
   */
  guardedHandle('git:commit', async (_event: IpcMainInvokeEvent, cwd: string, message?: string) => {
    // P1-Q2 修：commit 写 .git/objects + 移动 HEAD ref，是写副作用。
    if (!validateCwd(cwd, 'write')) return CWD_ERROR
    const commitMessage = (message || '').trim()
    if (!commitMessage) {
      return { success: false, error: 'commit message is required' }
    }
    try {
      await runGitWrite(cwd, ['commit', '-m', commitMessage], 6 * 1024 * 1024)
      const hash = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
      return { success: true, commitHash: hash }
    } catch (error) {
      return { success: false, error: getGitErrorMessage(error) }
    }
  })

  /**
   * 推送
   */
  guardedHandle(
    'git:push',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: {
        remote?: string
        branch?: string
        setUpstream?: boolean
        allowDirty?: boolean
        allowBehind?: boolean
        allowNoAhead?: boolean
      },
    ) => {
      // P1-Q2 修：push 写本地 ref（refs/heads/upstream tracking）+ 远端 ref，
      // 算写副作用。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      const remote = options?.remote?.trim() || ''
      const branch = options?.branch?.trim() || ''
      const setUpstream = Boolean(options?.setUpstream)
      const allowDirty = Boolean(options?.allowDirty)
      const allowBehind = Boolean(options?.allowBehind)
      const allowNoAhead = Boolean(options?.allowNoAhead)

      try {
        const meta = await getBranchMeta(cwd)
        if (meta.isDetached) {
          return classifyGitFailure({
            code: 'DETACHED_HEAD',
            message: 'detached HEAD cannot be pushed directly',
            cwd,
          })
        }

        const workingTree = await probeWorkingTree(cwd)
        if (workingTree.state === 'unknown') {
          return classifyGitFailure({
            code: 'WORKING_TREE_UNKNOWN',
            message: 'unable to determine whether the working tree is clean',
            detail: workingTree.detail,
            cwd,
          })
        }
        if (workingTree.state === 'dirty' && !allowDirty) {
          return classifyGitFailure({
            code: 'WORKING_TREE_DIRTY',
            message: 'working tree has uncommitted changes, push blocked by policy',
            cwd,
          })
        }

        if (meta.behind > 0 && !allowBehind) {
          return classifyGitFailure({
            code: 'BEHIND_UPSTREAM',
            message: `branch is behind upstream by ${meta.behind} commit(s), please pull/rebase first`,
            cwd,
          })
        }

        if (meta.upstream && meta.ahead <= 0 && !setUpstream && !allowNoAhead) {
          return classifyGitFailure({
            code: 'NO_COMMITS_TO_PUSH',
            message: 'no commits to push (ahead = 0)',
            cwd,
          })
        }

        const args = ['push']

        if (setUpstream) {
          args.push('-u', remote || 'origin')
          if (branch) {
            args.push(branch)
          } else {
            const currentBranch = await getCurrentBranch(cwd)
            if (currentBranch) args.push(currentBranch)
          }
        } else if (remote && branch) {
          args.push(remote, branch)
        } else if (remote) {
          args.push(remote)
        }

        await runGitWrite(cwd, args, 8 * 1024 * 1024, 120_000)
        return { success: true }
      } catch (error) {
        return classifyGitFailure({
          message: getGitErrorMessage(error),
          cwd,
        })
      }
    },
  )

  /**
   * 获取 remote 列表
   */
  guardedHandle('git:remotes', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { ...CWD_ERROR, remotes: [] }
    try {
      const raw = await runGit(cwd, ['remote', '-v'], 2 * 1024 * 1024)
      const remotes = parseRemotes(raw)
      return { success: true, remotes }
    } catch (error) {
      return { success: false, remotes: [], error: getGitErrorMessage(error) }
    }
  })

  /**
   * 获取 PR 创建链接（当前支持 GitHub/GitLab）
   */
  guardedHandle(
    'git:pullRequestUrl',
    async (_event, cwd: string, options?: { remote?: string; baseBranch?: string; headBranch?: string }) => {
      // git:pullRequestUrl 仅返回构造好的 web URL，不写仓库。
      if (!validateCwd(cwd, 'read')) return CWD_ERROR
      try {
        const resolved = await resolvePullRequestContext(cwd, options)
        if (!resolved.success) {
          return classifyGitFailure({
            message: resolved.error,
            cwd,
          })
        }
        const { context } = resolved

        let url = ''
        if (context.provider === 'github') {
          url = `${context.webRepoUrl}/compare/${encodeURIComponent(context.baseBranch)}...${encodeURIComponent(context.headBranch)}?expand=1`
        } else if (context.provider === 'gitlab') {
          const query = new URLSearchParams({
            'merge_request[source_branch]': context.headBranch,
            'merge_request[target_branch]': context.baseBranch,
          })
          url = `${context.webRepoUrl}/-/merge_requests/new?${query.toString()}`
        } else {
          return classifyGitFailure({
            code: 'PROVIDER_UNSUPPORTED',
            message: 'provider not supported',
            cwd,
          })
        }

        return {
          success: true,
          provider: context.provider,
          remote: context.remoteName,
          baseBranch: context.baseBranch,
          headBranch: context.headBranch,
          url,
        }
      } catch (error) {
        return classifyGitFailure({
          message: getGitErrorMessage(error),
          cwd,
        })
      }
    },
  )

  /**
   * 创建 Pull Request（GitHub: gh, GitLab: glab）
   */
  guardedHandle(
    'git:createPullRequest',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: {
        remote?: string
        baseBranch?: string
        headBranch?: string
        title?: string
        body?: string
        draft?: boolean
      },
    ) => {
      // P1-Q2 修：createPullRequest 调外部 CLI（gh / glab）创建远端 PR/MR——
      // 写远端 + 本地可能更新 ref，按 'write' 走。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      try {
        const resolved = await resolvePullRequestContext(cwd, options)
        if (!resolved.success) {
          return classifyGitFailure({
            message: resolved.error,
            cwd,
          })
        }

        const { context } = resolved
        const title = options?.title?.trim() || `${context.headBranch} -> ${context.baseBranch}`
        const body = options?.body ?? ''
        const draft = Boolean(options?.draft)

        // gh / glab 建 PR 要求 head 分支已存在于远端。交互式 CLI 会主动提示推送，
        // 但我们非交互式调用不会，因此这里显式推送 head 分支（设置 upstream，幂等：
        // 已是最新时为 no-op）。否则远端 head sha 为空，创建会以晦涩的 API 错误失败。
        try {
          await runGitWrite(cwd, ['push', '-u', context.remoteName, context.headBranch], 8 * 1024 * 1024, 120_000)
        } catch (error) {
          return classifyGitFailure({
            message: `推送源分支 '${context.headBranch}' 到 '${context.remoteName}' 失败：${getGitErrorMessage(error)}`,
            cwd,
          })
        }

        let diffSummary: GitDiffSummary | null = null
        try {
          diffSummary = await buildDiffSummary(cwd, `${context.baseBranch}...${context.headBranch}`)
        } catch {
          diffSummary = null
        }

        if (context.provider === 'github') {
          const hasGh = await commandExists('gh', cwd)
          if (!hasGh) {
            return classifyGitFailure({
              code: 'CLI_MISSING',
              message: 'GitHub CLI (gh) not found, please install and login first',
              cwd,
            })
          }

          const args = [
            'pr', 'create',
            '--base', context.baseBranch,
            '--head', context.headBranch,
            '--title', title,
            '--body', body,
          ]
          if (draft) {
            args.push('--draft')
          }

          let stdout = ''
          let stderr = ''
          try {
            ;({ stdout, stderr } = await runCommand('gh', cwd, args, 8 * 1024 * 1024, 120_000))
          } catch (error) {
            return classifyGitFailure({
              message: describePrCreateError(getGitErrorMessage(error), context),
              cwd,
            })
          }
          const url = stdout.trim() || extractFirstUrl(`${stdout}\n${stderr}`) || ''
          if (!url) {
            return classifyGitFailure({
              code: 'PR_URL_MISSING',
              message: 'PR created but URL not captured, please check `gh pr view --json url --jq .url`',
              cwd,
            })
          }
          return {
            success: true,
            provider: context.provider,
            remote: context.remoteName,
            baseBranch: context.baseBranch,
            headBranch: context.headBranch,
            url,
            diffSummary,
          }
        }

        if (context.provider === 'gitlab') {
          const hasGlab = await commandExists('glab', cwd)
          if (!hasGlab) {
            return classifyGitFailure({
              code: 'CLI_MISSING',
              message: 'GitLab CLI (glab) not found, please install and login first',
              cwd,
            })
          }

          const args = [
            'mr', 'create',
            '--source-branch', context.headBranch,
            '--target-branch', context.baseBranch,
            '--title', title,
            '--description', body,
          ]
          if (draft) {
            args.push('--draft')
          }

          let stdout = ''
          let stderr = ''
          try {
            ;({ stdout, stderr } = await runCommand('glab', cwd, args, 8 * 1024 * 1024, 120_000))
          } catch (error) {
            return classifyGitFailure({
              message: describePrCreateError(getGitErrorMessage(error), context),
              cwd,
            })
          }
          const url = extractFirstUrl(`${stdout}\n${stderr}`) || ''
          if (!url) {
            return classifyGitFailure({
              code: 'PR_URL_MISSING',
              message: 'MR created but URL not captured, please run `glab mr view` to confirm',
              cwd,
            })
          }
          return {
            success: true,
            provider: context.provider,
            remote: context.remoteName,
            baseBranch: context.baseBranch,
            headBranch: context.headBranch,
            url,
            diffSummary,
          }
        }

        return classifyGitFailure({
          code: 'PROVIDER_UNSUPPORTED',
          message: 'provider not supported',
          cwd,
        })
      } catch (error) {
        return classifyGitFailure({
          message: getGitErrorMessage(error),
          cwd,
        })
      }
    },
  )

  /**
   * 获取 worktree 列表
   */
  guardedHandle('git:worktrees', async (_event, cwd: string) => {
    if (!validateCwd(cwd, 'read')) return { ...CWD_ERROR, worktrees: [] }
    try {
      const [currentPath, raw] = await Promise.all([
        runGit(cwd, ['rev-parse', '--show-toplevel']),
        runGit(cwd, ['worktree', 'list', '--porcelain'], 5 * 1024 * 1024),
      ])
      const worktrees = parseWorktrees(raw, currentPath.trim())
      return { success: true, worktrees }
    } catch (error) {
      return { success: false, worktrees: [], error: getGitErrorMessage(error) }
    }
  })

  /**
   * 创建 worktree
   */
  guardedHandle(
    'git:worktreeCreate',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { path?: string; branch?: string; createBranch?: boolean; baseBranch?: string },
    ) => {
      // P1-Q2 修：worktreeCreate 在 cwd 下创建新目录 + 写 .git/worktrees。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      const worktreePath = options?.path?.trim() || ''
      const branch = options?.branch?.trim() || ''
      const createBranch = Boolean(options?.createBranch)
      const baseBranch = options?.baseBranch?.trim() || ''
      if (!worktreePath) {
        return { success: false, error: 'worktree path is required' }
      }
      const resolvedWt = path.resolve(worktreePath)
      const wtAccess = checkAndFormat(resolvedWt, 'write')
      if (!wtAccess.ok) return { success: false, error: wtAccess.error }

      try {
        const args = buildCreateWorktreeArgs({
          path: worktreePath,
          branch,
          createBranch,
          baseBranch,
        })
        await runGitWrite(cwd, args, 8 * 1024 * 1024)
        return { success: true }
      } catch (error) {
        return { success: false, error: getGitErrorMessage(error) }
      }
    },
  )

  /**
   * 删除 worktree
   */
  guardedHandle(
    'git:worktreeRemovePreflight',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { path?: string },
    ): Promise<WorktreeRemovePreflightResult> =>
      assessWorktreeRemoval(cwd, options?.path?.trim() || ''),
  )

  guardedHandle(
    'git:worktreeRemove',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { path?: string; force?: boolean; assessmentToken?: string },
    ): Promise<WorktreeRemoveResult> =>
      removeWorktreeSafely(cwd, options?.path ?? '', options),
  )

  /**
   * 合并 worktree 分支到目标分支
   */
  guardedHandle(
    'git:worktreeMerge',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: {
        sourceWorktreePath?: string
        targetBranch?: string
        deleteAfterMerge?: boolean
        deleteSourceBranch?: boolean
      },
    ) => {
      // P1-Q2 修：worktreeMerge 把 source 合到 target，重写 target 工作树。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      const sourceWorktreePath = options?.sourceWorktreePath?.trim() || ''
      const targetBranch = options?.targetBranch?.trim() || ''
      const deleteAfterMerge = Boolean(options?.deleteAfterMerge)
      const deleteSourceBranch = Boolean(options?.deleteSourceBranch)

      if (!sourceWorktreePath) {
        return { success: false, error: 'sourceWorktreePath is required' }
      }
      if (!targetBranch) {
        return { success: false, error: 'targetBranch is required' }
      }

      try {
        const [currentPath, raw] = await Promise.all([
          runGit(cwd, ['rev-parse', '--show-toplevel']),
          runGit(cwd, ['worktree', 'list', '--porcelain'], 5 * 1024 * 1024),
        ])
        const worktrees = parseWorktrees(raw, currentPath.trim())
        const source = worktrees.find(
          (item) => normalizeFsPath(item.path) === normalizeFsPath(sourceWorktreePath),
        )
        if (!source) {
          return { success: false, error: 'source worktree not found' }
        }
        if (!validateCwd(source.path, 'write')) {
          return { success: false, error: 'source worktree path is not accessible or outside allowed directories' }
        }

        const target = worktrees.find((item) => item.branch === targetBranch)
        if (!target) {
          return { success: false, error: `target branch '${targetBranch}' is not checked out in any worktree` }
        }
        if (!validateCwd(target.path, 'write')) {
          return { success: false, error: 'target worktree path is not accessible or outside allowed directories' }
        }

        if (normalizeFsPath(source.path) === normalizeFsPath(target.path)) {
          return { success: false, error: 'source and target worktree cannot be the same' }
        }

        const sourceBranch = (await runGit(source.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        if (!sourceBranch || sourceBranch === 'HEAD') {
          return { success: false, error: 'source worktree is detached HEAD, cannot merge' }
        }
        if (sourceBranch === targetBranch) {
          return { success: false, error: 'source branch and target branch are the same' }
        }

        const sourceWorkingTree = await probeWorkingTree(source.path)
        if (sourceWorkingTree.state === 'unknown') {
          return classifyGitFailure({
            code: 'WORKING_TREE_UNKNOWN',
            message: 'unable to determine whether the source worktree is clean',
            detail: sourceWorkingTree.detail,
            cwd: source.path,
          })
        }
        if (sourceWorkingTree.state === 'dirty') {
          return classifyGitFailure({
            code: 'WORKING_TREE_DIRTY',
            message: 'source worktree has uncommitted changes',
            cwd: source.path,
          })
        }
        const targetWorkingTree = await probeWorkingTree(target.path)
        if (targetWorkingTree.state === 'unknown') {
          return classifyGitFailure({
            code: 'WORKING_TREE_UNKNOWN',
            message: 'unable to determine whether the target worktree is clean',
            detail: targetWorkingTree.detail,
            cwd: target.path,
          })
        }
        if (targetWorkingTree.state === 'dirty') {
          return classifyGitFailure({
            code: 'WORKING_TREE_DIRTY',
            message: 'target worktree has uncommitted changes',
            cwd: target.path,
          })
        }

        const beforeHash = (await runGit(target.path, ['rev-parse', '--short', 'HEAD'])).trim()

        try {
          await runGitWrite(target.path, ['merge', sourceBranch, '--no-edit'], 8 * 1024 * 1024, 120_000)
        } catch (mergeError) {
          let conflictingFiles: string[] = []
          try {
            const diffResult = await runGit(target.path, ['diff', '--name-only', '--diff-filter=U'])
            conflictingFiles = diffResult
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          } catch {
            conflictingFiles = []
          }

          if (conflictingFiles.length > 0) {
            try {
              await runGitWrite(target.path, ['merge', '--abort'], 2 * 1024 * 1024, 20_000)
            } catch {
              // ignore
            }
            return {
              success: false,
              hasConflicts: true,
              conflictingFiles,
              sourceBranch,
              targetBranch,
              error: 'merge conflict detected',
            }
          }

          return {
            success: false,
            hasConflicts: false,
            conflictingFiles,
            sourceBranch,
            targetBranch,
            error: getGitErrorMessage(mergeError),
          }
        }

        const afterHash = (await runGit(target.path, ['rev-parse', '--short', 'HEAD'])).trim()
        let diffSummary: GitDiffSummary | null = null
        try {
          if (beforeHash && afterHash && beforeHash !== afterHash) {
            diffSummary = await buildDiffSummary(target.path, `${beforeHash}..${afterHash}`)
          }
        } catch {
          diffSummary = null
        }

        const warnings: string[] = []

        if (deleteAfterMerge) {
          const removal = await removeWorktreeSafely(cwd, source.path, { timeout: 120_000 })
          if (!removal.success) {
            warnings.push(`remove worktree failed: ${removal.error ?? 'worktree removal was blocked by safety checks'}`)
          }
          for (const warning of removal.warnings ?? []) {
            warnings.push(`remove worktree warning: ${warning.error ?? warning.code ?? 'cleanup failed'}`)
          }
        }

        if (deleteSourceBranch) {
          try {
            await runGitWrite(target.path, ['branch', '-d', sourceBranch], 2 * 1024 * 1024, 20_000)
          } catch (error) {
            warnings.push(`delete source branch failed: ${getGitErrorMessage(error)}`)
          }
        }

        return {
          success: true,
          hasConflicts: false,
          conflictingFiles: [],
          sourceBranch,
          targetBranch,
          beforeHash,
          afterHash,
          diffSummary,
          warnings,
        }
      } catch (error) {
        return { success: false, error: getGitErrorMessage(error) }
      }
    },
  )

  // ─── Pull ────────────────────────────────────────────

  guardedHandle(
    'git:pull',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { remote?: string; branch?: string; rebase?: boolean },
    ) => {
      // P1-Q2 修：pull 拉取并 merge/rebase 远端到本地，重写工作树。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      try {
        const meta = await getBranchMeta(cwd)
        if (meta.isDetached) {
          return { success: false, error: 'detached HEAD cannot pull' }
        }

        const args = ['pull']
        if (options?.rebase) args.push('--rebase')
        if (options?.remote?.trim()) args.push(options.remote.trim())
        if (options?.branch?.trim()) args.push(options.branch.trim())

        await runGitWrite(cwd, args, 8 * 1024 * 1024, 120_000)

        const afterMeta = await getBranchMeta(cwd)
        return { success: true, behind: afterMeta.behind }
      } catch (error) {
        return { success: false, error: getGitErrorMessage(error) }
      }
    },
  )

  // ─── Fetch ───────────────────────────────────────────

  guardedHandle(
    'git:fetch',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      options?: { remote?: string; prune?: boolean },
    ) => {
      // P1-Q2 修：fetch 写 .git/refs/remotes（不改工作树，但写 .git）。
      if (!validateCwd(cwd, 'write')) return CWD_ERROR
      try {
        const args = ['fetch']
        if (options?.remote?.trim()) args.push(options.remote.trim())
        if (options?.prune) args.push('--prune')

        await runGitWrite(cwd, args, 8 * 1024 * 1024, 120_000)
        return { success: true }
      } catch (error) {
        return { success: false, error: getGitErrorMessage(error) }
      }
    },
  )

  // ─── Stash ───────────────────────────────────────────

  guardedHandle(
    'git:stash',
    async (
      _event: IpcMainInvokeEvent,
      cwd: string,
      action: string,
      options?: { message?: string; includeUntracked?: boolean; index?: number },
    ) => {
      // P1-Q2 修：stash list 是 read，其他（save / pop / drop）是 write。
      // 按 sub-action 区分，避免让没 write 权限的用户连 list 都跑不了。
      const isStashWrite = action !== 'list'
      if (!validateCwd(cwd, isStashWrite ? 'write' : 'read')) return CWD_ERROR
      try {
        switch (action) {
          case 'save': {
            const args = ['stash', 'push']
            if (options?.includeUntracked) args.push('-u')
            if (options?.message?.trim()) args.push('-m', options.message.trim())
            await runGitWrite(cwd, args, 6 * 1024 * 1024)
            safeGitLog('info', 'git stash save succeeded', {
              action: 'stash:save',
              includeUntracked: Boolean(options?.includeUntracked),
              hasMessage: Boolean(options?.message?.trim()),
            })
            return { success: true }
          }

          case 'pop': {
            const ref = typeof options?.index === 'number' ? `stash@{${options.index}}` : undefined
            const args = ref ? ['stash', 'pop', ref] : ['stash', 'pop']
            await runGitWrite(cwd, args, 6 * 1024 * 1024)
            return { success: true }
          }

          case 'list': {
            const raw = await runGit(cwd, ['stash', 'list', '--format=%gd|%s'], 2 * 1024 * 1024)
            const entries: GitStashEntry[] = []
            for (const line of raw.split('\n')) {
              if (!line.trim()) continue
              const sepIdx = line.indexOf('|')
              const refPart = sepIdx >= 0 ? line.slice(0, sepIdx) : line
              const message = sepIdx >= 0 ? line.slice(sepIdx + 1) : ''
              const idxMatch = refPart.match(/\{(\d+)\}/)
              entries.push({
                index: idxMatch ? parseInt(idxMatch[1], 10) : entries.length,
                message: message.trim(),
              })
            }
            return { success: true, entries }
          }

          case 'drop': {
            const ref = typeof options?.index === 'number' ? `stash@{${options.index}}` : undefined
            const args = ref ? ['stash', 'drop', ref] : ['stash', 'drop']
            await runGitWrite(cwd, args, 2 * 1024 * 1024)
            return { success: true }
          }

          default:
            return { success: false, error: `unknown stash action: ${action}` }
        }
      } catch (error) {
        const message = getGitErrorMessage(error)
        safeGitLog('warn', 'git stash failed', {
          action: `stash:${action}`,
          error: message.slice(0, 300),
        })
        return { success: false, error: message }
      }
    },
  )

  // ─── Discard Files ───────────────────────────────────

  guardedHandle(
    'git:discardFiles',
    async (_event: IpcMainInvokeEvent, cwd: string, paths?: string[]) => {
      const pathspecs = normalizeGitPathspecs(paths)
      // P1-Q2 修：discardFiles 用 git checkout HEAD 把工作树覆盖回 HEAD 版本，
      // 是真实的写副作用（典型：.env 被删后调本接口能把 HEAD 历史里的 .env
      // 还原到磁盘——这正是 deny WRITE 列表想拦的"恢复敏感文件"操作）。
      if (!validateCwd(cwd, 'write')) {
        logGitWriteBlocked('discard', cwd, pathspecs, 'invalid working directory')
        return CWD_ERROR
      }
      const invalidPathspecs = rejectInvalidGitPathspecs('discard', cwd, pathspecs)
      if (invalidPathspecs) return invalidPathspecs

      if (pathspecs.cleanPaths.length === 0) {
        logGitWriteBlocked('discard', cwd, pathspecs, 'missing paths')
        return { success: false, error: 'paths are required for discard (safety)' }
      }

      // P1-Q1 修（核心）：每条 cwd-relative path 单独跑 'write' deny 检查——
      // 拦下"renderer 调 git:discardFiles(cwd, ['.env']) 把 HEAD 版本写回工作树"
      // 这种走 deny WRITE pattern 后门的场景。任一路径不过即拒绝整批。
      const pathsAccess = checkPathsWriteAccess(cwd, pathspecs.cleanPaths)
      if (!pathsAccess.ok) {
        logGitWriteBlocked('discard', cwd, pathspecs, 'path write access denied', pathsAccess.error)
        return { success: false, error: pathsAccess.error }
      }

      try {
        // 已跟踪：checkout 回 HEAD；未跟踪：clean 删除（对齐 VS Code「丢弃」新文件）
        const listedRaw = await runGit(
          cwd,
          ['ls-files', '-z', '--', ...pathspecs.cleanPaths],
          6 * 1024 * 1024,
        ).catch(() => '')
        const trackedSet = new Set(
          listedRaw
            .split('\0')
            .filter(Boolean)
            .map((p) => p.replace(/\\/g, '/')),
        )
        const tracked = pathspecs.cleanPaths.filter((p) =>
          trackedSet.has(p.replace(/\\/g, '/')),
        )
        const untracked = pathspecs.cleanPaths.filter(
          (p) => !trackedSet.has(p.replace(/\\/g, '/')),
        )

        if (tracked.length > 0) {
          await runGitWrite(cwd, ['checkout', '--', ...tracked], 6 * 1024 * 1024)
        }
        if (untracked.length > 0) {
          await runGitWrite(cwd, ['clean', '-f', '-d', '--', ...untracked], 6 * 1024 * 1024)
        }
        logGitWriteSuccess('discard', cwd, pathspecs)
        return { success: true, discardedCount: pathspecs.cleanPaths.length }
      } catch (error) {
        const errorMessage = getGitErrorMessage(error)
        logGitWriteFailure('discard', cwd, pathspecs, errorMessage, getGitWriteOperationId(error))
        return { success: false, error: errorMessage }
      }
    },
  )

  // ─── Full Status (聚合 IPC) ──────────────────────────

  guardedHandle('git:fullStatus', async (_event, cwd: string) => {
    const emptyDiffGroup: GitDiffStatGroup = { added: 0, deleted: 0, changed: 0 }
    const emptyMeta: GitBranchMeta = { branch: '', upstream: null, ahead: 0, behind: 0, isDetached: false }
    const emptyResult: GitFullStatusResult = {
      success: true,
      isRepo: false,
      branch: '',
      branchMeta: emptyMeta,
      status: { files: {}, entries: {} },
      diffStat: { total: emptyDiffGroup, unstaged: emptyDiffGroup, staged: emptyDiffGroup },
    }

    if (!validateCwd(cwd, 'read')) return emptyResult

    try {
      const repoCheck = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']).catch(() => '')
      if (repoCheck.trim() !== 'true') {
        return emptyResult
      }

      // 两条 status 串行，避免同一次刷新内部抢 index.lock；diff 可并行
      const metaRaw = await runGit(cwd, ['status', '--porcelain=2', '--branch']).catch(() => '')
      // [#4915] `-z`：NUL 分隔 + 禁用 quotepath 转义，中文/空格/引号路径原样直传。
      const [statusRaw, totalRaw, unstagedRaw, stagedRaw] = await Promise.all([
        runGit(cwd, ['status', '--porcelain=v1', '-uall', '-z'], 5 * 1024 * 1024).catch(() => ''),
        runGit(cwd, ['diff', 'HEAD', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
        runGit(cwd, ['diff', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
        runGit(cwd, ['diff', '--cached', '--numstat'], 5 * 1024 * 1024).catch(() => ''),
      ])

      const meta = parseBranchMeta(metaRaw)
      const { files, entries } = parsePorcelainV1StatusZ(statusRaw)

      const parseDiffNumstat = (raw: string): GitDiffStatGroup => {
        let added = 0, deleted = 0, changed = 0
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          const parts = line.split('\t')
          if (parts.length < 3) continue
          added += parseInt(parts[0], 10) || 0
          deleted += parseInt(parts[1], 10) || 0
          changed++
        }
        return { added, deleted, changed }
      }

      return {
        success: true,
        isRepo: true,
        branch: meta.branch,
        branchMeta: meta,
        status: { files, entries },
        diffStat: {
          total: parseDiffNumstat(totalRaw),
          unstaged: parseDiffNumstat(unstagedRaw),
          staged: parseDiffNumstat(stagedRaw),
        },
      } satisfies GitFullStatusResult
    } catch {
      return emptyResult
    }
  })

  // ─── Commit history（真实 git log，与 checkpoint shadow git 分离） ──

  guardedHandle(
    'git:log',
    async (_event, cwd: string, options?: GitLogOptions) => {
      const cwdCheck = diagnoseCwdRead(cwd)
      if (!cwdCheck.ok) {
        return {
          success: false,
          commits: [] as GitCommitListItem[],
          error: cwdCheck.error,
          reason: cwdCheck.reason,
        }
      }
      const graph = options?.graph === true
      try {
        const raw = await runGit(
          cwdCheck.cwd,
          buildGitLogArgs(options),
          2 * 1024 * 1024,
        )
        const commits: GitCommitListItem[] = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => parseGitLogLine(line, graph))
          .filter((item): item is GitCommitListItem => Boolean(item?.hash))
        let headHash: string | undefined
        if (graph) {
          try {
            headHash = (await runGit(cwdCheck.cwd, ['rev-parse', 'HEAD'])).trim() || undefined
          } catch {
            headHash = undefined
          }
        }
        return { success: true, commits, ...(headHash ? { headHash } : {}) }
      } catch (error) {
        const message = getGitErrorMessage(error)
        // 零提交仓库：git log 常以 exit 128 失败，应作为空列表而非 UI 错误。
        if (isEmptyRepositoryLogError(message)) {
          return { success: true, commits: [] as GitCommitListItem[] }
        }
        return {
          success: false,
          commits: [] as GitCommitListItem[],
          error: message,
          reason: 'git_error' as const,
        }
      }
    },
  )

  guardedHandle(
    'git:commitDetail',
    async (_event, cwd: string, options?: { commitHash?: string }) => {
      if (!validateCwd(cwd, 'read')) {
        return { success: false, error: 'invalid working directory' } satisfies GitCommitDetailResult
      }
      const commitHash = options?.commitHash?.trim() || ''
      if (!commitHash || !sanitizeGitRef(commitHash)) {
        return { success: false, error: 'invalid commit hash' } satisfies GitCommitDetailResult
      }
      try {
        const metaRaw = await runGit(
          cwd,
          ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI', commitHash],
          512 * 1024,
        )
        const [hash = '', shortHash = '', subject = '', authorName = '', authoredAt = ''] =
          metaRaw.trim().split('\x1f')
        if (!hash) {
          return { success: false, error: 'commit not found' } satisfies GitCommitDetailResult
        }
        let summary: GitDiffSummary
        try {
          summary = await buildDiffSummary(cwd, `${commitHash}^!`)
        } catch {
          // 根提交无 parent 时 hash^! 会失败；改用 --root diff-tree。
          const [numstatRaw, nameStatusRaw] = await Promise.all([
            runGit(
              cwd,
              ['diff-tree', '--no-commit-id', '--root', '-r', '--numstat', '-z', commitHash],
              8 * 1024 * 1024,
              120_000,
            ),
            runGit(
              cwd,
              ['diff-tree', '--no-commit-id', '--root', '-r', '--name-status', '-z', commitHash],
              8 * 1024 * 1024,
              120_000,
            ),
          ])
          const numstatMap = parseNumstatZ(numstatRaw)
          const statusMap = parseNameStatusZ(nameStatusRaw)
          const paths = new Set<string>([
            ...Array.from(numstatMap.keys()),
            ...Array.from(statusMap.keys()),
          ])
          let insertions = 0
          let deletions = 0
          const files: GitDiffFileSummary[] = []
          for (const path of paths) {
            const num = numstatMap.get(path) ?? { added: 0, deleted: 0 }
            insertions += num.added
            deletions += num.deleted
            files.push({
              path,
              status: statusMap.get(path) || 'A',
              added: num.added,
              deleted: num.deleted,
            })
          }
          summary = {
            range: commitHash,
            filesChanged: files.length,
            insertions,
            deletions,
            files,
          }
        }
        return {
          success: true,
          commit: {
            hash: hash.trim(),
            shortHash: shortHash.trim(),
            subject: subject.trim(),
            authorName: authorName.trim(),
            authoredAt: authoredAt.trim(),
          },
          files: summary.files,
          insertions: summary.insertions,
          deletions: summary.deletions,
        } satisfies GitCommitDetailResult
      } catch (error) {
        return {
          success: false,
          error: getGitErrorMessage(error),
        } satisfies GitCommitDetailResult
      }
    },
  )
}
