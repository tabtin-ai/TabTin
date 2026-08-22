/**
 * deliverContextInjectToChat — 跨 App「发送给 Agent」统一投递
 *
 * 对话挂载时（有 activeScope）：写入当前 composer。
 * 对话收起 / ChatPanel 卸载（无 activeScope）：按当前草稿 / session 解析目标
 * scope（draft 标记优先于 prefetch 隐藏 session，见 ），写入后按既有
 * taskViewMode / 侧栏 API 恢复可见对话；无会话则进入与「新任务」同源的草稿态。
 *
 * 不依赖永久挂载 ChatPanel；失败必须 toast，成功在无可见 composer 时也要可感知。
 */

import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { getDraftComposerPresetScopeId } from '@components/chat/composer-presets/scope'
import { resolveNewTaskMainNavTab } from '@components/layout/primaryNavigation'
import {
  buildConversationDraftScopeKey,
  buildConversationSessionScopeKey,
} from '@components/layout/workspaceContextState'
import {
  navigateToNewTask,
  resolveNewTaskConversationTarget,
} from '@/services/newTaskDraftNavigation'
import { useAuthStore } from '@stores/useAuthStore'
import { useChatStore } from '@stores/chat/useChatStore'
import {
  useContextInjectionStore,
  type ContextInjectPayload,
} from '@stores/useContextInjectionStore'
import { useIMStore } from '@stores/useIMStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useUIStore } from '@stores/useUIStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('DeliverContextInject')

export type ContextInjectDeliveryTarget =
  | {
      ok: true
      mode: 'active-scope'
      composerScopeId: string
      tabScopeKey: string
    }
  | {
      ok: true
      mode: 'current-session'
      composerScopeId: string
      tabScopeKey: string
      spaceId: string | null
    }
  | {
      ok: true
      mode: 'current-draft'
      composerScopeId: string
      tabScopeKey: string
      spaceId: string
    }
  | {
      ok: true
      mode: 'new-task-draft'
      composerScopeId: string
      tabScopeKey: string
      spaceId: string
      isProjectNavActive: boolean
    }
  | { ok: false; reason: 'no-workspace' }

export type DeliverContextInjectResult =
  | { ok: true; mode: 'active-scope'; scopeId: string }
  | { ok: true; mode: 'current-session'; scopeId: string; tabScopeKey: string }
  | { ok: true; mode: 'current-draft'; scopeId: string; spaceId: string; tabScopeKey: string }
  | {
      ok: true
      mode: 'new-task-draft'
      spaceId: string
      composerScopeId: string
      tabScopeKey: string
    }
  | { ok: false; reason: 'no-workspace' }

function focusComposerSoon(): void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('[data-chat-input-textarea="true"]')?.focus()
  })
}

/**
 * 按既有 scope / session / 草稿指针解析投递目标，不引入新的状态源。
 */
export function resolveContextInjectDeliveryTarget(): ContextInjectDeliveryTarget {
  const activeScopeId = useContextInjectionStore.getState().activeScopeId
  if (activeScopeId) {
    const tabScopeKey = activeScopeId.startsWith('__draft__:')
      ? buildConversationDraftScopeKey(activeScopeId.slice('__draft__:'.length))
      : buildConversationSessionScopeKey(activeScopeId)
    return {
      ok: true,
      mode: 'active-scope',
      composerScopeId: activeScopeId,
      tabScopeKey,
    }
  }

  const conversationTarget = resolveNewTaskConversationTarget()
  const spaceId = conversationTarget.spaceId
  const chat = useChatStore.getState()

  // Prefetch会同时保留 draft 标记并写入隐藏 session 指针。
  // 若 draft 仍在，必须优先写 `__draft__:<spaceId>`，否则折叠后无 activeScope
  // 时会错投到预建 session，导致原草稿引用「消失」、app-focus 打不开 draft scope。
  if (spaceId && chat.draftSessionBySpaceId[spaceId]) {
    return {
      ok: true,
      mode: 'current-draft',
      composerScopeId: getDraftComposerPresetScopeId(spaceId),
      tabScopeKey: buildConversationDraftScopeKey(spaceId),
      spaceId,
    }
  }

  // 有明确工作空间时只认该工作空间的会话指针。全局 currentSessionId
  // 在切换工作空间的过渡帧里可能仍指向旧现场，优先它会把引用错投到别的任务。
  const sessionId = spaceId
    ? chat.currentSessionIdBySpaceId[spaceId] ?? null
    : chat.currentSessionId

  if (sessionId) {
    return {
      ok: true,
      mode: 'current-session',
      composerScopeId: sessionId,
      tabScopeKey: buildConversationSessionScopeKey(sessionId),
      spaceId,
    }
  }

  if (!spaceId) {
    return { ok: false, reason: 'no-workspace' }
  }

  return {
    ok: true,
    mode: 'new-task-draft',
    composerScopeId: getDraftComposerPresetScopeId(spaceId),
    tabScopeKey: buildConversationDraftScopeKey(spaceId),
    spaceId,
    isProjectNavActive: conversationTarget.isProjectNavActive,
  }
}

/**
 * 云文档 / 消息等域不挂 Agent ChatPanel（chatPanelEnabled=false）。
 * 注入成功后若仍停在这些域，用户只看到 toast、看不到引用——必须切回任务工作台。
 */
function isAgentChatWorkbenchTab(tab: string | null | undefined): boolean {
  return tab === 'agent'
}

