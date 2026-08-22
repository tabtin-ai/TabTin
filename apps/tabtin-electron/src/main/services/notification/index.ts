/**
 * NotificationService — 主进程统一通知编排
 *
 * 所有通知（IM、Agent、下载、Extension、Goal 等）统一经此服务发出。
 * 内部委托给 4 个子模块：Presenter、Badge、PrefsStore、Throttle。
 */

import { BrowserWindow } from 'electron'
import { guardedHandle, guardedOn } from '../../utils/guarded-handle'
import { createLogger } from '../../logger'
import { getAllWindows, getMainWindow, isMainWindowNotificationHostReady } from '../../window-manager'
import type { CategoryOverride, NotificationPayload, NotificationPermissionStatus, NotificationPrefs } from './types'
import { resolveCategoryKey } from './types'
import { OsNotificationPresenter } from './presenter'
import { BadgeController } from './badge'
import { NotificationPrefsStore } from './prefs-store'
import { NotificationThrottle } from './throttle'
import { resolveNotificationPermissionStatus } from './permission-status'

export type { NotificationPayload, NotificationPermissionStatus, NotificationPrefs } from './types'

const log = createLogger('Notification')

const AGGREGATE_TITLE = (n: number) => `${n} more notifications / 还有 ${n} 条通知`
const AGGREGATE_BODY = 'Recent similar notifications were merged / 最近有多条相似通知被合并'

type NotificationServiceInitOptions = {
  ensureMainWindow?: () => BrowserWindow | null | Promise<BrowserWindow | null>
}

type ToastFallbackReason =
  | 'source-window-focused'
  | 'notifications-disabled'
  | 'explicit-desktop-suppressed'
  | 'desktop-disabled'
  | 'presenter-unavailable'
  | 'presenter-delivery-failed'
  | 'dnd'
  | 'throttled'

const DESKTOP_UNAVAILABLE_FALLBACK_REASONS: ReadonlySet<ToastFallbackReason> = new Set([
  'desktop-disabled',
  'presenter-unavailable',
  'presenter-delivery-failed',
])

class NotificationServiceImpl {
  private presenter = new OsNotificationPresenter()
  private badge = new BadgeController()
  private prefs = new NotificationPrefsStore()
  private throttle = new NotificationThrottle()
  private permissionStatus: NotificationPermissionStatus = resolveNotificationPermissionStatus()

  init(options: NotificationServiceInitOptions = {}): void {
    this.presenter.setEnsureMainWindow(options.ensureMainWindow)
    this.checkPermission()
    this.registerIPC()
    this.throttle.startAutoCleanup()
    log.info('通知服务初始化完成')
  }

  destroy(): void {
    this.throttle.stopAutoCleanup()
  }

  // ── 公开方法 ────────────────────────────────────────────

