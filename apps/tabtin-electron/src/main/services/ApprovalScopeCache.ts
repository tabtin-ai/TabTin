/**
 * ApprovalScopeCache — 审批 Scope 缓存（**@deprecated W2-轮 2 / 轮 3 删除**）
 *
 * @deprecated W2-轮 1（PRD 05 v0.4 §7.3）已落地 ``ApprovalMemoStore``
 *   作为 PRD 主路径 Layer 4 Memoization 的真实存储；ApprovalManager 的沙箱
 *   独立路径（``actionType`` 粒度的 30 天本地缓存 + 跨设备同步）暂保留以
 *   不破坏沙箱 UX，待 W2-轮 2 / 轮 3 收尾时统一迁入 ``ApprovalMemoStore``
 *   或拆出独立的"沙箱白名单"模块。
 *
 *   两套系统的 key 空间不一致：
 *   - ``ApprovalScopeCache`` key = ``actionType``（粗粒度沙箱 category，
 *     如 ``execute_in_terminal`` / ``write_file:src/components``）
 *   - ``ApprovalMemoStore`` key = ``{namespace}::{tool_name}::{normalized_input}``
 *     （PRD §6.5 细粒度工具+input）
 *
 *   强行合并会有语义损失；W2-轮 2 计划保留两个 key space，但把存储与
 *   广播链路统一到 ``ApprovalMemoStore`` 的 commit / refetch 通道。
 *
 *   **新代码不要再调用 ``approvalScopeCache``** — 走 ``ApprovalMemoStore`` /
 *   PRD 05 §7.3 标准链路。
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 历史职责（保留供沙箱主路径继续使用）：
 *
 * 管理用户审批决策的缓存（thread / always），避免相同操作重复弹窗。
 *
 * 存储策略：
 * - thread scope: 内存 Map，App 重启自动清除
 * - always scope: 通过 ConfigService 持久化到磁盘
 *
 * 缓存键策略（#6 分级缓存）：
 * - write_file / edit_file / delete_file：actionType + 文件路径前两级目录
 * - 其他 actionType：仅 actionType（不做二级维度，避免 shell 拼接绕过）
 *
 * 过期策略（#14 + #19）：
 * - thread 缓存：跟随 App 生命周期，无 TTL
 * - always 缓存：30 天 TTL，过期后需重新审批
 * - 向后兼容：无 updatedAt 的旧条目视为未过期
 *
 * 安全约束：
 * - strict 级别始终需要审批，永不缓存
 * - 提供 clearAll / clearSession / clearPersisted / clearByActionType 方法
 */

import { configService } from './ConfigService'
import { createLogger } from '../logger'

const log = createLogger('ApprovalScopeCache')

const CONFIG_KEY = 'approval.scopeCache' as const

const ALWAYS_TTL_MS = 30 * 24 * 60 * 60 * 1000

const FILE_ACTION_TYPES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'delete_file',
])

export type ScopeEntry = {
  approved: boolean
  updatedAt: number
  policyVersion?: string
}

declare module './ConfigService' {
  interface AppConfig {
    [CONFIG_KEY]?: Record<string, ScopeEntry>
  }
}


class ApprovalScopeCacheImpl {
  private sessionCache = new Map<string, ScopeEntry>()

  /**
   * 检查缓存中是否有已批准的决策。
   * 优先查 session 缓存，再查 always（持久化）缓存。
   *
   * @param actionType 操作类型（如 execute_in_terminal、write_file）
   * @param isStrict   是否为 strict 级别工具（strict 始终需要审批）
   * @param detail     操作详情（文件操作时为路径，用于二级缓存键）
   * @returns true = 缓存命中且已批准，可跳过审批
   */
  isApproved(actionType: string, isStrict = false, detail?: string): boolean {
    if (isStrict) return false

    const key = this.buildKey(actionType, detail)

    const sessionEntry = this.sessionCache.get(key)
    if (sessionEntry?.approved) return true

    const persisted = this.loadPersisted()
    const alwaysEntry = persisted[key]
    if (alwaysEntry?.approved) {
      if (this.isExpired(alwaysEntry)) {
        log.debug(`Always cache expired for "${key}"`)
        return false
      }
      return true
    }

    return false
  }

  /**
   * 记录审批决策到缓存。
   *
   * @param actionType 操作类型
   * @param scope      once / thread / always
   * @param approved   是否批准
   * @param detail     操作详情（文件操作时为路径，用于二级缓存键）
   */
  record(actionType: string, scope: string | undefined, approved: boolean, detail?: string): void {
    if (!scope || scope === 'once') return

    const key = this.buildKey(actionType, detail)
    const entry: ScopeEntry = { approved, updatedAt: Date.now() }

    if (scope === 'thread') {
      this.sessionCache.set(key, entry)
      log.debug(`[thread] recorded: ${key} approved=${approved}`)
      return
    }

    if (scope === 'always') {
      this.sessionCache.set(key, entry)

      const persisted = this.loadPersisted()
      persisted[key] = entry
      this.savePersisted(persisted)
      log.debug(`[always] recorded: ${key} approved=${approved}`)
    }
  }

  clearSession(): void {
    const size = this.sessionCache.size
    this.sessionCache.clear()
    log.info(`Session cache cleared (${size} entries)`)
  }

