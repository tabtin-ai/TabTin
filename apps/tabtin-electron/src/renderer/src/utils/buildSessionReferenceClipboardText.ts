import type { ChatSession } from '@tabtin/chat-client'
import { buildConversationReferenceSection } from '@tabtin/agent-prompt'
import { resolveDeviceTimeZone } from './deviceTimeZone'

export interface SessionReferenceContext {
  spaceId: string
  organizationId: string
  spaceName?: string
  organizationName?: string
}

interface SpacePathCacheEntry {
  /** ：硬切新布局，dataRoot + userId 均必须存在才拼归档路径，不再回落 legacy platformDataRoot。 */
  dataRoot?: string
  userId?: string
  workspaceRoot?: string
}

/** per (organizationId, spaceId) 缓存，避免复制时 await IPC 导致剪贴板权限丢失 */
const spacePathCache = new Map<string, SpacePathCacheEntry>()

function cacheKey(organizationId: string, spaceId: string): string {
  return `${organizationId}:${spaceId}`
}

function joinPosix(...segments: string[]): string {
  return segments.filter(Boolean).join('/').replace(/\/+/g, '/')
}

function resolveArchivePaths(
  cached: SpacePathCacheEntry,
  organizationId: string,
  spaceId: string,
): { archiveDir: string; toolLogsDir: string } | undefined {
  // ：新布局 users/{userId}/organizations/{org}/workspaces/{space}/conversations/…
  // 硬切——dataRoot + userId + orgId + workspaceId 缺一不可，禁止拼 `_unscoped`。
  if (
    !cached.dataRoot ||
    !cached.userId ||
    !organizationId ||
    !spaceId
  ) {
    return undefined
  }
  const conversationsRoot = joinPosix(
    cached.dataRoot,
    'users',
    cached.userId,
    'organizations',
    organizationId,
    'workspaces',
    spaceId,
    'conversations',
  )
  return {
    archiveDir: joinPosix(conversationsRoot, 'sessions'),
    toolLogsDir: joinPosix(conversationsRoot, 'tool-logs'),
  }
}

/** 后台预热路径缓存（列表 mount / 打开菜单时调用，勿在复制点击里 await） */
export function warmSpacePathCache(spaceId: string, organizationId: string): void {
  // ：缺段预热无意义（拼路径也会拒绝），直接跳过。
  if (!spaceId || !organizationId) return
  const key = cacheKey(organizationId, spaceId)
  if (spacePathCache.has(key)) return

  const ensure = window.tabtin?.fileSystem?.ensureSpaceSandbox
  if (!ensure) return

  void ensure(spaceId, organizationId).then((result) => {
    if (result?.success && result.dataRoot && result.userId) {
      spacePathCache.set(key, {
        dataRoot: result.dataRoot,
        userId: result.userId,
        workspaceRoot: result.path,
      })
    }
  }).catch(() => {
    // 预热失败不阻断复制；build 会走无 archive 路径的 fallback
  })
}

/**
 * 同步构建剪贴板文本 —— 必须在用户点击事件的同步栈里完成，
 * 随后立刻调用 navigator.clipboard.writeText（不可先 await 再写剪贴板）。
 */
export function buildSessionReferenceClipboardText(
  session: ChatSession,
  ctx: SessionReferenceContext,
): string {
  const cached = spacePathCache.get(cacheKey(ctx.organizationId, ctx.spaceId))
  const archivePaths = cached
    ? resolveArchivePaths(cached, ctx.organizationId, ctx.spaceId)
    : undefined

  return buildConversationReferenceSection({
    // §17.6 D4：ConversationReferenceInput.sessionId → threadId（业务对话 thread）。
    threadId: session.id,
    title: session.title,
    preview: session.last_message_preview,
    organizationId: ctx.organizationId,
    organizationName: ctx.organizationName,
    spaceId: ctx.spaceId,
    spaceName: ctx.spaceName,
    workspaceRoot: cached?.workspaceRoot,
    archiveDir: archivePaths?.archiveDir,
    toolLogsDir: archivePaths?.toolLogsDir,
    lastMessageAt: session.last_message_at,
    messageCount: session.message_count,
    createdAt: session.created_at,
    // 用户设备时区 —— 让「最后活动 / 创建时间」按本地+offset 渲染，而非裸 UTC。
    timeZone: resolveDeviceTimeZone(),
  })
}
