import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * NotificationServiceImpl.show — Wave 6 W6-D（R5-12）多窗口同账号 OS 通知去重
 *
 * 核心断言：
 *   - 同一 (type, navigateTo.type, navigateTo.id) 5s 内 → presenter.show 只调一次
 *   - 不同 navigateTo.id → presenter.show 调两次（不同 task 不被误伤）
 *   - 5s 窗口过期 → 再次允许
 *   - 缺 navigateTo 时退化为 (type, title) 仍能去重
 *   - in-app `notification:shown` IPC 不受 dedup 影响（每条都广播，
 *     由 NotificationStore 自身按 notification.id 去重）
 *   - prefs.enabled=false 时 → 直接 return，不消耗 dedup 槽位
 *     （prefs 已收敛到账号级，不再按 organization 分桶——2026-05 治理）
 */

const {
  presenterShowMock,
  presenterSetPermissionGrantedMock,
  presenterSetEnsureMainWindowMock,
  webContentsSendMock,
  mockWindows,
  prefsState,
  DEFAULT_PREFS_VALUE,
} = vi.hoisted(() => {
  const presenterShowMock = vi.fn()
  const presenterSetPermissionGrantedMock = vi.fn()
  const presenterSetEnsureMainWindowMock = vi.fn()
  const webContentsSendMock = vi.fn()
  const mockWindows: Array<{
    webContents: { send: typeof webContentsSendMock }
    isDestroyed: () => boolean
  }> = []
  const DEFAULT_PREFS_VALUE = {
    enabled: true,
    desktopEnabled: true,
    dockBadgeEnabled: true,
    soundEnabled: true,
    dndEnabled: false,
    categoryOverrides: {},
  }
  const prefsState = {
    override: {} as Partial<typeof DEFAULT_PREFS_VALUE>,
  }
  return {
    presenterShowMock,
    presenterSetPermissionGrantedMock,
    presenterSetEnsureMainWindowMock,
    webContentsSendMock,
    mockWindows,
    prefsState,
    DEFAULT_PREFS_VALUE,
  }
})

vi.mock('../../../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
  guardedOn: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../../window-manager', () => ({
  getAllWindows: () => mockWindows,
  getMainWindow: () => mockWindows[0] ?? null,
  isMainWindowNotificationHostReady: () => true,
}))

vi.mock('../permission-status', () => ({
  resolveNotificationPermissionStatus: () => ({
    supported: true,
    granted: true,
    status: 'authorized',
    source: 'fallback',
    platform: process.platform,
  }),
}))

vi.mock('../presenter', () => {
  class OsNotificationPresenter {
    show = presenterShowMock
    setPermissionGranted = presenterSetPermissionGrantedMock
    setEnsureMainWindow = presenterSetEnsureMainWindowMock
  }
  return { OsNotificationPresenter }
})

vi.mock('../badge', () => {
  class BadgeController {
    setCount = vi.fn()
    clear = vi.fn()
    getCount = () => 0
  }
  return { BadgeController }
})

vi.mock('../prefs-store', () => {
  class NotificationPrefsStore {
    get() {
      return { ...DEFAULT_PREFS_VALUE, ...prefsState.override }
    }
    set = vi.fn()
    resetCache = vi.fn()
  }
  return { NotificationPrefsStore }
})

import { notificationService } from '../index'
import type { NotificationPayload } from '../types'

function resetServiceState() {
  const throttle = (notificationService as any).throttle
  throttle.clearDedup()
  ;(throttle as any).map.clear()
  ;(throttle as any).lastAggregateAt = 0
}

