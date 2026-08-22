/**
 * AppGlobalEffects — 全局副作用组件
 *
 * 承载所有全局事件流订阅、键盘快捷键监听、overlay 检测等副作用逻辑。
 * 该组件不渲染任何 UI（return null），因此其内部 store 变化不会触发
 * 父级 App 组件的重渲染。
 */
import React, { useEffect, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTemporaryTabListener } from '@hooks/useTemporaryTabListener'
import { useOrphanResourceReconcile } from '@hooks/useOrphanResourceReconcile'
import { useTabDiscardListener } from '@hooks/useTabDiscardListener'
import { usePartitionRebuildToast } from '@hooks/usePartitionRebuildToast'
import { useBillingEventStream } from '@hooks/useBillingEventStream'
import { useBillingRefreshListener } from '@/hooks/queries/membership'
import { useAppUpdater } from '@hooks/useAppUpdater'
import { useNotificationEventStream } from '@hooks/useNotificationEventStream'
import { useNotificationNavigator } from '@hooks/useNotificationNavigator'
import { useChatSessionPresence } from '@hooks/useChatSessionPresence'
import type { UseTrackerEventStreamOptions } from '@hooks/useTrackerEventStream'
import { TrackerSpaceStreams } from './TrackerSpaceStreams'
import { registerAllPlugins } from '@/plugins'
import { fetchUploadConfig } from '@/constants/upload'
import { retryPendingConfirms } from '@/services/oss-direct-uploader'
import { useUIStore } from '@stores/useUIStore'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useMemoRecordStyleStore } from '@stores/useMemoRecordStyleStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useSessionReadStore } from '@stores/useSessionReadStore'
import { useTrackerStore } from '@stores/useTrackerStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useChatModelStore } from '@stores/useChatModelStore'
import { useBrowserTabLockStore } from '@stores/useBrowserTabLockStore'
import { clearAllSessionLocalModelPreferences } from '@stores/chat/session/sessionLocalModelPreference'
import { SystemNotification } from '@/services/systemNotification'
import {
  invalidateTrackerAfterTrigger,
  shouldRefreshSidebarOnProgress,
} from '@/services/invalidateTrackerAfterTrigger'
import { useTranslation } from 'react-i18next'
import type { UIFontSize } from '@stores/useUIStore'
import {
  showBillingErrorToast,
  isBillingErrorCode,
  type QuotaResourceType,
} from '@/lib/billingErrorHandler'
import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import { installComposerPresetsWindowAPI } from '@/components/chat/composer-presets/windowApi'
import { streamingContent, initStreamingContent } from '@/stores/chat/execution/streamingContent'
import { getBusySessionIds } from '@/stores/chat/execution/sessionRunProjection'
import type { OrganizationSettingsSection } from '@/settings/settingsRoutes'
import { setupExitGuardListener } from '@components/context-space/dirtyExitConfirm/exitGuardListener'
import { setupSlideFlushListener } from '@components/slide/slide-flush-registry'
import { bootstrapTabDocProbe } from '@components/context-space/tabdoc/probeBootstrap'
import { bootstrapTabDataProbe } from '@components/context-space/tabdata/probeBootstrap'
import { bootstrapConversationViewportProbe } from '@components/chat/viewport/conversationViewportProbe'
import { bootstrapMockRunTerminationProbe } from '@/stores/chat/dev/mockRunTerminationProbe'
import { installHtml5DnDLifecycleProbe } from '@/services/html5DnDLifecycleProbe'
import { syncUISettingsFromServer, applyRemoteUISettingsFromEnvelope } from '@/stores/uiSettingsLoginSync'
import { extractRemoteSettings } from '@/stores/uiSettingsSync'
import { unwrapApprovalPreferences } from '@shared/approval-prefs-envelope'
import { syncNativeViewOverlayCountFromDom } from '@/utils/native-view-overlays'
import { focusExistingWebTabInSpace, openWebTabInSpace } from '@/services/openWebTabInSpace'
import { GLOBAL_SEARCH_UI_ENABLED } from '@/utils/featureFlags'

installComposerPresetsWindowAPI()

interface AppGlobalEffectsProps {
  isDetachedChat: boolean
  hasMainWindowHost: boolean
}

