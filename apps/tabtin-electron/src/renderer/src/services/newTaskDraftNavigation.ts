/**
 * newTaskDraftNavigation — 「程序化进入新任务草稿态」共享编排
 *
 * 供多类调用方共用：
 * 1. 侧栏左上角「新任务」按钮
 * 2. 交接接管「由我继续」：跳新任务 + 挂交接会话附件卡
 * 3. 工作台浏览器注释/截图无对话兜底
 * 4. 工作台 TabData/TabDoc「发送到对话」无对话兜底
 *
 * 语义与侧栏「新任务」按钮一致：进入草稿 episode；后台 prefetch 预建隐藏
 * 真 session（ 单槽复用，保留欢迎态，不切全局 current）。
 *
 * 注意：欢迎态 composer 的 scope 由**全局** currentSessionId 解析，发首条消息前
 * 恒为 draft scope。选区引用 / 预填留在草稿 scope，由首发直接消费
 * （见  /  v2）。
 */

import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useMainNavStore } from '@stores/useMainNavStore'
import { useAppPageStore } from '@stores/useAppPageStore'
import { useIMStore } from '@stores/useIMStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useProjectWorkspaceSelectionStore } from '@components/layout/projectWorkspaceSelectionStore'
import {
  resolveNewTaskMainNavTab,
  resolveSelectedProjectSpace,
} from '@components/layout/primaryNavigation'
import { resetNewTaskDraftUi } from '@components/layout/resetNewTaskDraftUi'
import { invalidatePendingHubNavigation } from '@/services/agentMemoryNavigation'
import {
  ensureSpaceSelectedWithFeedback,
  type EnsureSpaceSelectedWithFeedbackOptions,
} from '@/services/spaceNavigation'
import { resolveDefaultExecutionWorkspaceId } from '@/utils/defaultExecutionSpace'
import { parseSpaceSelectionId } from '@tabtin/app-shell'
import { ensureLocalWorkspaceForOrganization } from '@components/sidebar/ensureLocalWorkspace'

export type NewTaskConversationTarget = {
  spaceId: string | null
  isProjectNavActive: boolean
}

/**
 * 解析「新任务」应落到的 conversation space，与左上角按钮同源：
 * Project 沉浸 → 当前 Project；否则 → 当前执行工作空间 / 默认个人工作空间。
 */
export function resolveNewTaskConversationTarget(): NewTaskConversationTarget {
  const organizationId = useOrganizationStore.getState().selectedOrganization?.id ?? null
  const spaces = useSpaceStore.getState().spaces
  // Project 沉浸的 SSoT 是 app-page（openProjectPage 恒 setCurrentTab('agent')，
  // mainNavTab 永远不会是 'project'——旧判定是死分支）。
  const isProjectNavActive = useAppPageStore.getState().activePage === 'project'
  const selectedProjectId = useProjectWorkspaceSelectionStore.getState().selectedProjectId
  const selectedProjectSpace = resolveSelectedProjectSpace({
    isProjectNavActive,
    selectedProjectId,
    organizationId,
    spaces,
  })
  const projectConversationSpaceId = selectedProjectSpace?.id ?? null

  // 对齐 AppLayout 传给侧栏的 executionSpaceId（sidebarSpaceContext?.id）
  const executionSpaceId = useSpaceStore.getState().selectedSpace?.id
    ?? (() => {
      const selectionId = useSpaceListStore.getState().selectedSpaceId
      if (!selectionId) return null
      const { kind, rawId } = parseSpaceSelectionId(selectionId)
      return (kind === 'workspace' || kind === 'team') && rawId ? rawId : null
    })()

  const lastUsedWorkspaceId = useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId(organizationId)
  const defaultPersonalWorkspaceId = resolveDefaultExecutionWorkspaceId(
    organizationId,
    spaces,
    lastUsedWorkspaceId,
  )

  return {
    spaceId: projectConversationSpaceId ?? executionSpaceId ?? defaultPersonalWorkspaceId,
    isProjectNavActive,
  }
}

/**
 * 解析「新任务」应落到的个人工作空间（与  / 交接接管旧调用同源）。
 * Project 沉浸时回退个人默认，不把 Project space 当成「个人工作空间」。
 */