  show(payload: NotificationPayload, sourceWindow?: BrowserWindow | null): void {
    if (process.platform === 'darwin') {
      const status = resolveNotificationPermissionStatus()
      this.permissionStatus = status
      this.presenter.setPermissionGranted(status.granted || status.status === 'not-determined')
    }

    const sourceWindowFocused = Boolean(
      payload.suppressWhenSourceWindowFocused
      && sourceWindow
      && !sourceWindow.isDestroyed()
      && sourceWindow.isVisible()
      && !sourceWindow.isMinimized()
      && sourceWindow.isFocused(),
    )
    if (sourceWindowFocused) {
      const dedupKey = this.buildDedupKey(payload)
      if (dedupKey?.startsWith('dedup_ref|')) {
        this.throttle.checkDedup(dedupKey)
      }
      if (
        payload.markSessionViewedWhenSuppressed
        && payload.navigateTo?.type === 'chat-session'
      ) {
        sourceWindow?.webContents.send('notification:session-viewed', {
          sessionId: payload.navigateTo.id,
        })
      }
      log.debug('来源窗口正在查看当前会话，抑制通知', { type: payload.type })
      this.fallbackToToast(payload, 'source-window-focused', sourceWindow)
      return
    }

    const userPrefs = this.prefs.get()
    if (!userPrefs.enabled) {
      this.fallbackToToast(payload, 'notifications-disabled', sourceWindow)
      return
    }

    const categoryKey = resolveCategoryKey(payload.type)
    const overrides = this.resolveCategoryOverride(userPrefs, categoryKey)
    const preferenceDesktopDelivery = this.resolveDesktopDelivery(categoryKey, overrides)
    const desktopDelivery = payload.desktopDelivery ?? preferenceDesktopDelivery
    const preferenceDisablesDesktop = payload.desktopDelivery === undefined
      && preferenceDesktopDelivery === 'never'
    const deferDesktopUnavailableFallback = payload.toastFallback === 'desktop-unavailable'
      && preferenceDisablesDesktop
    if (desktopDelivery === 'never' && !deferDesktopUnavailableFallback) {
      this.fallbackToToast(
        payload,
        payload.desktopDelivery === 'never'
          ? 'explicit-desktop-suppressed'
          : 'desktop-disabled',
        sourceWindow,
      )
      return
    }
    const shouldDesktop = !preferenceDisablesDesktop
      && (overrides?.desktopEnabled ?? userPrefs.desktopEnabled)
    const shouldSound = overrides?.soundEnabled ?? userPrefs.soundEnabled

    // ── in-app shown 广播（偏好允许的每条都进，多窗口去重不传染到 in-app 路径）──
    // 设计取舍（W6-D8）：
    //   - in-app 通知中心 / Bell 角标走 NotificationStore，按 notification.id
    //     自然 dedup（多窗口下同 id 是同一条 notification 实体），不需要在
    //     IPC 层去重；
    //   - desktop OS 通知是 `new Notification()` 实例化，没有自然 dedup，
    //     所以只在 desktop 那一侧去重即可。
    if (payload.mirrorToCenter !== false) {
      this.notifyRenderer('notification:shown', {
        type: payload.type,
        title: payload.title,
        body: payload.body,
        priority: payload.priority,
        organizationId: payload.organizationId,
        spaceId: payload.spaceId,
        navigateTo: payload.navigateTo as unknown as Record<string, unknown> | undefined,
      })
    }

    // ── Wave 6 W6-D（R5-12）多窗口同账号 OS 通知去重 ─────────────────
    // 时机：放在 `prefs.enabled` 之后、`isUrgent` / DND / throttle 之前
    //   - 在 enabled 之后：用户关了通知就不消耗 dedup 槽位
    //   - 在 throttle 之前：dedup 命中跳过 throttle，避免被未弹出的通知
    //     错误累加 throttle.count（dedup 概念上比 throttle 更基础——
    //     dedup 是 "这条通知刚刚弹过"，throttle 是 "这种类型最近弹太多"）
    //   - urgent 不豁免 dedup：紧急事件也不应该多窗口连弹 N 次
    //   - DND 留在 dedup 之后：dedup 是对 "这条 OS 通知是否要弹" 的判定，
    //     DND 是对 "弹出后会不会打扰用户"，逻辑独立
    const dedupKey = this.buildDedupKey(payload)
    if (dedupKey) {
      const { duplicate } = this.throttle.checkDedup(dedupKey)
      if (duplicate) {
        log.debug('多窗口重复通知去重，丢弃 desktop notification:', dedupKey)
        return
      }
    }

    const isUrgent = payload.priority === 'urgent'
    if (!isUrgent && NotificationThrottle.isDnd(userPrefs)) {
      this.fallbackToToast(payload, 'dnd', sourceWindow)
      return
    }

    if (!isUrgent) {
      const { throttled, suppressedCount } = this.throttle.checkThrottle(payload.type)
      if (throttled) {
        if (shouldDesktop && suppressedCount > 0 && this.throttle.canSendAggregate()) {
          this.presenter.show({
            type: 'system.aggregate',
            title: AGGREGATE_TITLE(suppressedCount),
            body: AGGREGATE_BODY,
            priority: 'low',
            onClick: 'navigate',
            navigateTo: { type: 'notification-panel', id: 'bell' },
          }, false)
        }
        this.fallbackToToast(payload, 'throttled', sourceWindow)
        return
      }
    }

    if (shouldDesktop) {
      const desktopPayload = { ...payload, desktopDelivery }
      let didFallback = false
      const fallbackOnce = (reason: ToastFallbackReason) => {
        if (didFallback) return
        didFallback = true
        this.fallbackToToast(payload, reason, sourceWindow)
      }
      try {
        const attempted = payload.toastFallback
          ? this.presenter.show(
              desktopPayload,
              shouldSound,
              { onFailed: () => fallbackOnce('presenter-delivery-failed') },
            )
          : this.presenter.show(desktopPayload, shouldSound)
        if (!attempted) fallbackOnce('presenter-unavailable')
      } catch (error) {
        log.warn('桌面通知投递异常，按策略回退 Toast', { type: payload.type, error })
        fallbackOnce('presenter-unavailable')
      }
    } else {
      this.fallbackToToast(payload, 'desktop-disabled', sourceWindow)
    }
  }

