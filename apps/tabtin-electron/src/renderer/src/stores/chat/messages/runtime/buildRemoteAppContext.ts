/**
 * 远程 gateway `app_context` 构造：与 local IPC Focus 语义对齐，
 * 经 Django `normalize_focus_snapshot` 后可解码为 Host Focus。
 */
import {
  FOCUS_SNAPSHOT_LIMITS,
  FocusSnapshotSchema,
  type FocusSnapshot,
} from '@tabtin/contracts/agent'
import type { LocalAgentAppContext } from '@/services/localAgentClient'

export type RemoteAppContextReplyTo = {
  messageId: string
  preview: { role: 'user' | 'assistant' | 'system' | 'tool'; author?: string; text: string }
}

export type BuildRemoteAppContextPassthrough = {
  organizationId?: string
  spaceId?: string
  tabScopeKey?: string | null
  displayMessage: string
  replyTo?: RemoteAppContextReplyTo
  userTimeZone?: string | null
}

/**
 * 运行时裁剪 Focus 字段：成功则用契约形状；失败时 fail-closed 丢掉
 * 可能含正文的 appMeta / 超限 openTabs，保留标量身份字段。
 */
function sanitizeFocusSnapshot(candidate: FocusSnapshot): FocusSnapshot {
  const parsed = FocusSnapshotSchema.safeParse(candidate)
  if (parsed.success) return parsed.data

  const withoutRisky: FocusSnapshot = {
    ...candidate,
    appMeta: null,
    openTabs: Array.isArray(candidate.openTabs)
      ? candidate.openTabs.slice(0, FOCUS_SNAPSHOT_LIMITS.MAX_OPEN_TABS)
      : null,
  }
  const retry = FocusSnapshotSchema.safeParse(withoutRisky)
  if (retry.success) return retry.data

  return FocusSnapshotSchema.parse({
    appType: typeof candidate.appType === 'string' ? candidate.appType : null,
    spaceId: typeof candidate.spaceId === 'string' ? candidate.spaceId : null,
    userTimeZone: typeof candidate.userTimeZone === 'string' ? candidate.userTimeZone : null,
    appMeta: null,
    openTabs: null,
    workspaceMode: null,
  })
}

/**
 * 构造远程 gateway `app_context`：
 * - Focus 用共享 FocusSnapshot camelCase（与 local IPC / Django normalizer 对齐）
 * - 另附 Django ChatService 仍需要的 flat / 透传键
 * - 不整包 spread LocalAgentAppContext，避免 host-only / 危险字段泄漏
 */
export function buildRemoteAppContext(
  cached: LocalAgentAppContext | null | undefined,
  passthrough: BuildRemoteAppContextPassthrough,
): Record<string, unknown> {
  const resolvedSpaceId = passthrough.spaceId ?? cached?.spaceId ?? null
  const resolvedTz =
    passthrough.userTimeZone
    ?? cached?.userTimeZone
    ?? (typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : null)

  // P1-7：chat 视觉 Focus 不夹带资源 openTabs / appMeta；执行锚点不走此投影。
  const visualAppType = cached?.appType ?? null
  const isChatVisualFocus = visualAppType === 'chat'
  const focus = sanitizeFocusSnapshot({
    appType: visualAppType,
    appMeta: isChatVisualFocus ? null : (cached?.appMeta ?? null),
    openTabs: isChatVisualFocus ? [] : (cached?.openTabs ?? null),
    spaceId: resolvedSpaceId,
    userTimeZone: resolvedTz,
    workspaceMode: cached?.workspaceMode ?? null,
  })

  const appContext: Record<string, unknown> = {
    appType: focus.appType ?? null,
    appMeta: focus.appMeta ?? null,
    openTabs: focus.openTabs ?? null,
    spaceId: focus.spaceId ?? null,
    userTimeZone: focus.userTimeZone ?? null,
  }
  if (focus.workspaceMode != null) {
    appContext.workspaceMode = focus.workspaceMode
  }

  if (passthrough.organizationId) {
    appContext.current_organization_id = passthrough.organizationId
  }
  if (resolvedSpaceId) {
    appContext.current_space_id = resolvedSpaceId
  }
  if (passthrough.tabScopeKey) {
    appContext._invoked_from = passthrough.tabScopeKey
  }
  appContext.display_message = passthrough.displayMessage
  if (passthrough.replyTo) {
    appContext.reply_to_message_id = passthrough.replyTo.messageId
    appContext.reply_to_preview = passthrough.replyTo.preview
  }

  return appContext
}
