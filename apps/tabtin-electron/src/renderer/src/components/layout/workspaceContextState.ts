import type { SidebarMode } from '@stores/useSpaceViewPrefsStore'
import { buildConversationDraftScopeKey } from '@/lib/conversationDraftScopeKey'
import type { WorkbenchMode } from './useShellLayoutState'
import { buildCloudDocsScopeKey } from './cloudDocsDomain'

export { buildConversationDraftScopeKey }

export type WorkspaceContextKind = 'desktop' | 'conversation' | 'im-conversation' | 'cloud-docs' | 'non-space'
export type WorkspaceChatPosition = 'middle' | 'right'

interface ResolveWorkspaceContextInput {
  workbenchMode: WorkbenchMode
  sidebarMode: SidebarMode
  organizationId?: string | null
  userId?: string | null
  executionSpaceId?: string | null
  sessionId?: string | null
  /**
   * 当前激活的 IM 会话 id（私信 / 群聊）。与 executionSpaceId（用户默认工作空间）
   * 同时具备时，im-chat 工作台按 `im:{conversationId}` 分标签组——每条会话一套独立桌面，
   * 对齐 Agent 任务的 `conversation:{sessionId}` 语义。
   */
  imConversationId?: string | null
}

export interface WorkspaceContextState {
  /**
   * Phase 1 bridge toward real state switching:
   * - desktop: shared Organization+User desktop tab group
   * - conversation: per-session task tab group
   * - im-conversation: per-IM-conversation tab group（会话桌面，执行现场 = 用户默认工作空间）
   * - non-space: existing non-Space workbench modes, kept out of the migration
   */
  kind: WorkspaceContextKind
  key: string
  desktopScopeKey: string | null
  sessionId: string | null
  /** im-conversation 态下承载 IM 会话 id；其余态为 null。 */
  imConversationId: string | null
  executionSpaceId: string | null
  legacySidebarMode: SidebarMode
  legacyChatPosition: WorkspaceChatPosition
}

/** 构造 IM 会话桌面的标签组 scope key。 */
export function buildImConversationScopeKey(conversationId: string): string {
  return `im:${conversationId}`
}

export function buildDesktopScopeKey(input: {
  organizationId?: string | null
  userId?: string | null
}): string {
  const organizationId = normalizeScopePart(input.organizationId, 'unknown-organization')
  const userId = normalizeScopePart(input.userId, 'anonymous')
  return `desktop:organization:${organizationId}:user:${userId}`
}

/** 已落库会话的 conversation scope key。 */
export function buildConversationSessionScopeKey(sessionId: string): string {
  return `conversation:${sessionId.trim()}`
}

export function resolveWorkspaceContextState(
  input: ResolveWorkspaceContextInput,
): WorkspaceContextState {
  const desktopScopeKey = buildDesktopScopeKey({
    organizationId: input.organizationId,
    userId: input.userId,
  })

  // IM 会话桌面：im-chat 模式 + 有会话 id + 有默认工作空间执行现场时，按会话分标签组。
  // 消息一级页（im）与缺工作空间的 im-chat 回退也固定 chat=middle，保证
  // [列表|聊天] 始终在左、画布/资产在右——选会话时列序不跳、shell rail 不换壳。
  if (input.workbenchMode === 'im-chat') {
    const imConversationId = input.imConversationId?.trim() || null
    const executionSpaceId = input.executionSpaceId?.trim() || null
    if (imConversationId && executionSpaceId) {
      return {
        kind: 'im-conversation',
        key: buildImConversationScopeKey(imConversationId),
        desktopScopeKey,
        sessionId: null,
        imConversationId,
        executionSpaceId,
        legacySidebarMode: input.sidebarMode,
        legacyChatPosition: 'middle',
      }
    }
  }

  if (input.workbenchMode === 'im' || input.workbenchMode === 'im-chat') {
    return {
      kind: 'non-space',
      key: `non-space:${input.workbenchMode}`,
      desktopScopeKey: null,
      sessionId: null,
      imConversationId: null,
      executionSpaceId: null,
      legacySidebarMode: input.sidebarMode,
      legacyChatPosition: 'middle',
    }
  }

  if (input.workbenchMode === 'cloud-docs') {
    const executionSpaceId = input.executionSpaceId?.trim() || null
    return {
      kind: 'cloud-docs',
      key: buildCloudDocsScopeKey({
        organizationId: input.organizationId,
        userId: input.userId,
      }),
      desktopScopeKey,
      sessionId: null,
      imConversationId: null,
      executionSpaceId,
      legacySidebarMode: input.sidebarMode,
      legacyChatPosition: 'right',
    }
  }

  if (input.workbenchMode !== 'space') {
    return {
      kind: 'non-space',
      key: `non-space:${input.workbenchMode}`,
      desktopScopeKey: null,
      sessionId: null,
      imConversationId: null,
      executionSpaceId: null,
      legacySidebarMode: input.sidebarMode,
      legacyChatPosition: 'right',
    }
  }

  if (input.sidebarMode === 'conversations') {
    const sessionId = input.sessionId?.trim() || null
    const executionSpaceId = input.executionSpaceId?.trim() || null
    return {
      kind: 'conversation',
      key: sessionId
        ? buildConversationSessionScopeKey(sessionId)
        : buildConversationDraftScopeKey(executionSpaceId),
      desktopScopeKey,
      sessionId,
      imConversationId: null,
      executionSpaceId,
      legacySidebarMode: input.sidebarMode,
      legacyChatPosition: 'middle',
    }
  }

  return {
    kind: 'desktop',
    key: desktopScopeKey,
    desktopScopeKey,
    sessionId: null,
    imConversationId: null,
    executionSpaceId: input.executionSpaceId?.trim() || null,
    legacySidebarMode: input.sidebarMode,
    legacyChatPosition: 'right',
  }
}

