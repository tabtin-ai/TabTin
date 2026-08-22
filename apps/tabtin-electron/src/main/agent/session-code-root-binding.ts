/**
 *  / 会话代码根持久化：
 * 把某条 chat 会话固定绑到一个 Git worktree 目录，并写入本机 userData sidecar，
 * 以便 Electron 重启后恢复。绝对路径只留在本机，不上云、不跨设备。
 *
 * 本模块负责：
 *   - 只读文件系统校验（存在 / 是目录 / 是 Git 工作树）—— fail-closed
 *   - 内存态 Map<sessionId, binding>
 *   - 版本化 JSON 原子落盘（按 userId::organizationId 分桶）
 *   - 启动恢复时重新校验路径；无效条目不进入可执行内存态
 *
 * 不负责：
 *   - busy 判定（由 ElectronAgentHost 经 opts.isBusy 传入）
 *   - 接到 resolveExecutionWorkspaceRoot / path-access-checker（装配层职责）
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createLogger } from '../logger.js'

const execFileAsync = promisify(execFile)
const log = createLogger('SessionCodeRootBinding')

export const SESSION_CODE_ROOT_PERSIST_VERSION = 1 as const

export interface SessionCodeRootBinding {
  rootPath: string
  revision: number
  tabKey?: string
  branch?: string
  title?: string
  boundAt: number
}

function platformPathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').normalize('NFC')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function normalizeBindingPath(rootPath: string): string {
  const resolved = path.resolve(rootPath.trim())
  let normalized = path.normalize(resolved)
  try {
    normalized = fs.realpathSync.native(resolved)
  } catch {
    // A removal reservation may outlive the directory briefly. Preserve the
    // exact normalized spelling when no canonical path can be resolved.
  }
  return platformPathKey(normalized)
}

/** Path spellings that should count as the same binding root. */
export function collectBindingPathKeys(rootPath: string): Set<string> {
  const keys = new Set<string>()
  const add = (value: string) => {
    if (!value.trim()) return
    keys.add(platformPathKey(value))
  }

  const trimmed = rootPath.trim()
  if (!trimmed) return keys
  add(trimmed)
  const resolved = path.resolve(trimmed)
  add(path.normalize(resolved))
  try {
    add(fs.realpathSync.native(resolved))
  } catch {
    // Directory may already be gone; keep literal spellings for leftover cleanup.
  }

  if (process.platform === 'darwin') {
    for (const key of [...keys]) {
      if (
        key.startsWith('/private/tmp/')
        || key.startsWith('/private/var/')
        || key.startsWith('/private/etc/')
      ) {
        add(key.slice('/private'.length))
      } else if (key.startsWith('/tmp/') || key.startsWith('/var/') || key.startsWith('/etc/')) {
        add(`/private${key}`)
      }
    }
  }
  return keys
}

export function bindingPathsMatch(left: string, right: string): boolean {
  const rightKeys = collectBindingPathKeys(right)
  for (const key of collectBindingPathKeys(left)) {
    if (rightKeys.has(key)) return true
  }
  return false
}

export class SessionCodeRootConflictError extends Error {
  readonly code = 'SESSION_CODE_ROOT_CONFLICT'
  constructor(readonly persistedRoot: string, readonly requestedRoot: string) {
    super('request code root conflicts with the persisted session binding')
    this.name = 'SessionCodeRootConflictError'
  }
}

/** Persisted main-process state wins; a stale request must never override it. */
export function resolveAuthoritativeSessionCodeRoot(
  persistedRoot: string | null | undefined,
  requestedRoot: string | null | undefined,
): string | undefined {
  const persisted = persistedRoot?.trim() || undefined
  const requested = requestedRoot?.trim() || undefined
  if (persisted && requested && !bindingPathsMatch(persisted, requested)) {
    throw new SessionCodeRootConflictError(persisted, requested)
  }
  return persisted ?? requested
}

export class SessionCodeRootBindingsUnknownError extends Error {
  readonly code = 'BINDINGS_UNKNOWN'
  constructor() {
    super('session code-root bindings are not restored yet')
    this.name = 'SessionCodeRootBindingsUnknownError'
  }
}

export interface BindSessionCodeRootInput {
  sessionId: string
  rootPath: string
  revision?: number
  tabKey?: string
  branch?: string
  title?: string
}

