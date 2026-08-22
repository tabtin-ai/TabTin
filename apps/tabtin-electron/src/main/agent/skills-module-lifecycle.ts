/**
 * Skill registry 生命周期：登录后初始化、失败退避重试、断线重连后重试。
 *
 * 背景： — 启动 Phase2 在未登录时硬跑 initSkillsModule，失败后永久降级，
 * 登录成功也不再恢复。本模块把 init 门闩挪到「已解析到真实 userId」之后，
 * 并接上 auth / WS reconnect 信号。
 *
 * 「断线重连」= Electron WS gateway `onReconnect`（非 navigator.onLine）。
 */

export type SkillsModuleLifecycleLogger = {
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
}

export type SkillsModuleLifecycleDeps<TModule> = {
  /** 解析当前登录 userId；未登录返回 undefined / `_unscoped`。 */
  resolveUserId: () => Promise<string | undefined>
  /** 以指定 userId 执行一次 init（含 migrate / ensureUserSkills / watcher）。 */
  initModule: (userId: string) => Promise<TModule>
  /** 释放当前 registry（登出 / 切账号 / stop）。幂等。 */
  disposeModule: () => Promise<void>
  /**
   * 丢弃被 generation 作废的 orphan handle（init 完成时已 logout/stop）。
   * 勿走 disposeModule——那会误伤正在进行的新一轮 init。
   */
  disposeOrphan?: (module: TModule) => Promise<void>
  onAuthChanged: (cb: () => void) => () => void
  /** WS gateway 重连（Centrifugo），不是浏览器 online 事件。 */
  onReconnect: (cb: () => void) => () => void
  logger: SkillsModuleLifecycleLogger
  retry?: {
    baseMs?: number
    maxMs?: number
    maxAttempts?: number
  }
  /** 测试可注入时钟。 */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearSchedule?: (handle: ReturnType<typeof setTimeout>) => void
}

const DEFAULT_RETRY_BASE_MS = 2_000
const DEFAULT_RETRY_MAX_MS = 60_000
const DEFAULT_RETRY_MAX_ATTEMPTS = 10

function isAuthenticatedUserId(userId: string | undefined): userId is string {
  return !!userId && userId !== '_unscoped'
}

export class SkillsModuleLifecycle<TModule> {
  private module: TModule | null = null
  private ready: Promise<void> | null = null
  private boundUserId: string | null = null
  /** 登出 / stop / 切账号时递增；过期的 in-flight init 不得写回状态。 */
  private generation = 0
  private started = false
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private authUnsubscribe: (() => void) | null = null
  private reconnectUnsubscribe: (() => void) | null = null
  /** 串行化 ensure，避免双 kickoff。 */
  private ensureChain: Promise<void> = Promise.resolve()

  private readonly resolveUserId: SkillsModuleLifecycleDeps<TModule>['resolveUserId']
  private readonly initModule: SkillsModuleLifecycleDeps<TModule>['initModule']
  private readonly disposeModule: SkillsModuleLifecycleDeps<TModule>['disposeModule']
  private readonly disposeOrphan: ((module: TModule) => Promise<void>) | undefined
  private readonly onAuthChanged: SkillsModuleLifecycleDeps<TModule>['onAuthChanged']
  private readonly onReconnect: SkillsModuleLifecycleDeps<TModule>['onReconnect']
  private readonly logger: SkillsModuleLifecycleLogger
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly retryMaxAttempts: number
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearSchedule: (handle: ReturnType<typeof setTimeout>) => void

  constructor(deps: SkillsModuleLifecycleDeps<TModule>) {
    this.resolveUserId = deps.resolveUserId
    this.initModule = deps.initModule
    this.disposeModule = deps.disposeModule
    this.disposeOrphan = deps.disposeOrphan
    this.onAuthChanged = deps.onAuthChanged
    this.onReconnect = deps.onReconnect
    this.logger = deps.logger
    this.retryBaseMs = deps.retry?.baseMs ?? DEFAULT_RETRY_BASE_MS
    this.retryMaxMs = deps.retry?.maxMs ?? DEFAULT_RETRY_MAX_MS
    this.retryMaxAttempts = deps.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearSchedule = deps.clearSchedule ?? ((handle) => clearTimeout(handle))
  }

  getModule(): TModule | null {
    return this.module
  }

  getReady(): Promise<void> | null {
    return this.ready
  }

  getBoundUserId(): string | null {
    return this.boundUserId
  }

  /** 订阅 auth / WS reconnect，并在已登录时立即 kickoff。 */
  start(): void {
    if (this.started) return
    this.started = true

    this.authUnsubscribe = this.onAuthChanged(() => {
      void this.handleAuthChanged()
    })
    this.reconnectUnsubscribe = this.onReconnect(() => {
      void this.handleReconnect()
    })

    void this.ensureInitialized('host-start')
  }

  async stop(): Promise<void> {
    this.started = false
    this.unsubscribeAll()
    this.clearRetryTimer()
    this.retryAttempt = 0
    await this.teardown('host-stop')
  }

