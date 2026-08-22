/**
 * notificationNavigation — 通知跳转纯函数模块
 *
 * 从 useNotificationNavigator 提取的导航逻辑，
 * 可被 Hook、Store、组件直接调用，不依赖 React hook。
 */

import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import type { NotificationNavigateTarget } from '@services/notificationApi'
import { useNotificationStore } from '@stores/useNotificationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useWorkbenchSurfaceStore } from '@stores/useWorkbenchSurfaceStore'
import { useTabDocCommentRevealStore } from '@stores/useTabDocCommentRevealStore'
import { openSharedResourceTab } from '@/services/openSharedResource'
import {
  openResourceTabGuarded,
  openTableTabGuarded,
} from '@/components/context-space/restore/openResourceMembershipGuard'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useIMStore } from '@stores/useIMStore'
import { useUIStore } from '@stores/useUIStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { getConversation } from '@/services/tabchatApi'
import { getConversationNavigationKind, resolveSessionScopeId } from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { runWithAgentContextSwitchGuard } from '@/services/agentContextSwitchGuard'
import {
  buildDesktopScopeKey,
  buildImConversationScopeKey,
} from '@components/layout/workspaceContextState'
import { ensureSpaceSelectedWithFeedback } from './spaceNavigation'
import { enterChatSession } from './chatSessionNavigation'
import { openProjectTaskChatSession } from './openProjectTaskChatSession'
import { enterTeamSpaceProject } from '@components/layout/project/teamSpaceProjectNavigation'
import { sortConversations } from '@/lib/imFormat'
import { getResourceIdEnvelopeKey } from './manifestResourceIdMap'
import { createLogger } from '@/utils/logger'

const log = createLogger('NotificationNav')

/**
 * Wave 4 (PRD §五块 5): TabData 容器对 tab id 编码;复用 ``buildTableKey`` 的语义,
 * 这里直接用 store 的 ``openTableTab`` API,无需重复编码逻辑。
 */

const NAVIGATE_TIMEOUT_MS = 10_000

export function findSpaceIdForSession(
  sessionsBySpaceId: Record<
    string,
    Array<{ id: string; space_id?: string | null; workspace_id?: string | null }>
  >,
  sessionId: string,
): string | undefined {
  for (const [asId, sessions] of Object.entries(sessionsBySpaceId)) {
    if (sessions?.some(s => s.id === sessionId)) {
      return asId
    }
  }
  return undefined
}

let navigating = false

/** @internal test-only — reset module-level lock between test cases */
export function _resetNavigatingForTest(): void { navigating = false }

function getNotificationSpaceNotFoundMessage(): string {
  return i18n.t('settings:notification.navigateSpaceNotFound', {
    defaultValue: '该工作空间已不可访问，可能是私有、无权限、已归档或已删除',
  })
}

function getNotificationNavigateFailedMessage(): string {
  return i18n.t('settings:notification.navigateFailed', {
    defaultValue: '通知跳转失败',
  })
}

function getNotificationSessionDeletedMessage(): string {
  return i18n.t('settings:notification.navigateSessionDeleted', {
    defaultValue: '该对话已被删除，无法跳转',
  })
}

/**
 * 确保切到指定 organization（deep link / 通知跳转前置步骤）。
 *
 * - organizationId 缺失 / 已是当前 → `ready`
 * - 列表中找不到 → `missing`（调用方应 toast「组织不存在」）
 * - 用户在 Agent 忙碌确认框点取消 → `cancelled`（**不得**误报组织不存在，）
 */
export type EnsureOrganizationResult = 'ready' | 'missing' | 'cancelled'

export async function ensureOrganizationSelected(
  organizationId?: string,
): Promise<EnsureOrganizationResult> {
  if (!organizationId) return 'ready'

  const organizationStore = useOrganizationStore.getState()
  if (organizationStore.selectedOrganization?.id === organizationId) return 'ready'

  let targetOrganization = organizationStore.organizations.find((item) => item.id === organizationId)
  if (!targetOrganization) {
    await organizationStore.loadOrganizations()
    targetOrganization = useOrganizationStore.getState().organizations.find((item) => item.id === organizationId)
  }
  if (!targetOrganization) return 'missing'

  const completed = await runWithAgentContextSwitchGuard(
    'organization',
    () => useOrganizationStore.getState().selectOrganization(targetOrganization),
  )
  if (!completed) return 'cancelled'
  if (useOrganizationStore.getState().selectedOrganization?.id !== organizationId) {
    return 'missing'
  }
  return 'ready'
}