  private fallbackToToast(
    payload: NotificationPayload,
    reason: ToastFallbackReason,
    sourceWindow?: BrowserWindow | null,
  ): void {
    const policy = payload.toastFallback
    const shouldFallback = policy === true
      || (policy === 'desktop-unavailable' && DESKTOP_UNAVAILABLE_FALLBACK_REASONS.has(reason))
    if (!shouldFallback) return
    const target = sourceWindow && !sourceWindow.isDestroyed()
      ? sourceWindow
      : getMainWindow() ?? getAllWindows().find((win) => !win.isDestroyed())
    target?.webContents.send('notification:toast-fallback', {
      type: payload.type,
      title: payload.title,
      body: payload.body,
    })
  }

  private resolveDesktopDelivery(
    categoryKey: string | undefined,
    overrides: CategoryOverride | undefined,
  ): NotificationPayload['desktopDelivery'] | undefined {
    if (overrides?.desktopDelivery) return overrides.desktopDelivery
    if (overrides?.desktopEnabled === false) return 'never'

    // Agent 通知是后台任务状态变化；除了“正看当前会话”的 renderer 侧门闩外，
    // 默认应按 Wiki 口径持续提醒，不再被“应用聚焦”整体抑制。
    if (
      categoryKey === 'agent.task.result'
      || categoryKey === 'agent.task.interruption'
      || categoryKey === 'agent.hitl'
    ) {
      return 'always'
    }

    return undefined
  }

  private resolveCategoryOverride(
    prefs: NotificationPrefs,
    categoryKey: string | undefined,
  ): CategoryOverride | undefined {
    if (!categoryKey) return undefined
    const direct = prefs.categoryOverrides[categoryKey]
    if (direct) return direct
    if (
      categoryKey === 'agent.task.result'
      || categoryKey === 'agent.task.interruption'
      || categoryKey === 'agent.hitl'
    ) {
      return prefs.categoryOverrides['agent.task']
    }
    return undefined
  }

  /**
   * Wave 6 W6-D8：构造多窗口同账号 OS 通知去重 key。
   *
   * 优先级（高 → 低）：
   *   1. `metadata.dedup_ref`
   *      —— 本地生命周期与服务端持久通知用同一执行 trace 关联；该精确身份
   *      使用更长的去重窗口，覆盖异步持久化和事件转发延迟
   *   2. `metadata.message_ref`
   *      —— 同一消息经多窗口或不同消息投影出口到达时共用消息身份
   *   3. `${type}|${navigateTo.type}|${navigateTo.id}` 三元组
   *      —— navigateTo.id 是事件维度真正的 unique 标识
   *      （chat-session-id / goal-id / approval-id / im-conversation-id 等），
   *      多窗口同事件必然走同一 navigateTo
   *   4. `${type}|fallback|${title}` fallback
   *      —— navigateTo / navigateTo.id 缺失时退化（例如 'agenda' 类型 id 可选、
   *      billing.blocked / system.aggregate 等无导航通知）。
   *      产品取舍：宁可放过也不要丢通知（本质是去 “重复”，不是 “过滤”）；
   *      若不同事件 title 文案完全相同（例如同模板化标题），理论上有 5s 内
   *      被误去重的极小概率，但设计上判断 “title 相同 = 同一通知” 在用户
   *      感知上也合理（用户看到 “Insufficient credits” 弹两次也只会困惑一次）。
   *   5. 都缺则返回 null —— caller 跳过 dedup 直接放行
   */
  private buildDedupKey(payload: NotificationPayload): string | null {
    const dedupRef = payload.metadata?.dedup_ref
    if (typeof dedupRef === 'string' && dedupRef.trim()) {
      return `dedup_ref|${dedupRef.trim()}`
    }

    const messageRef = payload.metadata?.message_ref
    if (typeof messageRef === 'string' && messageRef.trim()) {
      return `message_ref|${messageRef.trim()}`
    }

    const nav = payload.navigateTo
    // 用 'in' 类型守卫替代 as 强转：NavigateTarget 是判别联合，
    // 'agenda' 分支 id 可选；其它分支 id 必填但运行时仍可能因数据
    // 异常缺失，因此用类型窄化 + truthy 判断更稳健（空字符串也会
    // 退化到 fallback 而非生成 `${type}|chat-session|`）。
    const navigateType = nav?.type
    const navigateId =
      nav && 'id' in nav && typeof nav.id === 'string' && nav.id.length > 0
        ? nav.id
        : undefined
    if (navigateType && navigateId) {
      return `${payload.type}|${navigateType}|${navigateId}`
    }
    if (payload.title) {
      return `${payload.type}|fallback|${payload.title}`
    }
    return null
  }

