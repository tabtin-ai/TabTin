/**
 * 外部历史的特殊新对话展开：
 * - 首次：新建真会话并注入档案消息
 * - 再次：复用已绑定会话（禁止每次点都新建）
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { toast } from '@components/ui'
import { useChatStore } from '@stores/chat/useChatStore'
import { useWorkbenchSceneStore } from '@stores/useWorkbenchSceneStore'
import { cacheMessages } from '@stores/chat/messages/messageCache'
import { resolveAgentForSessionCreation } from '@stores/chat/session/actions/sessionLifecycleAction'
import { getChatClient } from '@/services/chatApi'
import { enterChatSession } from '@/services/chatSessionNavigation'
import { IMPORT_SOURCE_LABELS } from './useExternalImportDetection'
import { useExternalArchiveIndexStore } from './useExternalArchiveIndexStore'
import { rememberExternalOpenedSession } from './externalOpenedSessionRegistry'
import {
  buildExternalArchiveLlmBoundaryMessage,
  isExternalArchiveLlmBoundary,
} from './externalArchivePromptBoundary'
import {
  hasExternalArchiveLlmBoundary,
  hasExternalArchivePrefix,
  isExternalArchiveDecorationMessage,
  isExternalArchivePrefixMessage,
} from './mergeExternalArchiveMessages'

export { buildExternalArchiveLlmBoundaryMessage } from './externalArchivePromptBoundary'

interface ArchiveMessage {
  id: string
  role: 'user' | 'assistant'
  content_blocks: Array<{ type?: string; text?: string; thinking?: string; name?: string }>
  created_at: string
  model_name?: string | null
}

interface ArchiveMeta {
  source: string
  sourceSessionId: string
  title: string
  cwd: string | null
  workspaceId: string | null
  importedAt: string
  messageCount: number
  kind: 'external_archive'
  openedSessionId?: string | null
}

function blockText(blocks: ArchiveMessage['content_blocks']): string {
  const parts: string[] = []
  for (const b of blocks ?? []) {
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'thinking' && b.thinking) parts.push(`（思考）${b.thinking}`)
    else if (b.type === 'tool_use' && b.name) parts.push(`〔工具 ${b.name}〕`)
    else if (b.type === 'tool_result') parts.push('〔工具结果〕')
  }
  return parts.join('\n').trim()
}

/** 横幅/边界时间钉在外来正文之后，避免 timeline sort 把它们甩到 live 轮之后 */
function anchorAfterImported(imported: readonly ChatMessage[], offsetMs: number): string {
  let maxMs = 0
  for (const m of imported) {
    const t = Date.parse(m.created_at || '')
    if (Number.isFinite(t) && t > maxMs) maxMs = t
  }
  if (maxMs <= 0) maxMs = Date.now() - 60_000
  return new Date(maxMs + offsetMs).toISOString()
}

function buildPrefixMessage(meta: ArchiveMeta, createdAt?: string): ChatMessage {
  const sourceLabel = IMPORT_SOURCE_LABELS[meta.source] ?? meta.source
  const title = meta.title?.trim() || meta.sourceSessionId
  // 正文保留短摘要，供无 metadata 的降级渲染 / 搜索；UI 走结构化横幅
  const content = [
    '新任务',
    `来自 ${sourceLabel}`,
    title,
    meta.cwd ? `原目录：${meta.cwd}` : null,
    '上面是外来历史，当作上下文即可——从这里开始，都可以交给小 Tin 继续做',
  ].filter(Boolean).join(' · ')
  const now = createdAt || new Date().toISOString()
  return {
    id: `ext-prefix-${meta.sourceSessionId}`,
    role: 'system',
    content,
    created_at: now,
    content_blocks_json: [{ type: 'text', text: content }],
    metadata: {
      system_fact: 'external_archive_prefix',
      external_archive: true,
      source: meta.source,
      source_session_id: meta.sourceSessionId,
      title,
      cwd: meta.cwd,
    },
  } as ChatMessage
}

const isExternalArchivePrefix = isExternalArchivePrefixMessage