/**
 * 通知 / deep link 跳转专用 space 切换：失败时弹 destructive toast。
 *
 * 与 `ensureSpaceSelectedWithFeedback` 的区别仅在于 toast 文案默认值——
 * 抽成独立 helper 以便 AppDeepLink / NotificationNavigation 共用。
 */
export async function ensureNotificationSpaceSelected(
  spaceId: string,
  organizationId?: string,
): Promise<boolean> {
  return ensureSpaceSelectedWithFeedback(spaceId, {
    organizationId,
    failureToast: {
      title: getNotificationSpaceNotFoundMessage(),
      variant: 'destructive',
    },
  })
}

/**
 * 把 envelope artifactRef + appId → 最具体的产物 ID（charter §4.4 "看产物
 * 1 步可达"）。
 *
 * 实现策略（D1 manifest 驱动）：通过
 * `manifestResourceIdMap.getResourceIdEnvelopeKey(appId)` 反查 manifest
 * `agentIntegration.contextFields[].isResourceId=true` 字段；新 App 加 manifest
 * 即被自动识别，本函数零 PR 维护成本。
 *
 * tabcode 编码特例（base64 codePath）保留：codePath → btoa(codePath) 是
 * tabcode handler 内部 ID 编码约定（与 openCodeProject 一致），不属 manifest
 * schema 范围。RFC §11.2.2 长期治理项：迁到 tabcode handler 自身提供的 helper。
 *
 * 返回:
 *   - resourceId: 用于 openResourceTab.id(tabKey 据此区分,多产物 = 多 tab)
 *   - codePath:   仅 tabcode + 命中 codePath 时返回,navigator 写入 meta.path
 *
 * 全部缺失 → resourceId = appId（兜底跳 app 主面板）
 */
function resolveResourceIdFromArtifact(
  appId: string,
  artifactRef: Record<string, unknown> | undefined,
): { resourceId: string; codePath?: string } {
  if (!artifactRef || typeof artifactRef !== 'object') {
    return { resourceId: appId }
  }
  const envelopeKey = getResourceIdEnvelopeKey(appId)
  if (!envelopeKey) {
    // manifest 未声明 isResourceId — 兜底走通用 artifactId（与原 switch default 分支语义一致）
    const v = (artifactRef as Record<string, unknown>)['artifactId']
    return typeof v === 'string' && v.trim() ? { resourceId: v } : { resourceId: appId }
  }
  const v = (artifactRef as Record<string, unknown>)[envelopeKey]
  if (typeof v !== 'string' || !v.trim()) {
    return { resourceId: appId }
  }

  // tabcode 特例：codePath → base64(path)。是 tabcode handler 内部 ID 编码约定
  // （与 openCodeProject 一致），不属 manifest schema 范围；长期治理项 R-Long。
  if (appId === 'tabcode' && envelopeKey === 'codePath') {
    try {
      const id = btoa(unescape(encodeURIComponent(v)))
      return { resourceId: id, codePath: v }
    } catch {
      return { resourceId: appId }
    }
  }
  return { resourceId: v }
}

async function resolveNavigationSpaceId(targetSpaceId?: string, organizationId?: string): Promise<string | null> {
  if (targetSpaceId) {
    const didSelect = await ensureNotificationSpaceSelected(targetSpaceId, organizationId)
    if (!didSelect) return null
    useMainNavStore.getState().setCurrentTab('agent')
    return targetSpaceId
  }

  const currentSpaceId = useSpaceStore.getState().selectedSpace?.id
  if (!currentSpaceId) {
    toast.error(getNotificationSpaceNotFoundMessage())
    return null
  }

  useSpaceListStore.getState().activateSpace(currentSpaceId)
  useMainNavStore.getState().setCurrentTab('agent')
  return currentSpaceId
}