function normalizeScopePart(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

export function buildOrganizationUserPrefsKey(input: {
  organizationId?: string | null
  userId?: string | null
}): string {
  const organizationId = normalizeScopePart(input.organizationId, 'unknown-organization')
  const userId = normalizeScopePart(input.userId, 'anonymous')
  return `organization-user:${organizationId}:${userId}`
}

export function isConversationScopeKey(scopeKey: string | null | undefined): boolean {
  return Boolean(scopeKey?.startsWith('conversation:'))
}

export function isDesktopScopeKey(scopeKey: string | null | undefined): boolean {
  return Boolean(scopeKey?.startsWith('desktop:'))
}

export function isImConversationScopeKey(scopeKey: string | null | undefined): boolean {
  return Boolean(scopeKey?.startsWith('im:'))
}

/**
 * 当前 workspace 是否应读取画布折叠偏好。
 *
 * 多数 non-space 工作台（欢迎 / 设置 / 协作…）画布是主位，不走聊天聚焦折叠。
 * 例外：消息一级页与无工作空间的 im-chat——聊天在 shell IM rail，画布只是可折叠
 * 欢迎页；若这里强制展开，会与 rail 内「选择一个对话」空态并排双空状态。
 */
export function shouldReadCanvasCollapsedPreference(
  workspaceContext: Pick<WorkspaceContextState, 'kind' | 'key'>,
): boolean {
  if (
    workspaceContext.key === 'non-space:im' ||
    workspaceContext.key === 'non-space:im-chat'
  ) {
    return true
  }
  return workspaceContext.kind !== 'non-space'
}

/**
 * 隔离 scope：标签组按会话粒度隔离（conversation:{sessionId} / im:{conversationId}），
 * 需要把 per-space 运行载体（浏览器 / 终端）限定到显式 key，避免别的对话 / 桌面的 view 串入。
 * 桌面 scope 是共享池，不隔离。
 */
export function isIsolatedScopeKey(scopeKey: string | null | undefined): boolean {
  return isConversationScopeKey(scopeKey) || isImConversationScopeKey(scopeKey)
}

/** 从 im 会话 scope key 提取 conversationId；非 im scope 返回 null。 */
export function conversationIdFromImScopeKey(scopeKey: string | null | undefined): string | null {
  if (!scopeKey?.startsWith('im:')) return null
  const suffix = scopeKey.slice('im:'.length)
  return suffix || null
}

/**
 * Phase 5：按 workspace 容器解析当前 chat session 指针。
 * - conversation 态：session 即 workspace key 的一部分（conversation:{sessionId}）
 * - desktop 态：独立 auxiliary session，不与 conversation 指针共用
 */
export function resolveWorkspaceSessionId(input: {
  workspaceContext: WorkspaceContextState
  currentSessionIdByWorkspaceKey: Record<string, string | null>
  currentSessionIdBySpaceId: Record<string, string | null>
}): string | null {
  if (input.workspaceContext.kind === 'conversation') {
    return input.workspaceContext.sessionId
  }
  if (input.workspaceContext.kind === 'desktop') {
    return input.currentSessionIdByWorkspaceKey[input.workspaceContext.key] ?? null
  }
  return null
}

/** 从 conversation scope key 提取 sessionId；draft key 返回 null */
export function sessionIdFromConversationScopeKey(scopeKey: string | null | undefined): string | null {
  if (!scopeKey?.startsWith('conversation:')) return null
  const suffix = scopeKey.slice('conversation:'.length)
  if (!suffix || suffix.startsWith('draft:')) return null
  return suffix
}

/** TabCode 标签绑定的会话：conversation scope 优先，否则回退到 Space 当前会话。 */
export function resolveTabCodeSessionId(
  tabScopeKey: string | null | undefined,
  spaceSessionId: string | null | undefined,
): string | null {
  return sessionIdFromConversationScopeKey(tabScopeKey) ?? (spaceSessionId?.trim() || null)
}