  /**
   * 清除持久化缓存。
   * @param actionTypes 可选，仅清除指定 actionType 的条目（含二级键）
   */
  clearPersisted(actionTypes?: string[]): void {
    if (!actionTypes || actionTypes.length === 0) {
      this.savePersisted({})
      log.info('Persisted (always) cache cleared')
      return
    }

    const persisted = this.loadPersisted()
    const typeSet = new Set(actionTypes)
    let cleared = 0
    for (const key of Object.keys(persisted)) {
      const baseType = key.split(':')[0]
      if (typeSet.has(baseType)) {
        delete persisted[key]
        cleared++
      }
    }
    if (cleared > 0) {
      this.savePersisted(persisted)
    }
    log.info(`Persisted cache selectively cleared: ${cleared} entries for [${actionTypes.join(', ')}]`)
  }

  /**
   * 按 actionType 精准清除缓存（session + persisted）。
   * 同时清除该 actionType 下所有二级键（如 write_file:src/components）。
   */
  clearByActionType(actionType: string): void {
    let sessionCleared = 0
    for (const key of Array.from(this.sessionCache.keys())) {
      if (key === actionType || key.startsWith(`${actionType}:`)) {
        this.sessionCache.delete(key)
        sessionCleared++
      }
    }

    const persisted = this.loadPersisted()
    let persistedCleared = 0
    for (const key of Object.keys(persisted)) {
      if (key === actionType || key.startsWith(`${actionType}:`)) {
        delete persisted[key]
        persistedCleared++
      }
    }
    if (persistedCleared > 0) {
      this.savePersisted(persisted)
    }

    log.info(`Cleared cache for actionType "${actionType}": session=${sessionCleared}, persisted=${persistedCleared}`)
  }

  clearAll(): void {
    this.clearSession()
    this.clearPersisted()
  }

  getStats(): { sessionCount: number; persistedCount: number } {
    const persisted = this.loadPersisted()
    return {
      sessionCount: this.sessionCache.size,
      persistedCount: Object.keys(persisted).length,
    }
  }

  /**
   * 将后端同步来的审批偏好合并到本地 always 缓存。
   * 合并策略：按 updatedAt 取较新方。后端数据优先（同 updatedAt 时后端胜出）。
   */
  syncFromRemote(remote: Record<string, ScopeEntry>): void {
    if (!remote || typeof remote !== 'object') return

    const local = this.loadPersisted()
    let merged = 0

    for (const [key, remoteEntry] of Object.entries(remote)) {
      if (!remoteEntry || typeof remoteEntry !== 'object' || typeof remoteEntry.approved !== 'boolean') continue
      const localEntry = local[key]
      if (!localEntry || (remoteEntry.updatedAt ?? 0) >= (localEntry.updatedAt ?? 0)) {
        local[key] = remoteEntry
        merged++
      }
    }

    if (merged > 0) {
      this.savePersisted(local)
      log.info(`Synced ${merged} remote approval preferences into local cache`)
    }
  }

  /**
   * 导出当前 always 缓存，供上传到后端同步。
   * 仅返回未过期的 approved=true 条目。
   */
  getAlwaysPreferences(): Record<string, ScopeEntry> {
    const persisted = this.loadPersisted()
    const result: Record<string, ScopeEntry> = {}
    for (const [key, entry] of Object.entries(persisted)) {
      if (entry.approved && !this.isExpired(entry)) {
        result[key] = entry
      }
    }
    return result
  }

  /** 与内部 buildKey 同口径，供 platform-approval-bridge 复用。 */
  getCacheKey(actionType: string, detail?: string): string {
    return this.buildKey(actionType, detail)
  }

  /**
   * 缓存键构建：
   * - write_file / edit_file / delete_file + 有路径 → actionType:dirPrefix
   * - 其他 → actionType
   */
  private buildKey(actionType: string, detail?: string): string {
    if (FILE_ACTION_TYPES.has(actionType) && detail) {
      const dirPrefix = this.extractDirPrefix(detail)
      if (dirPrefix) return `${actionType}:${dirPrefix}`
    }
    return actionType
  }

  /**
   * 从文件路径提取前两级目录。
   * src/components/Button.tsx → src/components
   * /home/user/project/file.ts → /home/user
   */
  private extractDirPrefix(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/')
    const segments = normalized.split('/').filter(Boolean)

    if (segments.length < 2) return null

    const dirs = segments.slice(0, -1)
    const prefix = dirs.slice(0, 2).join('/')
    return normalized.startsWith('/') ? `/${prefix}` : prefix
  }

  private isExpired(entry: ScopeEntry): boolean {
    if (!entry.updatedAt) return false
    return Date.now() - entry.updatedAt > ALWAYS_TTL_MS
  }

  private loadPersisted(): Record<string, ScopeEntry> {
    try {
      return configService.get(CONFIG_KEY) || {}
    } catch {
      return {}
    }
  }

  private savePersisted(data: Record<string, ScopeEntry>): void {
    try {
      configService.set(CONFIG_KEY, data)
    } catch (err) {
      log.warn('Failed to persist approval scope cache:', err)
    }
  }
}

export const approvalScopeCache = new ApprovalScopeCacheImpl()