async function doNavigateToChatSession(
  sessionId: string,
  hintSpaceId?: string,
  options?: { messageId?: string; organizationId?: string },
): Promise<void> {
  const chatStore = useChatStore.getState()

  let spaceId = hintSpaceId
    || findSpaceIdForSession(chatStore.sessionsBySpaceId, sessionId)

  if (!spaceId) {
    const session = chatStore.sessions?.find((s: { id: string }) => s.id === sessionId) as
      | { id: string; space_id?: string | null; workspace_id?: string | null }
      | undefined
    spaceId = resolveSessionScopeId(session) ?? undefined
  }

  if (!spaceId) {
    toast.error(i18n.t('settings:notification.navigateSessionNotFound', { defaultValue: '无法定位该对话，可能已被删除' }))
    return
  }

  await enterChatSession(spaceId, sessionId, {
    organizationId: options?.organizationId,
    failureToast: {
      title: getNotificationSpaceNotFoundMessage(),
      variant: 'destructive',
    },
    sessionFailureMessage: getNotificationNavigateFailedMessage(),
    sessionNotFoundMessage: getNotificationSessionDeletedMessage(),
    verifySessionExists: true,
    ...(options?.messageId
      ? {
          messageId: options.messageId,
          highlightMessage: true,
          loadContextWindow: 20,
        }
      : {}),
  })
}

export async function navigateToChatSession(
  sessionId: string,
  hintSpaceId?: string,
  options?: { messageId?: string; organizationId?: string },
): Promise<void> {
  if (navigating) return
  navigating = true

  try {
    await Promise.race([
      doNavigateToChatSession(sessionId, hintSpaceId, options),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), NAVIGATE_TIMEOUT_MS)),
    ])
  } catch (err) {
    if (err instanceof Error && err.message === 'timeout') {
      toast.error(i18n.t('settings:notification.navigateTimeout', { defaultValue: '跳转超时，请重试' }))
    } else {
      throw err
    }
  } finally {
    navigating = false
  }
}

/**
 * 通知点进 IM 会话后，强制露出「消息」面板本身。
 *
 * selectSpaceById → openIM 只会切会话 / 切到消息 tab；若用户此前停在
 * 会话桌面 app-focus 或折叠了聊天栏，主画面仍可能是画布，
 * 看起来像「通知把我带到了别的地方」。这里补齐聊天聚焦现场。
 */
function revealImMessagePanel(conversationId: string): void {
  useIMStore.getState().openIM()
  useUIStore.getState().setChatSidePanelCollapsed(false)
  useSpaceViewPrefsStore.getState().setTaskViewModeForScope(
    buildImConversationScopeKey(conversationId),
    'chat-focus',
  )
}

/**
 * 外部共享资源默认写入 Organization + User 的桌面标签组。通知入口必须同时把
 * 前台切到同一个标签组；否则资源虽然已打开，用户仍停在 Cloud Docs / App Page /
 * conversation scope，视觉上就像按钮没有响应。
 */
function enterSharedResourceDesktop(organizationId: string): string {
  const userId = useAuthStore.getState().user?.id ?? null
  const tabScopeKey = buildDesktopScopeKey({ organizationId, userId })

  useSettingsSpaceStore.getState().closeSettings()
  useAppPageStore.getState().closeAppPage()
  const imStore = useIMStore.getState()
  imStore.closeIM()
  imStore.setCurrentConversation(null)
  useMainNavStore.getState().setCurrentTab('agent')
  if (userId) {
    useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser(
      organizationId,
      userId,
      'desktop',
    )
  }
  useWorkbenchSurfaceStore.getState().setLastActiveSurface(tabScopeKey, 'real_tab')

  return tabScopeKey
}

/**
 * 外部共享资源仍需要一个当前用户可见的 Space 作为工作台宿主。
 * 组织切换不会同步清空 Space store，因此这里只能复用目标组织内的 Space；
 * 若列表尚未水合，先定向加载目标组织，绝不能回退到旧组织的选中项。
 */