function pushMockWindow() {
  mockWindows.push({
    webContents: { send: webContentsSendMock },
    isDestroyed: () => false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  presenterShowMock.mockReturnValue(true)
  vi.useRealTimers()
  mockWindows.length = 0
  prefsState.override = {}
  resetServiceState()
  pushMockWindow()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('NotificationServiceImpl.show — Wave 6 W6-D 多窗口去重', () => {
  it('下载通知仅在 OS 未投递时回退一次 Toast', () => {
    const payload: NotificationPayload = {
      type: 'download.completed',
      title: '下载完成',
      body: 'report.pdf',
      mirrorToCenter: false,
      toastFallback: true,
    }

    notificationService.show(payload)
    expect(webContentsSendMock).not.toHaveBeenCalledWith(
      'notification:toast-fallback',
      expect.anything(),
    )

    resetServiceState()
    presenterShowMock.mockReturnValueOnce(false)
    notificationService.show(payload)
    expect(webContentsSendMock).toHaveBeenCalledWith(
      'notification:toast-fallback',
      expect.objectContaining({ type: 'download.completed' }),
    )
  })

  it('同一 payload 5s 内两次 → presenter.show 只调用一次', () => {
    const payload: NotificationPayload = {
      type: 'agent.task.error',
      title: 'Task X failed',
      body: 'detail',
      priority: 'high',
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }
    notificationService.show(payload)
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('同 type 不同 navigateTo.id → presenter.show 调两次（不同 task 不误伤）', () => {
    notificationService.show({
      type: 'agent.task.error',
      title: 'Task A',
      body: '',
      navigateTo: { type: 'chat-session', id: 'session-A' },
    })
    notificationService.show({
      type: 'agent.task.error',
      title: 'Task B',
      body: '',
      navigateTo: { type: 'chat-session', id: 'session-B' },
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('同一 message_ref 的 Agent 终态与 IM 投影 → 只弹一次', () => {
    notificationService.show({
      type: 'agent.task.completed',
      title: 'Agent 任务完成',
      body: '处理完成',
      metadata: { message_ref: 'message-ref-shared' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })
    notificationService.show({
      type: 'im.agent_task_update',
      title: '项目群',
      body: 'Agent: 处理完成',
      metadata: { message_ref: 'message-ref-shared' },
      navigateTo: { type: 'im-conversation', id: 'conversation-1' },
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('同一 dedup_ref 的本地终态与服务端持久通知 → 只弹一次', () => {
    notificationService.show({
      type: 'agent.task.completed',
      title: 'Agent 任务完成',
      body: '处理完成',
      metadata: { dedup_ref: 'trace-shared', message_ref: 'local-message' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })
    notificationService.show({
      type: 'agent.task.completed',
      title: '处理完成',
      body: '新任务',
      metadata: { dedup_ref: 'trace-shared', message_ref: 'server-message' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })

    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('不同 dedup_ref 即使 source_client_event_id 相同也不误去重', () => {
    notificationService.show({
      type: 'agent.task.completed',
      title: '第一次执行',
      body: '',
      metadata: { dedup_ref: 'trace-a', message_ref: 'source-client-event' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })
    notificationService.show({
      type: 'agent.task.completed',
      title: '第二次执行',
      body: '',
      metadata: { dedup_ref: 'trace-b', message_ref: 'source-client-event' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })

    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('精确 dedup_ref 超过普通 5 秒窗口仍去重', () => {
    vi.useFakeTimers()
    const payload: NotificationPayload = {
      type: 'agent.task.completed',
      title: 'Done',
      body: '',
      metadata: { dedup_ref: 'trace-delayed' },
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }
    notificationService.show(payload)
    vi.advanceTimersByTime(10_000)
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('不同 message_ref 即使导航目标相同 → 两条都弹', () => {
    notificationService.show({
      type: 'im.message',
      title: '项目群',
      body: '第一条',
      metadata: { message_ref: 'message-ref-a' },
      navigateTo: { type: 'im-conversation', id: 'conversation-1' },
    })
    notificationService.show({
      type: 'im.message',
      title: '项目群',
      body: '第二条',
      metadata: { message_ref: 'message-ref-b' },
      navigateTo: { type: 'im-conversation', id: 'conversation-1' },
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('没有 navigateTo 但 title 不同 → fallback 不命中，两次都弹', () => {
    notificationService.show({
      type: 'billing.blocked',
      title: 'Quota A reached',
      body: '',
    })
    notificationService.show({
      type: 'billing.blocked',
      title: 'Quota B reached',
      body: '',
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('没有 navigateTo 但 title 相同 → fallback 命中，第二次去重', () => {
    notificationService.show({
      type: 'billing.blocked',
      title: 'Insufficient credits',
      body: 'first',
    })
    notificationService.show({
      type: 'billing.blocked',
      title: 'Insufficient credits',
      body: 'second',
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('5s 窗口过期后再 show 同 payload → 第二次又弹', () => {
    vi.useFakeTimers()
    const payload: NotificationPayload = {
      type: 'agent.task.error',
      title: 'Task X failed',
      body: '',
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(6000)
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('多窗口模拟：2 个 renderer 几乎同时触发同事件 → presenter.show 仅一次', () => {
    // 模拟 2 个主窗口都通过 IPC 'notification:show' 触达主进程
    pushMockWindow() // 现在 mockWindows 有 2 个
    const payload: NotificationPayload = {
      type: 'agent.hitl.waiting',
      title: 'Approval needed',
      body: 'rm -rf',
      priority: 'urgent', // urgent 也不豁免 dedup（W6-D 设计取舍）
      navigateTo: { type: 'chat-session', id: 'session-shared' },
    }
    notificationService.show(payload)
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('navigateTo / title 都缺 → dedup key 为 null，不去重（fallthrough）', () => {
    const payload: NotificationPayload = {
      type: 'opaque.event',
      title: '',
      body: '',
    }
    notificationService.show(payload)
    notificationService.show(payload)
    // title 为空字符串，两次都不构造 dedup key → 两次都放行
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })

  it('tracker 类型 navigateTo（id 缺失）→ 退化用 title 去重', () => {
    notificationService.show({
      type: 'tracker.run.completed',
      title: 'Tracker done',
      body: '',
      navigateTo: { type: 'tracker' } as any,
    })
    notificationService.show({
      type: 'tracker.run.completed',
      title: 'Tracker done',
      body: '',
      navigateTo: { type: 'tracker' } as any,
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('navigateTo.id 为空字符串 → 视为缺失，退化到 (type, title) fallback', () => {
    // 数据异常防御：上游若把 id 写成 ''，buildDedupKey 不应该生成
    // `agent.task.error|chat-session|` 这种 truncated key（否则任何
    // id='' 的不同 task 都会撞同一 key 被全部去重）
    notificationService.show({
      type: 'agent.task.error',
      title: 'Task A',
      body: '',
      navigateTo: { type: 'chat-session', id: '' },
    })
    notificationService.show({
      type: 'agent.task.error',
      title: 'Task B',
      body: '',
      navigateTo: { type: 'chat-session', id: '' },
    })
    // title 不同 → fallback 不命中 → 两次都弹（防御 truncated key bug）
    expect(presenterShowMock).toHaveBeenCalledTimes(2)
  })
})

describe('NotificationServiceImpl.show — 持久通知 Desktop 可用性回退', () => {
  const toastFallbackCalls = () => webContentsSendMock.mock.calls
    .filter(([channel]) => channel === 'notification:toast-fallback')

  const accountPayload = (overrides: Partial<NotificationPayload> = {}): NotificationPayload => ({
    type: 'account.degradation_alert',
    title: '服务降级提醒',
    body: '部分能力暂时受限',
    metadata: { dedup_ref: 'billing:event:1' },
    toastFallback: 'desktop-unavailable',
    ...overrides,
  })

  it('Desktop 成功投递时不回退 Toast', () => {
    notificationService.show(accountPayload())

    expect(presenterShowMock).toHaveBeenCalledTimes(1)
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('Desktop 全局关闭时回退 Toast', () => {
    prefsState.override = { desktopEnabled: false }

    notificationService.show(accountPayload())

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toEqual([[
      'notification:toast-fallback',
      expect.objectContaining({ type: 'account.degradation_alert' }),
    ]])
  })

  it.each([
    [{ desktopEnabled: false }, '分类 Desktop 关闭'],
    [{ desktopDelivery: 'never' as const }, '分类 Desktop 策略关闭'],
  ])('%s 时回退 Toast', (categoryOverride) => {
    prefsState.override = {
      categoryOverrides: { account: categoryOverride },
    } as any

    notificationService.show(accountPayload())

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toEqual([[
      'notification:toast-fallback',
      expect.objectContaining({ type: 'account.degradation_alert' }),
    ]])
  })

  it('分类 Desktop 关闭且命中 DND 时不投递 Desktop 也不回退 Toast', () => {
    prefsState.override = {
      dndEnabled: true,
      categoryOverrides: { account: { desktopEnabled: false } },
    } as any

    notificationService.show(accountPayload())

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('分类 Desktop 关闭时，同一持久通知只回退一次 Toast', () => {
    prefsState.override = {
      categoryOverrides: { account: { desktopEnabled: false } },
    } as any
    const payload = accountPayload()

    notificationService.show(payload)
    notificationService.show(payload)

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(1)
  })

  it.each([
    ['分类 Desktop 关闭', {
      categoryOverrides: { account: { desktopEnabled: false } },
    }],
    ['全局 Desktop 关闭', { desktopEnabled: false }],
  ])('%s时超过限流上限：最多三条 Toast，不发 aggregate Desktop', (_label, prefsOverride) => {
    prefsState.override = prefsOverride as any

    for (let index = 0; index < 4; index += 1) {
      notificationService.show(accountPayload({
        title: `服务降级提醒 ${index}`,
        metadata: { dedup_ref: `billing:desktop-off:${index}` },
      }))
    }

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(3)
  })

  it('旧 boolean=true 保留分类 Desktop 关闭时的早退回退语义', () => {
    prefsState.override = {
      dndEnabled: true,
      categoryOverrides: { account: { desktopEnabled: false } },
    } as any

    notificationService.show(accountPayload({ toastFallback: true }))

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(1)
  })

  it('payload 显式要求 desktopDelivery=never 时不绕过用户意图回退 Toast', () => {
    notificationService.show(accountPayload({ desktopDelivery: 'never' }))

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('旧 boolean=true 保留 payload 显式 desktopDelivery=never 的早退回退语义', () => {
    notificationService.show(accountPayload({
      desktopDelivery: 'never',
      toastFallback: true,
    }))

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(1)
  })

  it('presenter 同步报告未投递时回退 Toast', () => {
    presenterShowMock.mockReturnValueOnce(false)

    notificationService.show(accountPayload())

    expect(toastFallbackCalls()).toEqual([[
      'notification:toast-fallback',
      expect.objectContaining({ type: 'account.degradation_alert' }),
    ]])
  })

  it.each([
    ['desktop-unavailable' as const, '新策略'],
    [true, '旧 boolean 策略'],
  ])('presenter 抛错时 %s 回退且不向上抛出', (toastFallback) => {
    presenterShowMock.mockImplementationOnce(() => {
      throw new Error('Notification constructor unavailable')
    })

    expect(() => notificationService.show(accountPayload({ toastFallback }))).not.toThrow()
    expect(toastFallbackCalls()).toEqual([[
      'notification:toast-fallback',
      expect.objectContaining({ type: 'account.degradation_alert' }),
    ]])
  })

  it('presenter 异步投递失败时回退 Toast', () => {
    notificationService.show(accountPayload())

    const callbacks = presenterShowMock.mock.calls[0]?.[2] as { onFailed?: () => void } | undefined
    callbacks?.onFailed?.()

    expect(callbacks?.onFailed).toBeTypeOf('function')
    expect(toastFallbackCalls()).toEqual([[
      'notification:toast-fallback',
      expect.objectContaining({ type: 'account.degradation_alert' }),
    ]])
  })

  it('新策略不在 source-window-focused 早期路径绕过其他抑制策略', () => {
    const focusedWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      webContents: { send: webContentsSendMock },
    } as any

    notificationService.show(accountPayload({ suppressWhenSourceWindowFocused: true }), focusedWindow)

    expect(presenterShowMock).not.toHaveBeenCalled()
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('旧 boolean=true 保留 source-window-focused 早期路径的旧回退语义', () => {
    const focusedWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      webContents: { send: webContentsSendMock },
    } as any

    notificationService.show(accountPayload({
      suppressWhenSourceWindowFocused: true,
      toastFallback: true,
    }), focusedWindow)

    expect(toastFallbackCalls()).toHaveLength(1)
  })

  it.each([
    ['通知总开关关闭', { enabled: false }],
    ['免打扰', { dndEnabled: true }],
  ])('%s 时不回退 Toast', (_label, prefsOverride) => {
    prefsState.override = prefsOverride

    notificationService.show(accountPayload())

    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('限流抑制时不回退 Toast', () => {
    for (let index = 0; index < 4; index += 1) {
      notificationService.show(accountPayload({
        title: `服务降级提醒 ${index}`,
        metadata: { dedup_ref: `billing:event:${index}` },
      }))
    }

    const accountCalls = presenterShowMock.mock.calls
      .filter(([payload]) => payload.type === 'account.degradation_alert')
    const aggregateCalls = presenterShowMock.mock.calls
      .filter(([payload]) => payload.type === 'system.aggregate')
    expect(accountCalls).toHaveLength(3)
    expect(aggregateCalls).toHaveLength(1)
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('去重抑制时不回退 Toast', () => {
    const payload = accountPayload()
    notificationService.show(payload)
    notificationService.show(payload)

    expect(presenterShowMock).toHaveBeenCalledTimes(1)
    expect(toastFallbackCalls()).toHaveLength(0)
  })

  it('旧 boolean=true 仍保留总开关关闭时的旧 Toast 回退语义', () => {
    prefsState.override = { enabled: false }

    notificationService.show(accountPayload({ toastFallback: true }))

    expect(toastFallbackCalls()).toHaveLength(1)
  })
})

describe('NotificationServiceImpl.show — in-app 通知不受 dedup 影响', () => {
  it('多窗口同 payload 两次 → notification:shown IPC 仍广播两次（in-app 自行 dedup）', () => {
    pushMockWindow() // 2 个窗口
    const payload: NotificationPayload = {
      type: 'agent.task.error',
      title: 'Task X failed',
      body: '',
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }
    notificationService.show(payload)
    notificationService.show(payload)

    // notifyRenderer('notification:shown', ...) 应每次都对 2 个窗口广播
    // 第 1 次：2 windows × 1 调用 = 2
    // 第 2 次：又 2 windows × 1 调用 = 2
    // 总：4 次 webContents.send（注：可能也包括其他 channel，但这里只关心 notification:shown）
    const shownCalls = webContentsSendMock.mock.calls.filter(([channel]) => channel === 'notification:shown')
    expect(shownCalls).toHaveLength(4)
    // 但 OS 通知 presenter.show 只调一次
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })
})

describe('NotificationServiceImpl.show — dedup 时机相对其他守卫', () => {
  it('prefs.enabled=false → 直接 return，不消耗 dedup 槽位（重新 enable 后同 key 仍能弹）', () => {
    prefsState.override = { enabled: false }
    const payload: NotificationPayload = {
      type: 'agent.task.error',
      title: 'Task X failed',
      body: '',
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(0)

    prefsState.override = { enabled: true }
    notificationService.show(payload)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })
})

describe('NotificationServiceImpl.show — Agent 通知偏好分流', () => {
  it('当前会话仅在 IPC 来源窗口原生聚焦可见时抑制', () => {
    const focusedWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
    } as any
    const hiddenWindow = {
      ...focusedWindow,
      isVisible: () => false,
    } as any
    const payload: NotificationPayload = {
      type: 'agent.hitl.waiting',
      title: 'Agent 等待回答',
      body: '请选择',
      priority: 'urgent',
      suppressWhenSourceWindowFocused: true,
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }

    notificationService.show(payload, focusedWindow)
    expect(presenterShowMock).not.toHaveBeenCalled()

    notificationService.show(payload, hiddenWindow)
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
  })

  it('前台抑制会登记精确身份并回告已读，迟到的第二出口不再弹出', () => {
    vi.useFakeTimers()
    const sourceSend = vi.fn()
    const focusedWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      isFocused: () => true,
      webContents: { send: sourceSend },
    } as any
    const payload: NotificationPayload = {
      type: 'agent.task.completed',
      title: 'Agent 任务完成',
      body: '处理完成',
      metadata: { dedup_ref: 'trace-suppressed' },
      suppressWhenSourceWindowFocused: true,
      markSessionViewedWhenSuppressed: true,
      navigateTo: { type: 'chat-session', id: 'session-1' },
    }

    notificationService.show(payload, focusedWindow)
    expect(sourceSend).toHaveBeenCalledWith('notification:session-viewed', {
      sessionId: 'session-1',
    })
    expect(presenterShowMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10_000)
    notificationService.show({
      ...payload,
      suppressWhenSourceWindowFocused: false,
      markSessionViewedWhenSuppressed: false,
    })
    expect(presenterShowMock).not.toHaveBeenCalled()
  })

  it('Agent 任务结果默认始终投递，交给 renderer 当前会话门闩做精确抑制', () => {
    notificationService.show({
      type: 'agent.task.completed',
      title: 'Done',
      body: 'summary',
      navigateTo: { type: 'chat-session', id: 'session-1' },
    })

    expect(presenterShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ desktopDelivery: 'always' }),
      true,
    )
  })

  it('调用方要求始终投递时，保留 desktopDelivery 策略给 presenter', () => {
    notificationService.show({
      type: 'tabdata.comment.mention.desktop_only',
      title: '你收到一条提及提醒',
      body: '你暂时没有访问关联内容的权限。',
      desktopDelivery: 'always',
    })

    expect(presenterShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ desktopDelivery: 'always' }),
      true,
    )
  })

  it('Agent 任务结果选择仅应用失焦时，传递 unfocused 策略给 presenter', () => {
    prefsState.override = {
      categoryOverrides: {
        'agent.task.result': {
          desktopDelivery: 'unfocused',
          desktopEnabled: true,
          soundEnabled: true,
        },
      },
    } as any

    notificationService.show({
      type: 'agent.task.error',
      title: 'Failed',
      body: 'detail',
      navigateTo: { type: 'chat-session', id: 'session-2' },
    })

    expect(presenterShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ desktopDelivery: 'unfocused' }),
      true,
    )
  })

  it('Agent 等待我处理关闭时，不发 desktop OS 通知，也不广播 in-app shown', () => {
    prefsState.override = {
      categoryOverrides: {
        'agent.hitl': { desktopEnabled: false, soundEnabled: false },
      },
    } as any

    notificationService.show({
      type: 'agent.hitl.waiting',
      title: 'Approval needed',
      body: 'detail',
      navigateTo: { type: 'chat-session', id: 'session-3' },
    })

    expect(presenterShowMock).not.toHaveBeenCalled()
    const shownCalls = webContentsSendMock.mock.calls.filter(([channel]) => channel === 'notification:shown')
    expect(shownCalls).toHaveLength(0)

    prefsState.override = {
      categoryOverrides: {
        'agent.hitl': { desktopEnabled: true, soundEnabled: true },
      },
    } as any
    notificationService.show({
      type: 'agent.hitl.waiting',
      title: 'Approval needed',
      body: 'detail',
      navigateTo: { type: 'chat-session', id: 'session-3' },
    })
    expect(presenterShowMock).toHaveBeenCalledTimes(1)
    const restoredShownCalls = webContentsSendMock.mock.calls.filter(([channel]) => channel === 'notification:shown')
    expect(restoredShownCalls).toHaveLength(1)
  })

  it('兼容旧 agent.task 总开关：没有细分配置时继续保持 Agent 安静', () => {
    prefsState.override = {
      categoryOverrides: {
        'agent.task': { desktopEnabled: false, soundEnabled: false },
      },
    } as any

    notificationService.show({
      type: 'agent.task.completed',
      title: 'Done',
      body: 'summary',
      navigateTo: { type: 'chat-session', id: 'session-legacy' },
    })

    expect(presenterShowMock).not.toHaveBeenCalled()
    const shownCalls = webContentsSendMock.mock.calls.filter(([channel]) => channel === 'notification:shown')
    expect(shownCalls).toHaveLength(0)
  })
})