/**
 * 进入可承载 Agent composer 的任务域（不重置草稿 / 不新建 session）。
 * 与 navigateToNewTask 的导航收口对齐，但保留已有 session / draft 引用。
 */
function ensureAgentChatWorkbenchForInject(input: {
  spaceId?: string | null
  isProjectNavActive?: boolean
}): void {
  const currentTab = useMainNavStore.getState().currentTab
  if (isAgentChatWorkbenchTab(currentTab)) return

  useSettingsSpaceStore.getState().closeSettings()
  const imStore = useIMStore.getState()
  imStore.closeIM()
  imStore.setCurrentConversation(null)

  if (input.spaceId) {
    useSpaceListStore.getState().activateSpace(input.spaceId)
  }

  useMainNavStore.getState().setCurrentTab(
    resolveNewTaskMainNavTab(Boolean(input.isProjectNavActive)),
  )

  const organizationId = useOrganizationStore.getState().selectedOrganization?.id ?? null
  const userId = useAuthStore.getState().user?.id ?? null
  if (organizationId && userId) {
    useSpaceViewPrefsStore.getState().setSidebarModeForOrganizationUser(
      organizationId,
      userId,
      'conversations',
    )
  }

  log.info('context inject left non-chat workbench', {
    fromTab: currentTab,
    spaceId: input.spaceId ?? null,
  })
}

/**
 * 恢复对话可见性：展开侧栏；app-focus 不再强切 split 打断布局，
 * 改为展开右下角胶囊面板（画布上的 App 原地保留）。
 */
function revealConversationForInject(tabScopeKey: string): void {
  useUIStore.getState().setChatSidePanelCollapsed(false)
  const prefs = useSpaceViewPrefsStore.getState()
  if (prefs.getTaskViewMode(tabScopeKey) === 'app-focus') {
    useUIStore.getState().setAppFocusChatOverlayOpen(tabScopeKey, true)
  }
}

function toastDeliverFailure(): void {
  toast({
    title: i18n.t('tab.menu.addToChatNoWorkspaceTitle', {
      ns: 'context',
      defaultValue: '无法加入对话',
    }),
    description: i18n.t('tab.menu.addToChatNoWorkspaceDesc', {
      ns: 'context',
      defaultValue: '找不到可用的工作空间，请先选择执行现场',
    }),
    variant: 'destructive',
  })
}

/**
 * 统一投递上下文引用到当前任务 / 草稿 composer。
 */
export function deliverContextInjectToChat(
  payload: ContextInjectPayload,
): DeliverContextInjectResult {
  const target = resolveContextInjectDeliveryTarget()
  if (!target.ok) {
    toastDeliverFailure()
    log.warn('context inject skipped: no workspace', {
      type: payload.type,
      labelLength: payload.label?.length ?? 0,
    })
    return { ok: false, reason: 'no-workspace' }
  }

  const injection = useContextInjectionStore.getState()
  const conversationTarget = resolveNewTaskConversationTarget()

  if (target.mode === 'active-scope') {
    injection.addInjectedPayloadToScope(target.composerScopeId, payload)
    // 云文档等无 ChatPanel 的域：即便已有 activeScope，也要切回任务域才能看见引用
    ensureAgentChatWorkbenchForInject({
      spaceId: conversationTarget.spaceId,
      isProjectNavActive: conversationTarget.isProjectNavActive,
    })
    revealConversationForInject(target.tabScopeKey)
    focusComposerSoon()
    log.info('context inject delivered to active scope', {
      mode: target.mode,
      scopeId: target.composerScopeId,
      type: payload.type,
      labelLength: payload.label?.length ?? 0,
    })
    return { ok: true, mode: 'active-scope', scopeId: target.composerScopeId }
  }

  if (target.mode === 'new-task-draft') {
    navigateToNewTask(target.spaceId, {
      isProjectNavActive: target.isProjectNavActive,
    })
  } else {
    ensureAgentChatWorkbenchForInject({
      spaceId: 'spaceId' in target ? target.spaceId : conversationTarget.spaceId,
      isProjectNavActive: conversationTarget.isProjectNavActive,
    })
  }

  injection.addInjectedPayloadToScope(target.composerScopeId, payload)
  injection.setActiveScope(target.composerScopeId)
  revealConversationForInject(target.tabScopeKey)
  focusComposerSoon()

  const successTitle = target.mode === 'new-task-draft'
    ? i18n.t('tab.menu.addToChatNewTaskSuccess', {
        ns: 'context',
        defaultValue: '已创建新任务并加入引用',
      })
    : i18n.t('tab.menu.addToChatSuccess', {
        ns: 'context',
        defaultValue: '已加入对话',
      })

  toast({
    title: successTitle,
    description: payload.label,
  })

  log.info('context inject delivered without active scope', {
    mode: target.mode,
    scopeId: target.composerScopeId,
    tabScopeKey: target.tabScopeKey,
    type: payload.type,
    labelLength: payload.label?.length ?? 0,
  })

  if (target.mode === 'current-session') {
    return {
      ok: true,
      mode: 'current-session',
      scopeId: target.composerScopeId,
      tabScopeKey: target.tabScopeKey,
    }
  }
  if (target.mode === 'current-draft') {
    return {
      ok: true,
      mode: 'current-draft',
      scopeId: target.composerScopeId,
      spaceId: target.spaceId,
      tabScopeKey: target.tabScopeKey,
    }
  }
  return {
    ok: true,
    mode: 'new-task-draft',
    spaceId: target.spaceId,
    composerScopeId: target.composerScopeId,
    tabScopeKey: target.tabScopeKey,
  }
}
