/**
 * NotificationPrefsStore — 账号级通知偏好持久化 + 内存缓存 + 跨设备同步
 *
 * 桌面横幅 / Dock 角标 / 声音 / 免打扰 / 分类开关 这些属于用户在本机的
 * 行为偏好，不取决于"当前在哪个 organization"——一份偏好对当前登录用户的
 * 所有 organization 一致生效。
 *
 * IA Phase 2（主进程范式，照搬 ApprovalManager）：
 * - 本地改动 persist 后 PUT `/auth/profile/ui-settings`（namespace=notificationPrefs，
 *   防抖 + authed 才发 + 失败静默重试）。
 * - 登录态拿到 token 后 `syncFromRemote()` 拉取一次合并（per-namespace LWW；
 *   owner guard 防共享设备串账号）。
 * - 收到其它设备 WS `ui_settings_changed` 回灌时 `applyRemotePrefs()` 只写本地、
 *   不再 PUT（断回声环）。
 * - 实际多窗口广播由上层 NotificationService 负责（这里只管缓存与后端往返）。
 */

import { net } from 'electron'
import { configService } from '../ConfigService'
import { createLogger } from '../../logger'
import { API_BASE_URL } from '../../config/api'
import { joinApiPath } from '@tabtin/config'
import { TokenManager } from '../../auth'
import { unwrapUISettingsMap } from '../../../shared/ui-settings-envelope'
import type { NotificationPrefs } from './types'
import { DEFAULT_PREFS } from './types'

const log = createLogger('NotificationPrefs')

const STORAGE_KEY = 'notification.userPrefs'
const META_KEY = 'notification.userPrefsMeta'
const UI_SETTINGS_PATH = '/auth/profile/ui-settings'
const NAMESPACE = 'notificationPrefs'

const SAVE_DEBOUNCE_MS = 600
const RETRY_BASE_DELAY_MS = 5_000
const MAX_RETRY = 5

export class NotificationPrefsStore {
  private cached: NotificationPrefs | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0

  get(): NotificationPrefs {
    if (this.cached) return this.cached
    this.cached = this.load()
    return this.cached
  }

  set(partial: Partial<NotificationPrefs>): void {
    const current = this.get()
    const merged: NotificationPrefs = {
      ...current,
      ...partial,
      categoryOverrides: {
        ...current.categoryOverrides,
        ...(partial.categoryOverrides ?? {}),
      },
    }
    this.cached = merged
    this.persist(merged)
    // 本地用户改动 → 记 updatedAt 并防抖写穿后端。
    this.setUpdatedAt(Date.now())
    this.schedulePut()
  }

  /** 测试用：清掉内存缓存，强制下次 get 重读磁盘。 */
  resetCache(): void {
    this.cached = null
  }

  // ── IA Phase 2 跨设备同步 ────────────────────────────────────

  /**
   * 应用来自其它设备的 WS 回灌（renderer 已从 `ui_settings_changed` envelope 取出
   * notificationPrefs 信封后经 IPC 转发）。仅当 `updatedAt` 严格新于本地才应用——
   * 这样本进程自己 PUT 引发的回声（updatedAt == 本地）不会再触发持久化 / 广播，
   * 天然断环。应用时只写本地、不再 PUT。返回是否真的变更（上层据此决定广播）。
   */
  applyRemotePrefs(value: unknown, updatedAt: number): boolean {
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return false
    if (updatedAt <= this.getUpdatedAt()) return false
    const next = this.normalize(value)
    this.cached = next
    this.persist(next)
    this.setUpdatedAt(updatedAt)
    log.info('应用其它设备的通知偏好变更')
    return true
  }

  /**
   * 登录态（拿到 token）后拉取一次并合并。返回是否变更（上层据此决定广播）。
   * owner guard：服务器对应的不是上次同步的同一 userId 时，先把本地重置为默认再
   * 合并，避免共享设备串账号（渲染层 5 类靠登出清 localStorage，主进程这份偏好
   * 不经登出清理，故用 owner guard 兜底）。
   */
  async syncFromRemote(): Promise<boolean> {
    const token = await this.getToken()
    if (!token) return false

    const owner = await this.resolveOwner()
    const prevOwner = this.getOwner()
    // 仅"账号切换"（有过不同的上一任 owner）才重置——首登（prevOwner 缺失）不重置，
    // 以免清掉登录前已配置的本地偏好（它仍可按 LWW 推回服务器）。
    if (owner && prevOwner && owner !== prevOwner) {
      this.cached = { ...DEFAULT_PREFS }
      this.persist(this.cached)
      this.setMeta({ updatedAt: 0, owner })
    }

    let remote: { value: unknown; updatedAt: number } | null = null
    try {
      const resp = await net.fetch(joinApiPath(API_BASE_URL, UI_SETTINGS_PATH), {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      })
      if (!resp.ok) {
        log.warn(`拉取 ui-settings 失败: HTTP ${resp.status}`)
        return false
      }
      remote = this.extractNamespace(await resp.json())
    } catch (err) {
      log.debug('拉取 ui-settings 异常（非阻塞）:', err)
      return false
    }

    if (remote && remote.updatedAt > this.getUpdatedAt()) {
      this.cached = this.normalize(remote.value)
      this.persist(this.cached)
      this.setMeta({ updatedAt: remote.updatedAt, owner: owner ?? this.getOwner() })
      return true
    }

    // 服务器无该 namespace / 本地较新 → 把本地推上去（seed / 刷新），记 owner。
    if (owner) this.setOwner(owner)
    this.schedulePut()
    return false
  }