  setBadgeCount(count: number): void {
    this.badge.setCount(count)
  }

  clearBadge(): void {
    this.badge.clear()
  }

  getPermissionStatus(): NotificationPermissionStatus {
    // ：每次读取都重新探测 OS，避免设置页/IPC 消费者拿到启动时缓存的陈旧状态。
    this.checkPermission()
    return this.permissionStatus
  }

  getPrefs(): NotificationPrefs {
    return this.prefs.get()
  }

  setPrefs(partial: Partial<NotificationPrefs>): void {
    this.prefs.set(partial)
    // 本地改动后向所有窗口广播最新偏好，保证多窗口设置面板一致。
    this.broadcastPrefs()
  }

  // ── 权限侦测 ──────────────────────────────────────────────

  private checkPermission(): void {
    const status = resolveNotificationPermissionStatus()
    const prev = this.permissionStatus
    this.permissionStatus = status
    this.presenter.setPermissionGranted(status.granted || status.status === 'not-determined')
    if (prev.status !== status.status || prev.source !== status.source) {
      log.info('通知权限状态:', `${status.status} (${status.source})`)
    }
  }

  // ── IPC 注册 ──────────────────────────────────────────────

  private registerIPC(): void {
    guardedOn('notification:show', (event, payload: NotificationPayload) => {
      this.show(payload, BrowserWindow.fromWebContents(event.sender))
    })

    guardedHandle('notification:getPermissionStatus', () => {
      return this.getPermissionStatus()
    })

    guardedHandle('notification:getHostState', () => {
      return {
        hasMainWindow: isMainWindowNotificationHostReady(),
      }
    })

    guardedHandle('notification:getPrefs', () => {
      return this.getPrefs()
    })

    guardedHandle('notification:setPrefs', (_event, partial: Partial<NotificationPrefs>) => {
      this.setPrefs(partial)
      return { success: true }
    })

    // IA Phase 2：登录态拉取一次服务器通知偏好并合并（renderer 登录 effect 触发）。
    guardedHandle('notification:syncPrefsFromServer', async () => {
      const changed = await this.prefs.syncFromRemote()
      if (changed) this.broadcastPrefs()
      return { success: true }
    })

    // IA Phase 2：renderer 从 WS ui_settings_changed 取出 notificationPrefs 信封后
    // 经此 IPC 转发到主进程回灌（仅写本地、不再 PUT；applyRemotePrefs 内部按
    // updatedAt 严格比较断回声环）。
    guardedOn('notification:applyRemotePrefs', (_event, payload: { value?: unknown; updatedAt?: number }) => {
      if (!payload || typeof payload !== 'object' || typeof payload.updatedAt !== 'number') return
      const changed = this.prefs.applyRemotePrefs(payload.value, payload.updatedAt)
      if (changed) this.broadcastPrefs()
    })

    guardedHandle('notification:setBadgeCount', (_event, count: number) => {
      this.setBadgeCount(count)
      return { success: true }
    })

    guardedHandle('notification:clearBadge', () => {
      this.clearBadge()
      return { success: true }
    })

    guardedHandle('notification:checkPermission', () => {
      // getPermissionStatus 内部已重新探测 OS
      return this.getPermissionStatus()
    })
  }

  // ── 工具方法 ──────────────────────────────────────────────

  private notifyRenderer(channel: string, data: Record<string, unknown>): void {
    for (const win of getAllWindows()) {
      win.webContents.send(channel, data)
    }
  }

  /** 向所有窗口广播当前通知偏好（设置面板订阅 `notification:prefs-changed` 刷新）。 */
  private broadcastPrefs(): void {
    this.notifyRenderer('notification:prefs-changed', this.prefs.get() as unknown as Record<string, unknown>)
  }
}

// ── 单例导出 ──────────────────────────────────────────────

export const notificationService = new NotificationServiceImpl()