export function resolvePersonalNewTaskSpaceId(): string | null {
  const { spaceId, isProjectNavActive } = resolveNewTaskConversationTarget()
  if (isProjectNavActive) {
    const organizationId = useOrganizationStore.getState().selectedOrganization?.id ?? null
    const spaces = useSpaceStore.getState().spaces
    const lastUsedWorkspaceId = useSpaceViewPrefsStore.getState().getLastUsedWorkspaceId(organizationId)
    const selectionId = useSpaceListStore.getState().selectedSpaceId
    if (selectionId) {
      const { kind, rawId } = parseSpaceSelectionId(selectionId)
      if (kind === 'workspace' && rawId) {
        const hit = spaces.find((space) => (
          space.id === rawId
          && !space.is_archived
          && space.type !== 'team_space'
          && (!organizationId || space.organization_id === organizationId)
        ))
        if (hit) return hit.id
      }
    }
    return resolveDefaultExecutionWorkspaceId(organizationId, spaces, lastUsedWorkspaceId)
  }
  return spaceId
}

/** 共享任务打开前恢复重新入组后暂时缺失的个人 Workspace。 */
export async function ensurePersonalNewTaskSpaceId(
  organizationId?: string | null,
): Promise<string | null> {
  let spaceId = resolvePersonalNewTaskSpaceId()

  if (!spaceId) {
    const targetOrganizationId = organizationId
      ?? useOrganizationStore.getState().selectedOrganization?.id
      ?? null
    if (!targetOrganizationId) return null

    await ensureLocalWorkspaceForOrganization(targetOrganizationId, { force: true })
    spaceId = resolvePersonalNewTaskSpaceId()
  }

  if (!spaceId) return null
  const opened = await ensureSpaceSelectedWithFeedback(spaceId, {
    ...(organizationId ? { organizationId } : {}),
  })
  return opened ? spaceId : null
}

export type NavigateToNewTaskOptions = {
  /** 与侧栏「新任务」一致：Project 沉浸时保持 project 主导航 */
  isProjectNavActive?: boolean
  /** ChatPanel 执行现场；与 spaceId（host）不同时一并清空指针 */
  executionWorkspaceId?: string | null
}

/** 程序化进入「新任务」草稿态（与侧栏新任务按钮同序列，另收口 IM / 设置面板）。 */
export function navigateToNewTask(
  spaceId: string,
  options?: NavigateToNewTaskOptions,
): void {
  useSettingsSpaceStore.getState().closeSettings()
  // 从全屏 App 页（AI分身/技能库/自动化等）触发时必须关页，否则 workbenchMode
  // 停在 'app-page'，草稿开了主区却没切过去；Project 沉浸调用方显式要求保持
  // project 上下文时除外。
  // 同步作废尚未完成的 openAppPageNavigation，避免晚到 then() 盖回全屏页。
  if (!options?.isProjectNavActive) {
    invalidatePendingHubNavigation()
    useAppPageStore.getState().closeAppPage()
  }

  const imStore = useIMStore.getState()
  imStore.closeIM()
  imStore.setCurrentConversation(null)

  useSpaceListStore.getState().activateSpace(spaceId)
  const draftScopeKey = `conversation:draft:${spaceId}`
  resetNewTaskDraftUi(spaceId)
  // 清掉「执行于」草稿覆盖，避免注入到 A、ChatPanel 却读 B 导致附件卡看不见
  useChatStore.getState().setDraftExecutionSpaceForWorkspace(draftScopeKey, null)
  useMainNavStore.getState().setCurrentTab(
    resolveNewTaskMainNavTab(Boolean(options?.isProjectNavActive)),
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

  useChatStore.getState().startDraftSessionForSpace(spaceId, true, {
    draftScopeKey,
    ...(options?.executionWorkspaceId
      ? { executionWorkspaceId: options.executionWorkspaceId }
      : {}),
  })
}

/**
 * 新建 Workspace 成功后的落地：先选中该工作空间，再进入「新任务」草稿态
 *（与侧栏点「新对话 / 新任务」同序列）。
 */
export async function openCreatedWorkspaceAsNewTask(
  spaceId: string,
  options?: EnsureSpaceSelectedWithFeedbackOptions,
): Promise<boolean> {
  const opened = await ensureSpaceSelectedWithFeedback(spaceId, options)
  if (!opened) return false
  navigateToNewTask(spaceId)
  return true
}

// ：watchDraftSessionProvision / rehomeDraftScopeToSession 已删除——
// 草稿态没有「prefetch 落地」时刻，session 只会因首发建立（此时草稿引用 / 预填
// 已被发送消费），不存在需要迁 scope 的窗口。