export function buildExternalArchiveChatMessages(
  meta: ArchiveMeta,
  messages: ArchiveMessage[],
): ChatMessage[] {
  const now = new Date().toISOString()
  const out: ChatMessage[] = []
  for (const m of messages) {
    const text = blockText(m.content_blocks)
    out.push({
      id: `ext-${m.id}`,
      role: m.role,
      content: text,
      created_at: m.created_at || now,
      content_blocks_json: (m.content_blocks?.length
        ? m.content_blocks
        : [{ type: 'text', text }]) as ChatMessage['content_blocks_json'],
      metadata: {
        external_archive: true,
        source: meta.source,
        source_session_id: meta.sourceSessionId,
      },
    } as ChatMessage)
  }
  // 外来正文 → UI 横幅 → LLM 边界；时间钉在最后一条外来正文之后，防 sort 甩尾
  out.push(
    buildPrefixMessage(meta, anchorAfterImported(out, 1)),
    buildExternalArchiveLlmBoundaryMessage(meta, anchorAfterImported(out, 2)),
  )
  return out
}

/** 内存 + IDB 落档；并抬本地 message_count，避免侧栏当空草稿滤掉 */
export async function persistExternalArchiveHydration(
  sessionId: string,
  hydrated: ChatMessage[],
  meta?: ArchiveMeta,
): Promise<void> {
  const store = useChatStore.getState()
  store.hydrateFromCache(sessionId, hydrated)
  store.updateSessionInCaches(sessionId, {
    message_count: Math.max(hydrated.length, 1),
  })
  rememberExternalOpenedSession(sessionId, meta ? {
    source: meta.source,
    sourceSessionId: meta.sourceSessionId,
    title: meta.title,
  } : undefined)
  await cacheMessages(sessionId, hydrated)
}

/**
 * 旧会话装饰布局纯计算（可单测）：
 * 1) 长文 system 前缀 → 结构化横幅
 * 2) 横幅若仍在队首，挪到外来消息之后
 * 3) 补上 LLM 可见的 external-archive 边界
 * 无需变更时返回 null。
 */
export function planExternalArchiveDecorationMigration(
  msgs: readonly ChatMessage[],
  meta: ArchiveMeta,
): ChatMessage[] | null {
  if (msgs.length === 0) return null

  let next = [...msgs]
  let changed = false

  const legacyIdx = next.findIndex(
    (m) => m.role === 'system' && (m.content || '').trim().startsWith('【外部历史'),
  )
  if (legacyIdx >= 0) {
    const metaOf = next[legacyIdx]?.metadata as Record<string, unknown> | null | undefined
    if (metaOf?.system_fact !== 'external_archive_prefix') {
      next[legacyIdx] = buildPrefixMessage(meta)
      changed = true
    }
  }

  const prefixIdx = next.findIndex(isExternalArchivePrefix)
  const imported = next.filter(
    (m) =>
      !isExternalArchivePrefix(m)
      && !isExternalArchiveLlmBoundary(m)
      && isExternalArchiveDecorationMessage(m),
  )
  const rest = next.filter((m) => !isExternalArchiveDecorationMessage(m))

  const hasBoundary = hasExternalArchiveLlmBoundary(next)
  const hasPrefix = hasExternalArchivePrefix(next)
  const lastImported = imported[imported.length - 1]
  const lastImportedIdx = lastImported
    ? next.findIndex((m) => m.id === lastImported.id)
    : -1
  const afterImport = lastImportedIdx >= 0
    ? next.slice(lastImportedIdx + 1, lastImportedIdx + 3)
    : []
  const decorationInPlace =
    imported.length > 0
    && afterImport[0] != null
    && isExternalArchivePrefix(afterImport[0])
    && afterImport[1] != null
    && isExternalArchiveLlmBoundary(afterImport[1])
  if (!decorationInPlace || !hasBoundary || !hasPrefix || prefixIdx === 0) {
    next = [
      ...imported,
      buildPrefixMessage(meta, anchorAfterImported(imported, 1)),
      buildExternalArchiveLlmBoundaryMessage(meta, anchorAfterImported(imported, 2)),
      ...rest,
    ]
    changed = true
  }

  return changed ? next : null
}