async function resolveSharedResourceHostSpace(organizationId: string) {
  const findInTargetOrganization = () => {
    const spaceStore = useSpaceStore.getState()
    const selectedSpace = spaceStore.selectedSpace
      ? spaceStore.spaces.find((space) => space.id === spaceStore.selectedSpace?.id)
      : null
    if (selectedSpace?.organization_id === organizationId) return selectedSpace
    return spaceStore.spaces.find((space) => space.organization_id === organizationId) ?? null
  }

  let hostSpace = findInTargetOrganization()
  if (hostSpace) return hostSpace

  await useSpaceStore.getState().loadSpaces(organizationId)
  hostSpace = findInTargetOrganization()
  return hostSpace
}

/**
 * 根据 NavigateTarget 执行跳转（统一入口）
 */
export async function navigateToTarget(target: NotificationNavigateTarget): Promise<void> {
  if (!target?.type) return
  if (!target?.id) return
  const organizationResult = await ensureOrganizationSelected(target.organizationId)
  if (organizationResult === 'cancelled') {
    // 用户主动取消「停止 Agent 再切组织」——保持原上下文，不误报失权
    return
  }
  if (organizationResult === 'missing') {
    toast.error(i18n.t('settings:notification.navigateOrganizationNotFound', {
      defaultValue: '目标组织不存在或无权限访问',
    }))
    return
  }

  // 通知跳转到 agent 对话 / Space 上下文时，若全屏设置页（「我的」tab）正打开，
  // 先关闭设置页再跳转，避免设置页遮挡跳转目标。
  if (target.type !== 'settings' && target.type !== 'notification-panel') {
    const settingsStore = useSettingsSpaceStore.getState()
    if (settingsStore.isOpen) {
      settingsStore.closeSettings()
    }
  }

  switch (target.type) {
    case 'chat-session': {
      try {
        if (target.projectId) {
          const organizationId = target.organizationId
            ?? useOrganizationStore.getState().selectedOrganization?.id
          if (!organizationId) {
            toast.error(getNotificationNavigateFailedMessage())
            break
          }
          // Project 会话有两套 scope：workspaceId 是执行宿主，projectId 才是
          // 用户正在协作的展示现场。先进入 Project，再由 Project 专用入口
          // pin/select 会话，避免退回执行 Workspace 丢失 Task rail 和草稿 scope。
          enterTeamSpaceProject(target.projectId)
          await openProjectTaskChatSession({
            projectId: target.projectId,
            organizationId,
            sessionId: target.id,
          })
          break
        }
        // 新协议的个人会话用 workspaceId；spaceId 仅是旧通知兼容兜底。
        // projectId 分支已在上面处理，绝不能误用 workspaceId 作为 Project UI scope。
        await navigateToChatSession(target.id, target.workspaceId || target.spaceId, {
          messageId: 'messageId' in target ? target.messageId : undefined,
          organizationId: target.organizationId,
        })
      } catch (err) {
        log.warn(`chat-session 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    case 'tracker': {
      // Tracker 模块波次 4 Stage 2 一刀切：legacy ``goal`` / ``agenda`` case 已删除。
      try {
        const spaceId = await resolveNavigationSpaceId(target.spaceId, target.organizationId)
        if (!spaceId) break

        if (target.sessionId) {
          await enterChatSession(spaceId, target.sessionId, {
            verifySessionExists: true,
            sessionFailureMessage: i18n.t('tabtracker:detail.openRunSessionFailed', {
              defaultValue: '打开自动化执行记录失败，请重试',
            }),
            initialScroll: 'first-message',
          })
        }

        // 标签桶已 scope 化：桶键用前台 scope key，meta.spaceId
        // 保留裸 spaceId（资源归属 / 鉴权语义不变）。下同。
        useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(spaceId), {
          type: 'tabtracker',
          id: target.id,
          title: i18n.t('tabtracker:appName', { defaultValue: 'Tracker' }),
          meta: {
            spaceId,
            taskId: target.id,
            ...('runId' in target && target.runId ? { runId: target.runId } : {}),
          },
        })
      } catch (err) {
        log.warn(`${target.type} 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    case 'im-conversation': {
      try {
        let conversation = useIMStore.getState().conversations.find((item) => item.id === target.id) ?? null
        if (!conversation) {
          conversation = await getConversation(target.id)
        }
        if (!useIMStore.getState().conversations.some((item) => item.id === conversation.id)) {
          if (typeof useIMStore.setState === 'function') {
            useIMStore.setState((state) => ({
              conversations: sortConversations([
                conversation,
                ...state.conversations.filter((item) => item.id !== conversation.id),
              ]),
            }))
          }
        }
        useSpaceListStore.getState().selectSpaceById(
          getConversationNavigationKind(conversation),
          target.id,
        )
        revealImMessagePanel(target.id)
      } catch (err) {
        log.warn(`im-conversation 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    case 'im-contacts': {
      useIMStore.getState().setImContactsTab(target.id)
      useIMStore.getState().setImSidebarView('contacts')
      useIMStore.getState().openIM()
      break
    }
    case 'extension': {
      try {
        const spaceId = await resolveNavigationSpaceId(target.spaceId, target.organizationId)
        if (!spaceId) break

        useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(spaceId), {
          type: target.id,
          id: target.id,
          title: target.id,
          meta: {
            spaceId,
            ...(target.route ? { route: target.route } : {}),
          },
        })
      } catch (err) {
        log.warn(`extension 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    case 'agentspace-app': {
      try {
        const spaceId = await resolveNavigationSpaceId(target.spaceId, target.organizationId)
        if (!spaceId) break

        // Wave 6 续作 P0-3 (charter §4.4 "看产物 1 步可达"):
        //   target.artifactRef 由后端 envelope 透传,navigator 把它放进 meta;
        //   各 app 容器(tabmemoHandler / tabdataHandler 等)在 renderPane 读取
        //   meta.artifactRef 决定跳哪个具体产物(memoId / recordIds / docId / …)。
        //   artifactRef 缺失 → fallback 到主面板(原行为)。
        //
        // Wave 6 二次续作 NEW-P0-1 (反思 14 极端复犯防线 / charter §4.4 "1 步可达"):
        //   一次续作只把 artifactRef 透到 meta,但 5 个 app handler 的 renderPane
        //   只读 ``item.id``——**最后一公里 0 消费,实际跳 app 主面板**。
        //   修方案 A(改 1 处而非 5 处):把 artifactRef 里最具体的产物 ID 抽出来
        //   作为 ``openResourceTab.id``,这样:
        //     - tabmemo:item.id = memoId → TabMemoPaneHost.resourceId 命中
        //     - tabdoc:item.id = docId → TabdocPanelApp.documentId 命中
        //     - tabslide:item.id = slideId → SlideEditorHost.slideId 命中
        //     - tabcode:item.id = btoa(codePath) + meta.path = codePath →
        //       TabCodePaneHost.rootPath 命中(沿用 openCodeProject 编码约定)
        //     - tabdata:有 record_ids 但缺 table_id 时退回主面板(charter v3+ 补)
        //   tabKey = `${type}:${id}` → 同 memo 多次点击复用同 tab(每个产物 1 个 tab,
        //   语义优于"app 1 个 tab 不区分产物")。
        //   artifactRef 同时仍保留在 meta 里,app 内部需要补充信息(如 record_ids
        //   高亮哪几行)时仍能读到。
        const artifactRef = (target as { artifactRef?: Record<string, unknown> }).artifactRef
        const { resourceId, codePath } = resolveResourceIdFromArtifact(target.id, artifactRef)
        const tabScopeKey = resolveForegroundTabScopeKey(spaceId)
        const openParams = {
          type: target.id,
          id: resourceId,
          title: target.id,
          meta: {
            spaceId,
            ...(target.route ? { route: target.route, notificationIntentKey: Date.now() } : {}),
            ...(artifactRef ? { artifactRef, notificationIntentKey: Date.now() } : {}),
            // tabcode 特殊:codePath → meta.path(TabCodePaneHost 从 meta.path 读 rootPath)
            ...(codePath ? { path: codePath } : {}),
          },
        }
        if (target.id === 'tabdoc') {
          openResourceTabGuarded(tabScopeKey, openParams, spaceId)
        } else {
          useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, openParams)
        }
      } catch (err) {
        log.warn(`agentspace-app 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    case 'notification-panel': {
      useNotificationStore.getState().setIsPanelOpen(true)
      break
    }
    case 'settings': {
      useSettingsSpaceStore.getState().openSettings(target.route || target.id)
      break
    }
    /**
     * Wave 4 (PRD §五块 5):resource_shared 通知导航。
     * - 已切换好 organization(navigateToTarget 入口);切换 space(若有)
     * - resource_type='doc' → 用 openResourceTab('tabdoc', docId) 打开文档 tab
     * - resource_type='table' → 用 openTableTab(spaceId, tableId) 打开表格 tab
     * 'removed' / 'auto_removed' action 不会到这里——resolver 已返回 undefined,
     * store.navigateToNotification 改用 toast 提示("你已无访问权限")。
     */
    case 'resource-shared': {
      const sharedResourceType = target.resourceType === 'table' ? 'table' : 'doc'
      const notificationIntentKey = Date.now()
      if (target.resourceType === 'doc' && target.threadId) {
        useTabDocCommentRevealStore.getState().requestCommentReveal(target.id, {
          threadId: target.threadId,
          ...(target.commentId ? { commentId: target.commentId } : {}),
        })
      }
      const resourceIntentMeta = target.resourceType === 'table' && target.recordId
        ? {
            recordId: target.recordId,
            ...(target.commentId ? { commentId: target.commentId } : {}),
            openComments: target.openComments === true,
            notificationIntentKey,
            recordFocusRecordId: target.recordId,
            recordFocusRequestId: `record-focus:${notificationIntentKey}:0`,
          }
        : undefined
      // Agent 私有化：协作者被分享的资源位于他人私有 workspace，该 Space 不在
      // 协作者的可见 Space 列表里。这种情况下不能走 ensureSpaceSelected（会失败并
      // 误报"已归档/删除"），而应走「分享给我」独立通道按资源 id 打开。
      // owner / 成员本来就能看到该 Space，仍走工作台内打开。
      const spaceVisibleToUser =
        !!target.spaceId &&
        useSpaceStore.getState().spaces.some((s) => s.id === target.spaceId)

      if (!spaceVisibleToUser) {
        // 协作者：资源在他人私有 workspace，按资源权限以独立 tab 在用户当前
        // 可访问的 Space 工作台里打开（不进入对方的 Space）。
        if (!target.organizationId) {
          toast.error(getNotificationNavigateFailedMessage())
          break
        }
        const hostSpace = await resolveSharedResourceHostSpace(target.organizationId)
        if (!hostSpace) {
          toast.error(getNotificationNavigateFailedMessage())
          break
        }
        const didSelectHostSpace = await ensureNotificationSpaceSelected(
          hostSpace.id,
          hostSpace.organization_id,
        )
        if (!didSelectHostSpace) break
        const tabScopeKey = enterSharedResourceDesktop(target.organizationId)
        openSharedResourceTab({
          hostSpaceId: hostSpace.id,
          resourceType: sharedResourceType,
          resourceId: target.id,
          resourceSpaceId: target.spaceId,
          organizationId: target.organizationId,
          title: target.resourceTitle || '',
          tabScopeKey,
          meta: resourceIntentMeta,
        })
        break
      }

      try {
        const spaceId = await resolveNavigationSpaceId(target.spaceId, target.organizationId)
        if (!spaceId) break

        const tabScopeKey = resolveForegroundTabScopeKey(spaceId)
        if (target.resourceType === 'doc') {
          openResourceTabGuarded(tabScopeKey, {
            type: 'tabdoc',
            id: target.id,
            title: target.resourceTitle || '',
            meta: { spaceId },
          }, spaceId)
        } else if (target.resourceType === 'table') {
          openTableTabGuarded(tabScopeKey, target.id, {
            refreshSpaceId: spaceId,
            meta: resourceIntentMeta,
          })
        }
      } catch (err) {
        log.warn(`resource-shared 跳转失败 id=${target.id}:`, err)
        toast.error(getNotificationNavigateFailedMessage())
      }
      break
    }
    default:
      break
  }
}