  // ── 内部：归一 / 解析 / token ────────────────────────────────

  private normalize(value: unknown): NotificationPrefs {
    const v = (value && typeof value === 'object' ? value : {}) as Partial<NotificationPrefs>
    return {
      ...DEFAULT_PREFS,
      ...v,
      categoryOverrides: {
        ...(v.categoryOverrides && typeof v.categoryOverrides === 'object' ? v.categoryOverrides : {}),
      },
    }
  }

  /**
   * 从 GET 裸响应里挑出 notificationPrefs 信封。
   *
   * 复用 main/renderer 共享的 `unwrapUISettingsMap`（依次 unwrap
   * `payload → data → settings`）——main 走 `net.fetch`+`resp.json()` 拿到的是
   * 成功外壳 `{success, data:{settings:{...}}}`，**必须** unwrap 那层 `data`。
   * 早先这里只认 `body.settings`/`body[ns]` → 读到 null → 误判"服务器没有偏好"
   * → 把 DEFAULT 推回服务器静默清空用户偏好（阻断-1）。
   */
  private extractNamespace(body: unknown): { value: unknown; updatedAt: number } | null {
    const flat = unwrapUISettingsMap(body)
    const entry = flat[NAMESPACE]
    return entry ? { value: entry.value, updatedAt: entry.updatedAt } : null
  }

  private async getToken(): Promise<string | null> {
    try {
      return await TokenManager.getAccessToken()
    } catch (err) {
      log.debug('getAccessToken 失败:', err)
      return null
    }
  }

  private async resolveOwner(): Promise<string | null> {
    try {
      const user = await TokenManager.getUserInfo()
      const id = user?.id
      return id != null ? String(id) : null
    } catch {
      return null
    }
  }

  // ── 防抖写穿 + 静默重试 ──────────────────────────────────────

  private schedulePut(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flushPut(), SAVE_DEBOUNCE_MS)
  }

  private async flushPut(): Promise<void> {
    this.saveTimer = null
    const token = await this.getToken()
    if (!token) return

    let updatedAt = this.getUpdatedAt()
    if (!updatedAt) {
      updatedAt = Date.now()
      this.setUpdatedAt(updatedAt)
    }
    const prefs = this.get()

    try {
      const resp = await net.fetch(joinApiPath(API_BASE_URL, UI_SETTINGS_PATH), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: { [NAMESPACE]: { value: prefs, updatedAt } } }),
      })
      if (!resp.ok) {
        this.scheduleRetry(`HTTP ${resp.status}`)
        return
      }
      this.retryCount = 0
    } catch (err) {
      this.scheduleRetry(String(err))
    }
  }

  private scheduleRetry(reason: string): void {
    if (this.retryCount >= MAX_RETRY) {
      log.warn(`通知偏好写穿连续失败，放弃本批次（下次本地改动会重试）: ${reason}`)
      this.retryCount = 0
      return
    }
    this.retryCount += 1
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.flushPut(), RETRY_BASE_DELAY_MS * this.retryCount)
  }

  // ── 本地持久化 ──────────────────────────────────────────────

  private load(): NotificationPrefs {
    try {
      const saved = configService.get(STORAGE_KEY)
      if (saved && typeof saved === 'object') {
        return { ...DEFAULT_PREFS, ...saved }
      }
    } catch (err) {
      log.warn('加载通知偏好失败:', err)
    }
    return { ...DEFAULT_PREFS }
  }

  private persist(prefs: NotificationPrefs): void {
    try {
      configService.set(STORAGE_KEY, prefs)
    } catch (err) {
      log.warn('持久化通知偏好失败:', err)
    }
  }

  // ── 同步元信息（updatedAt + owner）─────────────────────────

  private getMeta(): { updatedAt: number; owner?: string } {
    try {
      const meta = configService.get(META_KEY)
      if (meta && typeof meta === 'object') {
        return {
          updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : 0,
          owner: typeof meta.owner === 'string' ? meta.owner : undefined,
        }
      }
    } catch {
      /* ignore — 元信息缺失只是退化为"服务器优先" */
    }
    return { updatedAt: 0 }
  }

  private setMeta(meta: { updatedAt: number; owner?: string }): void {
    try {
      configService.set(META_KEY, meta)
    } catch (err) {
      log.warn('持久化通知偏好同步元信息失败:', err)
    }
  }

  private getUpdatedAt(): number {
    return this.getMeta().updatedAt
  }

  private setUpdatedAt(updatedAt: number): void {
    this.setMeta({ ...this.getMeta(), updatedAt })
  }

  private getOwner(): string | undefined {
    return this.getMeta().owner
  }

  private setOwner(owner: string): void {
    this.setMeta({ ...this.getMeta(), owner })
  }
}