/**
 * 旧会话修复：见 {@link planExternalArchiveDecorationMigration}，有变更则写回 IDB。
 */
export function migrateLegacyPrefixIfNeeded(
  sessionId: string,
  meta: ArchiveMeta,
): void {
  const msgs = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  const next = planExternalArchiveDecorationMigration(msgs, meta)
  if (next) {
    void persistExternalArchiveHydration(sessionId, next, meta)
  }
}

function findSessionInWorkspace(workspaceId: string, sessionId: string): boolean {
  const store = useChatStore.getState()
  const inSpace = (store.sessionsBySpaceId[workspaceId] ?? []).some((s) => s.id === sessionId)
  if (inSpace) return true
  return Boolean(store.getSessionById?.(sessionId))
}

/**
 * 与侧栏点普通会话同口径：选中工作空间 → 前台工作台 → 进入会话。
 * 旧实现只 selectSession，跨工作空间首次展开时会话建了但界面不跳转。
 */
async function focusConversation(
  workspaceId: string,
  sessionId: string,
  organizationId: string,
): Promise<boolean> {
  const seq = await enterChatSession(workspaceId, sessionId, {
    organizationId,
    sessionFailureMessage: '打开外部历史对话失败，请重试',
  })
  if (seq <= 0) return false
  useWorkbenchSceneStore.getState().activateForegroundSpace(workspaceId)
  return true
}

async function bindOpenedSession(args: {
  organizationId: string
  source: string
  sourceSessionId: string
  sessionId: string
}): Promise<void> {
  try {
    await window.tabtin?.import?.bindOpenedSession?.(args)
    useExternalArchiveIndexStore.getState().bump()
  } catch {
    /* 绑定失败不阻断已打开的会话 */
  }
}

const SEED_SKIP_REASONS = new Set(['already_present', 'empty_archive'])

async function seedOpenedArchiveTranscript(args: {
  organizationId: string
  source: string
  sourceSessionId: string
  sessionId: string
  spaceId: string
}): Promise<void> {
  try {
    const result = await window.tabtin?.import?.seedSessionTranscript?.(args)
    if (!result) return
    if (result.seeded || SEED_SKIP_REASONS.has(result.reason ?? '')) return
    toast({
      title: '导入上文未能写入会话',
      description: '可以继续聊天，但模型可能暂时看不到导入的历史。请稍后重新打开该对话。',
      variant: 'destructive',
    })
  } catch {
    toast({
      title: '导入上文未能写入会话',
      description: '可以继续打开对话，但模型可能暂时看不到导入的历史。请稍后重试。',
      variant: 'destructive',
    })
  }
}

/**
 * 与「新建会话」同款：缺 agent_id 时走 resolveAgentForSessionCreation 补绑。
 * createSession 正常会带上身份；显式 create 撞上 in-flight 预建 / 旧数据时可能仍空。
 */
export async function ensureSessionAgentLikeNewChat(
  sessionId: string,
  workspaceId: string,
  organizationId: string,
): Promise<void> {
  const chat = useChatStore.getState()
  const session = chat.getSessionById?.(sessionId)
  if (session?.agent_id) return

  try {
    const agent = await resolveAgentForSessionCreation(workspaceId, organizationId)
    const previousAgentId = session?.agent_id
    chat.updateSessionInCaches(sessionId, { agent_id: agent.id })
    try {
      const updated = await getChatClient().sessions.update(sessionId, {
        agent_id: agent.id,
      })
      useChatStore.getState().updateSessionInCaches(sessionId, updated)
    } catch {
      useChatStore.getState().updateSessionInCaches(sessionId, {
        agent_id: previousAgentId,
      })
    }
  } catch {
    /* 补绑失败不阻断打开；选择器会显示未选中，用户可手动选 */
  }
}