export function AppGlobalEffects({ isDetachedChat, hasMainWindowHost }: AppGlobalEffectsProps) {
  const { t: tTracker } = useTranslation('tabtracker')
  const { t: tCommon } = useTranslation('common')

  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const userId = useAuthStore(state => state.user?.id ?? null)
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const setNotificationOrganizationScope = useNotificationStore(state => state.setOrganizationScope)
  const initShownListener = useNotificationStore(state => state.initShownListener)

  // --- 通知事件流 ---
  useNotificationEventStream({
    userId,
    enabled: isAuthenticated && !!selectedOrganizationId && (!isDetachedChat || !hasMainWindowHost),
  })

  useEffect(() => window.tabtin?.notification?.onSessionViewed?.(({ sessionId }) => {
    if (sessionId) useSessionReadStore.getState().markViewed(sessionId)
  }), [])

  useEffect(() => {
    if (isDetachedChat) return
    return window.tabtin?.crawlView?.onAgentTabLockChanged(({ lockedViewIds }) => {
      useBrowserTabLockStore.getState().setLockedViewIds(lockedViewIds)
    })
  }, [isDetachedChat])

  // ChatGPT 本机连接是主窗级能力。连接变化后统一刷新聊天模型目录；断开或
  // refresh token 被上游拒绝时，同时移除旧会话的本机模型恢复记录，避免重启复活。
  useEffect(() => {
    if (isDetachedChat) return
    return window.tabtin?.openaiCodex?.onStatusChanged?.(({ status }) => {
      if (status === 'disconnected') {
        clearAllSessionLocalModelPreferences()
      }
      const organizationId = useOrganizationStore.getState().getEffectiveOrganizationId()
      if (organizationId) {
        void useChatModelStore.getState().loadModels(organizationId)
      }
    })
  }, [isDetachedChat])

  // --- HTML5 DnD 生命周期探针 + Windows toast OLE 屏蔽---
  // App 级全局：拖拽可从任意面板发起，不能挂 hot-Space 作用域。
  useEffect(() => {
    if (isDetachedChat) return
    return installHtml5DnDLifecycleProbe()
  }, [isDetachedChat])

  // --- 前台会话 presence（仅主窗；detached IM/chat 绝不挂）---
  useChatSessionPresence({
    enabled: isAuthenticated && !isDetachedChat,
  })

  // --- Tracker 运行事件流（波次 4 Stage 2.5 一刀切：tracker_id wire 字段） ---
  const handleTrackerRunCompleted = useCallback((event: {
    tracker_id: string
    space_id?: string | null
    // Wave 6 charter §4.4：后端推 skill_key 让前端能"看产物 1 步可达"
    skill_key?: string | null
  }) => {
    void invalidateTrackerAfterTrigger(event.tracker_id, { spaceId: event.space_id })
    const task = useTrackerStore.getState().tasks.find((item) => item.id === event.tracker_id)
    const targetSpaceId = event.space_id ?? task?.space_id ?? undefined
    const wsId = useOrganizationStore.getState().selectedOrganization?.id
    SystemNotification.trackerCompleted({
      title: tTracker('toast.runCompleted', { defaultValue: 'Tracker 执行完成' }),
      body: tTracker('notification.trackerCompletedBody', { defaultValue: '点击查看本次执行结果。' }),
      trackerId: event.tracker_id,
      organizationId: wsId ?? undefined,
      spaceId: targetSpaceId || undefined,
      skillKey: event.skill_key ?? task?.skill_key ?? undefined,
    })
  }, [tTracker])

  // 注：Module F 修复后，用户主动取消走独立 tracker.run.cancelled event，不再混进 RUN_FAILED；
  // 这里不再需要 `if (event.status === 'cancelled') return` 兜底过滤。
  const handleTrackerRunFailed = useCallback((event: {
    tracker_id: string
    status: string
    error_summary?: string
    space_id?: string | null
    skill_key?: string | null
  }) => {
    void invalidateTrackerAfterTrigger(event.tracker_id, { spaceId: event.space_id })
    const task = useTrackerStore.getState().tasks.find((item) => item.id === event.tracker_id)
    const targetSpaceId = event.space_id ?? task?.space_id ?? undefined
    const wsId = useOrganizationStore.getState().selectedOrganization?.id
    SystemNotification.trackerFailed({
      title: tTracker('toast.runFailed', { defaultValue: 'Tracker 执行失败' }),
      body: event.error_summary || tTracker('notification.trackerFailedBody', { defaultValue: '点击查看失败原因。' }),
      trackerId: event.tracker_id,
      organizationId: wsId ?? undefined,
      spaceId: targetSpaceId || undefined,
      skillKey: event.skill_key ?? task?.skill_key ?? undefined,
    })
  }, [tTracker])

  const handleTrackerRunCancelled = useCallback((event: {
    tracker_id: string
    space_id?: string | null
  }) => {
    void invalidateTrackerAfterTrigger(event.tracker_id, { spaceId: event.space_id })
  }, [])

  const handleTrackerProgress = useCallback((event: {
    tracker_id: string
    run_id: string
    status: string
    space_id?: string | null
  }) => {
    if (!shouldRefreshSidebarOnProgress(event)) return
    void invalidateTrackerAfterTrigger(event.tracker_id, { spaceId: event.space_id })
  }, [])

  // Module F 决策 3：Tracker WS topic 按 Space 拆分，全局通知需要 fan-out
  // 订阅当前用户可访问的所有 Space。useSpaceStore 内部已经按权限加载
  // （Space 默认私有，列表只含自己拥有或有 SpaceMembership 的 Space）。
  // spaces 任意字段变化时 .map() 都会返回新数组引用；useShallow 按元素浅比较，
  // 避免 id 列表未变时触发 TrackerSpaceStreams 整树重渲染 → useGatewayTopic setStatus 风暴。
  const accessibleSpaceIds = useSpaceStore(
    useShallow(state => state.spaces.map(s => s.id)),
  )
  const trackerStreamEnabled = isAuthenticated
    && !!selectedOrganizationId
    && (!isDetachedChat || !hasMainWindowHost)
  const trackerHandlers = useMemo<
    Pick<UseTrackerEventStreamOptions, 'onProgress' | 'onRunCompleted' | 'onRunFailed' | 'onRunCancelled'>
  >(
    () => ({
      onProgress: handleTrackerProgress,
      onRunCompleted: handleTrackerRunCompleted,
      onRunFailed: handleTrackerRunFailed,
      onRunCancelled: handleTrackerRunCancelled,
    }),
    [
      handleTrackerProgress,
      handleTrackerRunCompleted,
      handleTrackerRunFailed,
      handleTrackerRunCancelled,
    ],
  )

  // --- 通知导航 ---
  useNotificationNavigator({ enabled: !isDetachedChat })

  useEffect(() => {
    if (isDetachedChat) return
    return initShownListener()
  }, [initShownListener, isDetachedChat])

  useEffect(() => {
    if (isDetachedChat) return
    setNotificationOrganizationScope(selectedOrganizationId)
  }, [
    isDetachedChat,
    selectedOrganizationId,
    setNotificationOrganizationScope,
  ])

  // --- 记忆「记=用」(TM-10 批 B)：预热 per-(user, organization) 记忆总开关缓存 ---
  // local 注入热路径（sendMessageAction）+ 档案页记忆预览同步读
  // useMemoRecordStyleStore.isEnabled，不能每次发消息打 API。这里在登录后 /
  // 切 organization 时预拉一次 warm 缓存。不 gate isDetachedChat——每个渲染窗口各有
  // 一份 store，detached chat 窗口也会发消息，需各自 warm。未命中时 isEnabled
  // 默认 true（fail-open），不阻断首条消息。
  useEffect(() => {
    if (!isAuthenticated || !selectedOrganizationId) return
    void useMemoRecordStyleStore.getState().ensureLoaded(selectedOrganizationId)
  }, [isAuthenticated, selectedOrganizationId])

  // --- 临时标签 & 孤儿资源清理 & Tab Discarding ---
  useTemporaryTabListener()
  useOrphanResourceReconcile()
  useTabDiscardListener()

  // --- env 绑定变更触发 view 重建时弹友好 toast（detached chat 窗口不需要） ---
  usePartitionRebuildToast(!isDetachedChat)

  // --- 计费事件流 & React Query 自动刷新 ---
  useBillingEventStream({
    organizationId: selectedOrganizationId,
    enabled: isAuthenticated && !!selectedOrganizationId && (!isDetachedChat || !hasMainWindowHost),
  })
  useBillingRefreshListener()

  // --- 计费导航事件（由 billing toast CTA 按钮触发） ---
  useEffect(() => {
    if (isDetachedChat) return

    const BILLING_NAV_SECTIONS: Array<{ event: string; section: OrganizationSettingsSection }> = [
      // 组织侧钱包已并入「组织资料」(general) 页，不再有独立 wallet 菜单。
      { event: 'billing:navigate:wallet',     section: 'general' },
      { event: 'billing:navigate:membership', section: 'membership' },
      { event: 'billing:navigate:usage',      section: 'myUsage' },
      { event: 'billing:navigate:storage',    section: 'storage' },
      { event: 'billing:navigate:billing',    section: 'billing' },
    ]

    const handlers = BILLING_NAV_SECTIONS.map(({ event, section }) => {
      const handler = () => {
        useSettingsSpaceStore.getState().openSettings({ category: 'organization', section })
      }
      window.addEventListener(event, handler)
      return { event, handler }
    })

    return () => {
      handlers.forEach(({ event, handler }) => window.removeEventListener(event, handler))
    }
  }, [isDetachedChat])

  // --- API 层 500 服务端错误全局 Toast（5 秒防抖） ---
  useEffect(() => {
    let lastToastAt = 0
    const handler = () => {
      const now = Date.now()
      if (now - lastToastAt < 5000) return
      lastToastAt = now
      toast({
        title: tCommon('errors.serverError'),
        description: tCommon('errors.serverErrorDesc'),
        variant: 'destructive',
        duration: 5000,
      })
    }
    window.addEventListener('api:server-error', handler)
    return () => window.removeEventListener('api:server-error', handler)
  }, [tCommon])

  // --- API 服务层 billing 错误全局兜底（由 billing:api:error 事件派发） ---
  useEffect(() => {
    const handler = (e: Event) => {
      const { code, message, resourceType } = (
        e as CustomEvent<{
          code?: string
          message?: string
          resourceType?: QuotaResourceType
        }>
      ).detail ?? {}
      if (code && isBillingErrorCode(code)) {
        showBillingErrorToast(code, {
          description: typeof message === 'string' && message.trim() ? message : undefined,
          resourceType,
        })
      }
    }
    window.addEventListener('billing:api:error', handler)
    return () => window.removeEventListener('billing:api:error', handler)
  }, [])

  // --- Marketplace App 智能发现 ---
  useEffect(() => {
    if (isDetachedChat) return
    const handler = (_event: unknown, data: { appId: string; appName: string }) => {
      toast.info(
        tCommon('marketplace.discoveryToast', {
          appName: data.appName,
          defaultValue: '检测到你正在使用 {{appName}}，安装 {{appName}} 应用可获得 AI 协作能力',
        }),
        {
          action: (
            <ToastAction
              altText={tCommon('marketplace.goInstallAlt', { defaultValue: '前往安装' })}
              onClick={() => {
                useSettingsSpaceStore.getState().openSettings({ category: 'organization', section: 'appCatalog' })
              }}
            >
              {tCommon('marketplace.goInstall', { defaultValue: '前往安装' })}
            </ToastAction>
          ),
          duration: 10000,
        },
      )
    }
    window.electron?.ipcRenderer.on('marketplace:app-discovery', handler)
    return () => {
      window.electron?.ipcRenderer.removeListener?.('marketplace:app-discovery', handler)
    }
  }, [isDetachedChat, tCommon])

  // --- Personal Plugin Runtime：打开本地服务 URL 到现有 Browser ---
  useEffect(() => {
    if (isDetachedChat) return
    const handler = async (
      _event: unknown,
      data: { spaceId?: string; url?: string; pluginId?: string; title?: string },
    ) => {
      if (!data?.spaceId || !data?.url) return
      const focused = await focusExistingWebTabInSpace(data.spaceId, data.url)
      if (!focused) {
        const opened = await openWebTabInSpace(data.spaceId, data.url, {
          title: data.title || data.pluginId || 'Personal Plugin',
          allowPrivateHostNavigation: true,
        })
        if (!opened.ok) {
          console.warn('[AppGlobalEffects] personal-plugins open browser failed', opened.error)
        }
      }
    }
    window.electron?.ipcRenderer.on('personal-plugins:open-browser-url', handler)
    return () => {
      window.electron?.ipcRenderer.removeListener?.('personal-plugins:open-browser-url', handler)
    }
  }, [isDetachedChat])

  // --- 应用更新 ---
  useAppUpdater()

  // --- 全局快捷键 ---
  useEffect(() => {
    const FONT_SIZES: Array<UIFontSize> = ['small', 'default', 'large']

    const handleKeyDown = (e: KeyboardEvent) => {
      const hasMod = e.metaKey || e.ctrlKey
      if (!hasMod) return

      if (e.key === 'k') {
        // 统一搜索未 go-live：不抢 Cmd/Ctrl+K（避免空壳弹层 + 与终端清屏冲突）
        if (!GLOBAL_SEARCH_UI_ENABLED) return
        e.preventDefault()
        useUIStore.getState().toggleGlobalSearch()
        return
      }

      const key = e.key
      if (key === '=' || key === '+' || key === '-' || key === '0') {
        e.preventDefault()
        const store = useUIStore.getState()
        const cur = FONT_SIZES.indexOf(store.uiFontSize)
        if (key === '0') {
          store.setUIFontSize('default')
        } else if (key === '=' || key === '+') {
          if (cur < FONT_SIZES.length - 1) store.setUIFontSize(FONT_SIZES[cur + 1])
        } else {
          if (cur > 0) store.setUIFontSize(FONT_SIZES[cur - 1])
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // --- 窗口焦点恢复：刷 Space +  已加载会话列表 REST reconcile（30s 节流）---
  useEffect(() => {
    if (isDetachedChat || !isAuthenticated) return

    let lastRefresh = 0
    const THROTTLE_MS = 30_000

    const handleFocus = () => {
      const now = Date.now()
      if (now - lastRefresh < THROTTLE_MS) return
      lastRefresh = now

      const organizationId = useOrganizationStore.getState().selectedOrganization?.id
      if (!organizationId) return

      useSpaceStore.getState().loadSpaces(organizationId)
      void import('@/stores/chat/session/reconcileLoadedChatSessionLists').then(
        ({ reconcileLoadedChatSessionLists }) =>
          reconcileLoadedChatSessionLists(organizationId),
      )
    }

    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [isDetachedChat, isAuthenticated])

  // --- #20 审批偏好跨设备同步 ---
  useEffect(() => {
    if (!isAuthenticated || isDetachedChat) return

    window.tabtin?.sandbox?.syncApprovalPreferences?.().catch(() => {})

    let listener: ((envelope: any) => void) | null = null
    let gateway: any = null

    const setup = async () => {
      try {
        const { getChatClient } = await import('@/services/chatApi')
        gateway = getChatClient().getGateway()
        listener = (envelope: any) => {
          if (envelope?.type !== 'approval_preferences_changed') return
          // SIA-4：后端 build_envelope(..., {"data": preferences}) 使信封为
          // {payload:{data:preferences}}，旧 `data ?? payload` 会取到多包一层的
          // {data:preferences} 喂给 syncFromRemote → 实时同步 no-op。先剥 payload.data。
          const preferences = unwrapApprovalPreferences(envelope)
          if (preferences) {
            window.tabtin?.sandbox?.notifyRemoteApprovalPreferencesChanged?.(preferences)
          }
        }
        gateway.addListener(listener)
      } catch {
        // Gateway not ready yet
      }
    }
    void setup()

    return () => {
      if (listener && gateway) {
        try { gateway.removeListener(listener) } catch { /* ignore */ }
      }
    }
  }, [isAuthenticated, isDetachedChat])

  // --- IA Phase 2 个人偏好跨设备同步（theme/fontSize/colorScheme/voiceHotwords/resourceOpenPrefs）---
  // 与审批偏好同构（范式 B）：登录 / 启动恢复拉取一次 + 订阅 WS 回灌。
  // notificationPrefs 由主进程单独消费（见通知服务），不在此 effect 处理。
  useEffect(() => {
    if (!isAuthenticated || isDetachedChat) return

    // renderer 5 类（theme/fontSize/colorScheme/voiceHotwords/resourceOpenPrefs）
    void syncUISettingsFromServer()
    // notificationPrefs 在主进程：触发主进程拉取一次合并（范式 B）。
    void window.tabtin?.notification?.syncPrefsFromServer?.().catch(() => {})

    // cancelled 标志收口异步 setup 竞态：快速 auth 抖动时 cleanup 可能早于 await
    // 完成，此时 listener/gateway 还没赋值、cleanup 取不到无法移除；await 后再 addListener
    // 就会泄漏。setup 在 await 后先查 cancelled，已 cleanup 则直接返回不挂 listener。
    let cancelled = false
    let listener: ((envelope: any) => void) | null = null
    let gateway: any = null
    const setup = async () => {
      try {
        const { getChatClient } = await import('@/services/chatApi')
        if (cancelled) return
        gateway = getChatClient().getGateway()
        listener = (envelope: any) => {
          if (envelope?.type !== 'ui_settings_changed') return
          applyRemoteUISettingsFromEnvelope(envelope)
          // notificationPrefs 由主进程消费：取出该 namespace 信封转发给主进程回灌。
          const np = extractRemoteSettings(envelope).notificationPrefs
          if (np && typeof np.updatedAt === 'number') {
            window.tabtin?.notification?.notifyRemotePrefsChanged?.({ value: np.value, updatedAt: np.updatedAt })
          }
        }
        gateway.addListener(listener)
      } catch {
        // Gateway not ready yet
      }
    }
    void setup()

    return () => {
      cancelled = true
      if (listener && gateway) {
        try { gateway.removeListener(listener) } catch { /* ignore */ }
      }
    }
  }, [isAuthenticated, isDetachedChat])

  // --- streamingContent GC ---
  useEffect(() => {
    initStreamingContent({
      getStreamingSessions: () => new Set(getBusySessionIds()),
    })
    return streamingContent.startGC()
  }, [])

  // --- dev-only：app 级启用 TabDoc 数据流探针 ---
  // 把探针启用从「文档打开时」提前到 app 级，使 window.__tabdocProbe 常驻，
  // 无人值守验证 / 回归可经 tabdoc.open 自助打开文档（不再需要有人先手动打开）。
  // 生产为 no-op（bootstrapTabDocProbe 内部有 import.meta.env.DEV guard）。
  useEffect(() => {
    if (!import.meta.env.DEV || isDetachedChat) return
    bootstrapTabDocProbe()
  }, [isDetachedChat])

  // --- dev-only：app 级启用 TabData 交互数据流探针 ---
  // 与 TabDoc 探针同构：window.__tabdataProbe 常驻，无人值守验证 / 回归可经
  // tabdata.open 自助打开表（编辑器级 tabdata.editCell 由 DataGridAdapter 挂载时注册）。
  // 生产为 no-op（bootstrapTabDataProbe 内部有 import.meta.env.DEV guard）。
  useEffect(() => {
    if (!import.meta.env.DEV || isDetachedChat) return
    bootstrapTabDataProbe()
  }, [isDetachedChat])

  // --- dev-only：Agent 对话视口帧级探针（Phase 0）---
  // 暴露 window.__TABTIN_CHAT_VIEWPORT_PROBE__ 供 Electron E2E / CDP 采样；
  // 生产为 no-op（bootstrapConversationViewportProbe 内部有 DEV guard）。
  useEffect(() => {
    if (isDetachedChat) return
    bootstrapConversationViewportProbe()
  }, [isDetachedChat])

  // --- dev-only： 模拟异常终止 DONE（硬停 / 预算墙）---
  useEffect(() => {
    if (!import.meta.env.DEV || isDetachedChat) return
    bootstrapMockRunTerminationProbe()
  }, [isDetachedChat])

  // --- 退出守卫监听器（W2.5 T9）：响应 main 进程的 ⌘Q / 窗口关闭确认请求 ---
  useEffect(() => {
    if (isDetachedChat) return
    return setupExitGuardListener()
  }, [isDetachedChat])

  // --- Slide flush 监听器：常驻响应 main 进程的关窗 slide:flush-before-close，---
  // 未打开过 slide 时立即回执，避免 main 干等 4000ms 超时才关窗。
  useEffect(() => {
    if (isDetachedChat) return
    return setupSlideFlushListener()
  }, [isDetachedChat])

  // --- 插件初始化 & ResizeObserver 抑制 ---
  useEffect(() => {
    const cleanupPlugins = registerAllPlugins()
    fetchUploadConfig()
    retryPendingConfirms()

    const resizeObserverErrorHandler = (e: ErrorEvent) => {
      if (e.message === 'ResizeObserver loop completed with undelivered notifications.') {
        e.preventDefault()
        return true
      }
      return false
    }

    window.addEventListener('error', resizeObserverErrorHandler)

    return () => {
      window.removeEventListener('error', resizeObserverErrorHandler)
      cleanupPlugins()
    }
  }, [])

  // --- Overlay 检测 ---
  useEffect(() => {
    if (typeof document === 'undefined') return

    let pending = false
    let observer: MutationObserver | null = null

    const initTimer = setTimeout(() => {
      observer = new MutationObserver(() => {
        if (pending) return
        pending = true
        queueMicrotask(() => {
          pending = false
          syncNativeViewOverlayCountFromDom(document)
        })
      })

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      })

      syncNativeViewOverlayCountFromDom(document)
    }, 1000)

    return () => {
      clearTimeout(initTimer)
      observer?.disconnect()
    }
  }, [])

  return (
    <TrackerSpaceStreams
      spaceIds={accessibleSpaceIds}
      enabled={trackerStreamEnabled}
      handlers={trackerHandlers}
    />
  )
}