  /**
   * 幂等 ensure：已绑定同一 userId 则 no-op；未登录则跳过（等 auth）；
   * 失败则调度退避重试。经 ensureChain 串行，杜绝双 kickoff。
   */
  ensureInitialized(reason: string): Promise<void> {
    const run = this.ensureChain.then(() => this.ensureInitializedLocked(reason))
    // 链上错误不阻断后续 ensure
    this.ensureChain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  private async ensureInitializedLocked(reason: string): Promise<void> {
    if (!this.started) return

    const userId = await this.resolveUserId()
    if (!isAuthenticatedUserId(userId)) {
      this.logger.info(`[Skills] skip init (${reason}): not authenticated`)
      // 主进程早于鉴权缓存 hydrate 时，TokenManager 可能暂时读不到 userId。
      // 不能只等下一次 auth 事件：该事件有机会已经在 Host 启动前发出，导致
      // Agent 整个生命周期都没有动态 Skill。沿用已有的有界退避，等凭证就绪
      // 后重新解析；显式 logout 走 handleAuthChanged 的 teardown 分支，不会
      // 在未登录状态持续轮询。
      this.scheduleRetry(`auth-pending:${reason}`)
      return
    }

    if (this.module && this.boundUserId === userId) return

    if (this.module && this.boundUserId && this.boundUserId !== userId) {
      await this.teardown(`user-switch:${this.boundUserId}->${userId}`)
    }

    const gen = this.generation
    this.logger.info(`[Skills] init kickoff (${reason}) userId=${userId}`)
    this.ready = this.runInit(userId, gen).then(
      () => {
        if (gen !== this.generation) return
        this.retryAttempt = 0
        this.clearRetryTimer()
      },
      (err) => {
        if (gen !== this.generation) return
        this.logger.warn(
          `[Skills] initSkillsModule 失败，将重试 (${reason}):`,
          err instanceof Error ? err.message : err,
        )
        this.module = null
        this.boundUserId = null
        this.ready = null
        this.scheduleRetry(`init-failed:${reason}`)
      },
    )

    await this.ready
  }

  private async runInit(userId: string, gen: number): Promise<void> {
    const handle = await this.initModule(userId)
    if (gen !== this.generation || !this.started) {
      this.logger.info(`[Skills] discard stale init (userId=${userId} gen=${gen})`)
      if (this.disposeOrphan) {
        try {
          await this.disposeOrphan(handle)
        } catch (err) {
          this.logger.warn(
            '[Skills] disposeOrphan 抛错（已吞错）:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      return
    }
    this.module = handle
    this.boundUserId = userId
    this.logger.info(`[Skills] initSkillsModule ready (userId=${userId})`)
  }

  private async handleAuthChanged(): Promise<void> {
    if (!this.started) return

    const userId = await this.resolveUserId()
    if (!isAuthenticatedUserId(userId)) {
      this.clearRetryTimer()
      this.retryAttempt = 0
      await this.teardown('logout')
      return
    }

    this.retryAttempt = 0
    this.clearRetryTimer()
    await this.ensureInitialized('auth-changed')
  }

  private async handleReconnect(): Promise<void> {
    if (!this.started) return
    if (this.module) return

    this.retryAttempt = 0
    this.clearRetryTimer()
    await this.ensureInitialized('ws-reconnect')
  }

  private scheduleRetry(reason: string): void {
    if (!this.started) return
    if (this.retryTimer) return

    if (this.retryAttempt >= this.retryMaxAttempts) {
      this.logger.warn(
        `[Skills] retry exhausted after ${this.retryMaxAttempts} attempts — waiting for auth/reconnect (${reason})`,
      )
      return
    }

    const delay = Math.min(
      this.retryBaseMs * 2 ** this.retryAttempt,
      this.retryMaxMs,
    )
    this.retryAttempt += 1
    this.logger.info(
      `[Skills] schedule retry #${this.retryAttempt} in ${delay}ms (${reason})`,
    )
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null
      void this.ensureInitialized(`retry#${this.retryAttempt}`)
    }, delay)
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return
    this.clearSchedule(this.retryTimer)
    this.retryTimer = null
  }

  private unsubscribeAll(): void {
    if (this.authUnsubscribe) {
      try {
        this.authUnsubscribe()
      } catch {
        /* best effort */
      }
      this.authUnsubscribe = null
    }
    if (this.reconnectUnsubscribe) {
      try {
        this.reconnectUnsubscribe()
      } catch {
        /* best effort */
      }
      this.reconnectUnsubscribe = null
    }
  }

  private async teardown(reason: string): Promise<void> {
    this.generation += 1
    const hadState = !!(this.module || this.ready || this.boundUserId)
    this.ready = null
    this.module = null
    this.boundUserId = null
    if (!hadState) return

    this.logger.info(`[Skills] teardown (${reason})`)
    try {
      await this.disposeModule()
    } catch (err) {
      this.logger.warn(
        '[Skills] disposeModule 抛错（已吞错）:',
        err instanceof Error ? err.message : err,
      )
    }
  }
}