export async function continueExternalArchiveChat(payload: {
  meta: ArchiveMeta
  messages: ArchiveMessage[]
  organizationId: string
}): Promise<{ sessionId: string; workspaceId: string; resumed: boolean } | null> {
  const workspaceId = payload.meta.workspaceId
  if (!workspaceId) {
    toast({
      title: '无法打开对话',
      description: '这条外部历史没有关联工作空间。',
      variant: 'destructive',
    })
    return null
  }
  if (payload.messages.length === 0) {
    toast({
      title: '无法打开对话',
      description: '此外部历史没有可注入的消息。',
      variant: 'destructive',
    })
    return null
  }

  const hydrated = buildExternalArchiveChatMessages(payload.meta, payload.messages)
  const existingId = payload.meta.openedSessionId?.trim() || null

  // 已展开过：回到同一会话，不再新建
  if (existingId && findSessionInWorkspace(workspaceId, existingId)) {
    const msgs = useChatStore.getState().messagesBySessionId[existingId] ?? []
    if (msgs.length === 0) {
      await persistExternalArchiveHydration(existingId, hydrated, payload.meta)
    } else {
      migrateLegacyPrefixIfNeeded(existingId, payload.meta)
      rememberExternalOpenedSession(existingId, {
        source: payload.meta.source,
        sourceSessionId: payload.meta.sourceSessionId,
        title: payload.meta.title,
      })
    }
    await ensureSessionAgentLikeNewChat(
      existingId,
      workspaceId,
      payload.organizationId,
    )
    const ok = await focusConversation(workspaceId, existingId, payload.organizationId)
    if (!ok) return null
    // 导航后若背景 sync 用空服务端盖掉了注入内容，补回
    const after = useChatStore.getState().messagesBySessionId[existingId] ?? []
    if (after.length < hydrated.length) {
      await persistExternalArchiveHydration(existingId, hydrated, payload.meta)
    }
    await seedOpenedArchiveTranscript({
      organizationId: payload.organizationId,
      source: payload.meta.source,
      sourceSessionId: payload.meta.sourceSessionId,
      sessionId: existingId,
      spaceId: workspaceId,
    })
    return { sessionId: existingId, workspaceId, resumed: true }
  }

  const chatStore = useChatStore.getState()
  await chatStore.createSession(
    workspaceId,
    payload.organizationId,
    undefined,
    { trigger: 'explicit' },
  )
  const sessionId =
    useChatStore.getState().currentSessionIdBySpaceId[workspaceId] ?? null
  if (!sessionId) {
    toast({
      title: '无法打开对话',
      description: '未能创建新会话，请稍后重试。',
      variant: 'destructive',
    })
    return null
  }

  // ：创建后立刻登记，避免注入/导航窗口被 reconcile 打回草稿并触发 quick-start
  rememberExternalOpenedSession(sessionId, {
    source: payload.meta.source,
    sourceSessionId: payload.meta.sourceSessionId,
    title: payload.meta.title,
  })

  // 先注入再导航：selectSession 会优先读本地 IDB/cache，首屏才能看到外来消息
  await persistExternalArchiveHydration(sessionId, hydrated, payload.meta)
  await ensureSessionAgentLikeNewChat(
    sessionId,
    workspaceId,
    payload.organizationId,
  )

  const title = payload.meta.title?.trim()
    ? payload.meta.title.trim().slice(0, 80)
    : `${IMPORT_SOURCE_LABELS[payload.meta.source] ?? payload.meta.source} 历史`
  try {
    await useChatStore.getState().renameSession(workspaceId, sessionId, title)
  } catch {
    /* 标题失败不阻断 */
  }

  const ok = await focusConversation(workspaceId, sessionId, payload.organizationId)
  if (!ok) return null

  const after = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  if (after.length < hydrated.length) {
    await persistExternalArchiveHydration(sessionId, hydrated, payload.meta)
  }

  await seedOpenedArchiveTranscript({
    organizationId: payload.organizationId,
    source: payload.meta.source,
    sourceSessionId: payload.meta.sourceSessionId,
    sessionId,
    spaceId: workspaceId,
  })
  await bindOpenedSession({
    organizationId: payload.organizationId,
    source: payload.meta.source,
    sourceSessionId: payload.meta.sourceSessionId,
    sessionId,
  })
  rememberExternalOpenedSession(sessionId, {
    source: payload.meta.source,
    sourceSessionId: payload.meta.sourceSessionId,
    title: payload.meta.title,
  })

  return { sessionId, workspaceId, resumed: false }
}
