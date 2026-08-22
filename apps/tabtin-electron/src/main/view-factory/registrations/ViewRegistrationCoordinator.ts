import type { ViewEntry } from '../types'

export type RegistrationContext = {
  registerRunSession: (state: ViewEntry, options: { rollbackOnFailure: boolean }) => Promise<void>
  registerWorkspace: (state: ViewEntry, options: { strict: boolean }) => Promise<void>
  registerCdpManager: (state: ViewEntry) => Promise<void>
  registerResourceManager: (state: ViewEntry) => Promise<void>
  registerResourceDetection: (state: ViewEntry) => void
  unregisterRunSession: (state: ViewEntry) => void
  unregisterWorkspace: (state: ViewEntry) => void
  unregisterViewStateRegistry: (state: ViewEntry) => void
  unregisterCdpManager: (state: ViewEntry) => Promise<void>
  unregisterResourceManager: (state: ViewEntry) => Promise<void>
  unregisterResourceDetection: (state: ViewEntry) => void
  unregisterViewPageRegistry: (state: ViewEntry) => void
  reconcileState: (state: ViewEntry, reason: 'timer' | 'manual') => Promise<void>
  log: (...args: unknown[]) => void
}

/**
 * RF04: unregisterAll 执行顺序明确化且异常安全
 *
 * 顺序：
 *   1. 停止数据流（ResourceDetection / ViewPageRegistry）
   *   2. 清理组织（Organization → Hub + WTM，此时仍可查询 VSR）
 *   3. 清理核心注册表（VSR / CDP / Resource）
 *   4. 清理会话（RunSession）
 *
 * 每一步均 try-catch 包裹，确保单步失败不阻断后续清理。
 */
export class ViewRegistrationCoordinator {
  constructor(private readonly ctx: RegistrationContext) {}

  async registerForCreate(state: ViewEntry): Promise<void> {
    await this.ctx.registerRunSession(state, { rollbackOnFailure: true })
    try {
      await this.ctx.registerWorkspace(state, { strict: true })
    } catch (error) {
      try {
        this.ctx.unregisterRunSession(state)
      } catch (rollbackError) {
        this.ctx.log('[ViewRegistrationCoordinator] RunSession 补偿回滚失败:', {
          id: state.id,
          rollbackError,
        })
      }
      throw error
    }
  }

  /**
   * RF04: VSR 在 ViewFactory 中 views.set 后立即注册，
   * registerRegistries 仅处理 CDP / Resource / ResourceDetection。
   */
  async registerRegistries(state: ViewEntry): Promise<void> {
    await this.ctx.registerCdpManager(state)
    await this.ctx.registerResourceManager(state)
    this.ctx.registerResourceDetection(state)
  }

  /**
   * 外部 View 注册（VSR 已在 ViewFactory.registerExternalView 中完成）
   */
  async registerExternal(state: ViewEntry): Promise<void> {
    await this.ctx.registerCdpManager(state)
    await this.ctx.registerResourceManager(state)
    this.ctx.registerResourceDetection(state)
    await this.ctx.registerRunSession(state, { rollbackOnFailure: false })
    await this.ctx.registerWorkspace(state, { strict: false })
  }

  /**
   * RF04: 异常安全的反注册 — 每步 try-catch，顺序：
   *   数据流 → 工作区(可查 VSR) → VSR → CDP → Resource → RunSession
   */
  async unregisterAll(state: ViewEntry): Promise<void> {
    // 1. 停止数据流
    this.safeSync('resourceDetection', () => this.ctx.unregisterResourceDetection(state))
    this.safeSync('viewPageRegistry', () => this.ctx.unregisterViewPageRegistry(state))

    // 2. 清理组织（此时 VSR 仍可查询）
    this.safeSync('workspace', () => this.ctx.unregisterWorkspace(state))

    // 3. 清理核心注册表
    this.safeSync('viewStateRegistry', () => this.ctx.unregisterViewStateRegistry(state))
    await this.safeAsync('cdpManager', () => this.ctx.unregisterCdpManager(state))
    await this.safeAsync('resourceManager', () => this.ctx.unregisterResourceManager(state))

    // 4. 清理会话
    this.safeSync('runSession', () => this.ctx.unregisterRunSession(state))
  }

  async reconcileAll(states: Iterable<ViewEntry>, reason: 'timer' | 'manual'): Promise<void> {
    for (const state of states) {
      await this.ctx.reconcileState(state, reason)
    }
  }

  private safeSync(label: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.ctx.log(`[ViewRegistrationCoordinator] ⚠️ ${label} 反注册失败:`, error)
    }
  }

  private async safeAsync(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      this.ctx.log(`[ViewRegistrationCoordinator] ⚠️ ${label} 反注册失败:`, error)
    }
  }
}