export type BindSessionCodeRootFailureReason =
  | 'invalid_session_id'
  | 'invalid_root_path'
  | 'not_found'
  | 'not_a_directory'
  | 'not_git_worktree'
  | 'session_busy'

export interface BindSessionCodeRootResult {
  success: boolean
  rootPath?: string
  revision?: number
  error?: string
  reason?: BindSessionCodeRootFailureReason
}

export interface BindingScope {
  userId: string
  organizationId: string
}

export interface SessionCodeRootBindingStoreOptions {
  /** 持久化文件绝对路径；缺省则仅内存（测试 / 未 configure）。 */
  getPersistPath?: () => string | null
  /** 当前本机身份分桶；缺省 / 返回 null 时只写内存、不落盘。 */
  getScope?: () => BindingScope | null | Promise<BindingScope | null>
  /** 可注入 git 探测（单测）。 */
  isGitWorkTree?: (dirPath: string) => Promise<boolean>
  now?: () => number
}

interface PersistFileV1 {
  version: typeof SESSION_CODE_ROOT_PERSIST_VERSION
  buckets: Record<string, Record<string, SessionCodeRootBinding>>
}

/** 草稿 / 临时会话 ID 不落盘。 */
export function isPersistableSessionId(sessionId: string): boolean {
  const id = sessionId.trim()
  if (!id) return false
  if (id.startsWith('local-pending-')) return false
  if (id.startsWith('conversation:draft:')) return false
  return true
}

export function scopeKeyOf(scope: BindingScope): string {
  return `${scope.userId}::${scope.organizationId}`
}

async function defaultIsInsideGitWorkTree(dirPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      { cwd: dirPath, timeout: 5_000 },
    )
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const payload = `${JSON.stringify(data, null, 2)}\n`
  await fsp.writeFile(tmp, payload, 'utf-8')
  try {
    await fsp.rename(tmp, filePath)
  } catch {
    await fsp.copyFile(tmp, filePath)
    await fsp.unlink(tmp).catch(() => {})
  }
}

function parsePersistFile(raw: string): PersistFileV1 {
  const parsed = JSON.parse(raw) as Partial<PersistFileV1>
  if (parsed?.version !== SESSION_CODE_ROOT_PERSIST_VERSION || typeof parsed.buckets !== 'object' || !parsed.buckets) {
    throw new Error(`unsupported session-code-root persist schema version=${String(parsed?.version)}`)
  }
  return {
    version: SESSION_CODE_ROOT_PERSIST_VERSION,
    buckets: parsed.buckets,
  }
}

function isValidBindingShape(value: unknown): value is SessionCodeRootBinding {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.rootPath === 'string'
    && v.rootPath.trim().length > 0
    && typeof v.revision === 'number'
    && Number.isFinite(v.revision)
    && typeof v.boundAt === 'number'
    && Number.isFinite(v.boundAt)
  )
}

export class SessionCodeRootBindingStore {
  private readonly bySession = new Map<string, SessionCodeRootBinding>()
  private readonly rootsPendingRemoval = new Set<string>()
  private getPersistPath: (() => string | null) | undefined
  private getScope: (() => BindingScope | null | Promise<BindingScope | null>) | undefined
  private readonly isGitWorkTree: (dirPath: string) => Promise<boolean>
  private readonly now: () => number
  private writeChain: Promise<void> = Promise.resolve()
  /** 已成功完成 restore 的分桶；scope 变化或登出后清空。 */
  private restoredScopeKey: string | null = null
  private ensureRestoredChain: Promise<void> = Promise.resolve()

  constructor(options: SessionCodeRootBindingStoreOptions = {}) {
    this.getPersistPath = options.getPersistPath
    this.getScope = options.getScope
    this.isGitWorkTree = options.isGitWorkTree ?? defaultIsInsideGitWorkTree
    this.now = options.now ?? Date.now
  }

  configure(options: Pick<SessionCodeRootBindingStoreOptions, 'getPersistPath' | 'getScope'>): void {
    if (options.getPersistPath) this.getPersistPath = options.getPersistPath
    if (options.getScope) this.getScope = options.getScope
  }

  get(sessionId: string): SessionCodeRootBinding | undefined {
    return this.bySession.get(sessionId)
  }

  getRootPath(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)?.rootPath
  }

  getMany(sessionIds: readonly string[]): Record<string, SessionCodeRootBinding> {
    const out: Record<string, SessionCodeRootBinding> = {}
    for (const raw of sessionIds) {
      const sessionId = raw?.trim()
      if (!sessionId) continue
      const binding = this.bySession.get(sessionId)
      if (binding) out[sessionId] = binding
    }
    return out
  }

  /**
   * 仅清内存。持久化请用 {@link clearAndPersist}（IPC 路径）。
   * 返回是否命中。
   */
  clear(sessionId: string): boolean {
    return this.bySession.delete(sessionId)
  }

  async clearAndPersist(sessionId: string): Promise<boolean> {
    await this.ensureRestored()
    const cleared = this.bySession.delete(sessionId)
    if (isPersistableSessionId(sessionId)) {
      await this.persistCurrentBucket()
    }
    return cleared
  }

  /**
   * 草稿转正：把 from → to 原子迁移。to 为可持久化 ID 时立刻落盘并去掉 from。
   */
  async rehome(fromSessionId: string, toSessionId: string): Promise<SessionCodeRootBinding | null> {
    await this.ensureRestored()
    const fromId = fromSessionId?.trim()
    const toId = toSessionId?.trim()
    if (!fromId || !toId || fromId === toId) return null
    const existing = this.bySession.get(fromId)
    if (!existing) return null
    const revision = existing.revision + 1
    const moved: SessionCodeRootBinding = { ...existing, revision }
    this.bySession.set(toId, moved)
    this.bySession.delete(fromId)
    if (isPersistableSessionId(toId) || isPersistableSessionId(fromId)) {
      await this.persistCurrentBucket()
    }
    log.info(
      `rehomed binding ${fromId.slice(0, 12)}… → ${toId.slice(0, 12)}… revision=${revision}`,
    )
    return moved
  }

  snapshot(): ReadonlyArray<readonly [string, SessionCodeRootBinding]> {
    return [...this.bySession.entries()]
  }

  async findSessionsByRootPath(rootPath: string): Promise<Array<{
    sessionId: string
    binding: SessionCodeRootBinding
  }>> {
    await this.ensureRestored()
    if (!(await this.areBindingsKnown())) {
      throw new SessionCodeRootBindingsUnknownError()
    }
    return [...this.bySession.entries()]
      .filter(([, binding]) => bindingPathsMatch(binding.rootPath, rootPath))
      .map(([sessionId, binding]) => ({ sessionId, binding }))
  }

  async clearSessionsByRootPath(rootPath: string): Promise<string[]> {
    const matches = await this.findSessionsByRootPath(rootPath)
    if (matches.length === 0) return []
    for (const { sessionId } of matches) this.bySession.delete(sessionId)
    await this.persistCurrentBucket()
    return matches.map(({ sessionId }) => sessionId)
  }

  /**
   * Persist-backed stores must finish restore for the current scope before a
   * missing binding can be treated as "none". Memory-only stores (tests) use
   * the in-memory map as the source of truth.
   */
  private async areBindingsKnown(): Promise<boolean> {
    if (!this.getPersistPath && !this.getScope) return true
    const scope = await this.resolveScope()
    if (!scope) return false
    return this.restoredScopeKey === scopeKeyOf(scope)
  }

  async reserveRootForRemoval(rootPath: string): Promise<(() => void) | null> {
    await this.ensureRestored()
    const key = normalizeBindingPath(rootPath)
    if (this.rootsPendingRemoval.has(key)) return null
    this.rootsPendingRemoval.add(key)
    let released = false
    return () => {
      if (released) return
      released = true
      this.rootsPendingRemoval.delete(key)
    }
  }

  /** 清空内存态（登出防串账号）；不碰磁盘。 */
  clearAllMemory(): void {
    this.bySession.clear()
    this.restoredScopeKey = null
  }

  /**
   * 组织上下文晚于 Host 启动就绪时，在首次读/写 IPC 前补 restore，
   * 避免空内存态整桶覆盖落盘。
   */
  async ensureRestored(): Promise<void> {
    const run = async () => {
      const scope = await this.resolveScope()
      if (!scope) return
      const key = scopeKeyOf(scope)
      if (this.restoredScopeKey === key) return
      await this.restore()
    }
    this.ensureRestoredChain = this.ensureRestoredChain.then(run, run)
    await this.ensureRestoredChain
  }

  /**
   * 启动 / 身份切换后：从磁盘恢复当前分桶（重新校验路径）。
   * 若 scope 尚未就绪则 **不** 清空内存，返回 `deferred: true`，由调用方稍后重试。
   * 同 scope 已 restore 过则短路（保留草稿内存态）；换 scope 时保留非可持久化草稿。
   * 与写链串行，避免读盘回写冲掉进行中的 bind。
   */
  async restore(): Promise<{ restored: number; skipped: number; deferred?: boolean }> {
    if (this.rootsPendingRemoval.size > 0) {
      return { restored: 0, skipped: 0, deferred: true }
    }
    const scope = await this.resolveScope()
    const filePath = this.getPersistPath?.() ?? null
    if (!scope || !filePath) {
      return { restored: 0, skipped: 0, deferred: true }
    }

    const scopeKey = scopeKeyOf(scope)
    if (this.restoredScopeKey === scopeKey) {
      return { restored: 0, skipped: 0 }
    }

    // 等进行中的写完成，再读盘；并把整段 restore 挂进写链，避免并发 persist。
    await this.writeChain

    let restored = 0
    let skipped = 0
    let deferredForRemoval = false
    // 仅「尚未成功 restore 过」时保留草稿——换组织 / 换账号不带旧草稿
    const preserveDrafts = this.restoredScopeKey === null
    const run = async () => {
      if (this.rootsPendingRemoval.size > 0) {
        deferredForRemoval = true
        return
      }
      const draftBindings = new Map<string, SessionCodeRootBinding>()
      if (preserveDrafts) {
        for (const [sessionId, binding] of this.bySession.entries()) {
          if (!isPersistableSessionId(sessionId)) {
            draftBindings.set(sessionId, binding)
          }
        }
      }

      this.bySession.clear()
      this.restoredScopeKey = null

      let file: PersistFileV1
      try {
        const raw = await fsp.readFile(filePath, 'utf-8')
        file = parsePersistFile(raw)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        for (const [sessionId, binding] of draftBindings) {
          this.bySession.set(sessionId, binding)
        }
        // 空文件 / 损坏也要钉住 restoredScopeKey，避免后续 ensureRestored 反复 clear
        this.restoredScopeKey = scopeKey
        if (code === 'ENOENT') {
          return
        }
        log.warn(
          `persist file unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }

      const bucket = file.buckets[scopeKey] ?? {}
      for (const [sessionId, rawBinding] of Object.entries(bucket)) {
        if (!isPersistableSessionId(sessionId) || !isValidBindingShape(rawBinding)) {
          skipped += 1
          continue
        }
        const ok = await this.validateExistingRoot(rawBinding.rootPath)
        if (!ok) {
          log.warn(
            `skip restore session=${sessionId.slice(0, 8)}… root=${rawBinding.rootPath} (path no longer valid)`,
          )
          skipped += 1
          continue
        }
        this.bySession.set(sessionId, {
          rootPath: ok,
          revision: rawBinding.revision,
          tabKey: rawBinding.tabKey,
          branch: rawBinding.branch,
          title: rawBinding.title,
          boundAt: rawBinding.boundAt,
        })
        restored += 1
      }

      for (const [sessionId, binding] of draftBindings) {
        if (!this.bySession.has(sessionId)) {
          this.bySession.set(sessionId, binding)
        }
      }

      // 用校验后的可持久化内存态回写，剔除失效条目（草稿仍不落盘）
      if (restored > 0 || skipped > 0) {
        await this.writeBucketFile(scope, filePath, file)
      }
      this.restoredScopeKey = scopeKey
      log.info(`restore done scope=${scopeKey} restored=${restored} skipped=${skipped}`)
    }

    this.writeChain = this.writeChain.then(run, run)
    await this.writeChain
    if (deferredForRemoval) {
      return { restored: 0, skipped: 0, deferred: true }
    }
    return { restored, skipped }
  }

  /** 退出前 best-effort flush（等待进行中的写链）。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  async bind(
    input: BindSessionCodeRootInput,
    opts: { isBusy: () => boolean },
  ): Promise<BindSessionCodeRootResult> {
    await this.ensureRestored()
    const sessionId = input.sessionId?.trim()
    if (!sessionId) {
      return { success: false, error: 'sessionId is required', reason: 'invalid_session_id' }
    }
    const rawRoot = input.rootPath?.trim()
    if (!rawRoot) {
      return { success: false, error: 'rootPath is required', reason: 'invalid_root_path' }
    }
    if (opts.isBusy()) {
      return {
        success: false,
        error: 'session is currently running; stop it before rebinding the code root',
        reason: 'session_busy',
      }
    }

    let realRoot: string
    try {
      const stat = fs.statSync(rawRoot)
      if (!stat.isDirectory()) {
        return { success: false, error: `not a directory: ${rawRoot}`, reason: 'not_a_directory' }
      }
      realRoot = fs.realpathSync(rawRoot)
    } catch {
      return { success: false, error: `path does not exist: ${rawRoot}`, reason: 'not_found' }
    }

    const isGit = await this.isGitWorkTree(realRoot)
    if (!isGit) {
      return { success: false, error: `not a git working tree: ${realRoot}`, reason: 'not_git_worktree' }
    }
    if (this.rootsPendingRemoval.has(normalizeBindingPath(realRoot))) {
      return {
        success: false,
        error: 'code root removal is in progress; retry after it finishes',
        reason: 'session_busy',
      }
    }

    const existing = this.bySession.get(sessionId)
    const revision = input.revision ?? (existing?.revision ?? 0) + 1
    const binding: SessionCodeRootBinding = {
      rootPath: realRoot,
      revision,
      tabKey: input.tabKey,
      branch: input.branch,
      title: input.title,
      boundAt: this.now(),
    }
    this.bySession.set(sessionId, binding)

    try {
      if (isPersistableSessionId(sessionId)) {
        await this.persistCurrentBucket()
      } else {
        log.debug(`bound draft session=${sessionId.slice(0, 16)}… memory-only (not persisted)`)
      }
    } catch (error) {
      // bind 对调用方必须是原子的。否则 sidecar 写失败时 Host 会收到 rejected，
      // 但内存根已经漂到新 worktree，下一轮仍可能在错误现场启动。
      if (this.bySession.get(sessionId) === binding) {
        if (existing) this.bySession.set(sessionId, existing)
        else this.bySession.delete(sessionId)
      }
      throw error
    }

    log.info(
      `bound session=${sessionId.slice(0, 8)}… root=${realRoot} revision=${revision}` +
        (input.tabKey ? ` tabKey=${input.tabKey}` : ''),
    )
    return { success: true, rootPath: realRoot, revision }
  }

  private async validateExistingRoot(rootPath: string): Promise<string | null> {
    try {
      const stat = fs.statSync(rootPath)
      if (!stat.isDirectory()) return null
      const realRoot = fs.realpathSync(rootPath)
      const isGit = await this.isGitWorkTree(realRoot)
      return isGit ? realRoot : null
    } catch {
      return null
    }
  }

  private async resolveScope(): Promise<BindingScope | null> {
    if (!this.getScope) return null
    try {
      return await this.getScope()
    } catch (err) {
      log.warn(`getScope failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  private async persistCurrentBucket(): Promise<void> {
    const run = async () => {
      const scope = await this.resolveScope()
      const filePath = this.getPersistPath?.() ?? null
      if (!scope || !filePath) return

      let file: PersistFileV1 = { version: SESSION_CODE_ROOT_PERSIST_VERSION, buckets: {} }
      try {
        const raw = await fsp.readFile(filePath, 'utf-8')
        file = parsePersistFile(raw)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          log.warn(
            `read-before-write failed, rewriting: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      await this.writeBucketFile(scope, filePath, file)
    }

    this.writeChain = this.writeChain.then(run, run)
    await this.writeChain
  }

  /** 已在写链内调用：把当前可持久化内存态写进指定分桶。 */
  private async writeBucketFile(
    scope: BindingScope,
    filePath: string,
    file: PersistFileV1,
  ): Promise<void> {
    const bucket: Record<string, SessionCodeRootBinding> = {}
    for (const [sessionId, binding] of this.bySession.entries()) {
      if (!isPersistableSessionId(sessionId)) continue
      bucket[sessionId] = binding
    }
    file.buckets[scopeKeyOf(scope)] = bucket
    await atomicWriteJson(filePath, file)
  }
}

export function createSessionCodeRootBindingStore(
  options?: SessionCodeRootBindingStoreOptions,
): SessionCodeRootBindingStore {
  return new SessionCodeRootBindingStore(options)
}
