import type { ChatMessage } from '@tabtin/chat-client'
import type { AgentConfig as AgentConfigV2 } from '@tabtin/app-shell'
// leaf 子路径：禁止经 @tabtin/agent-prompt / runtime 根 barrel（会拖入 node:crypto，）
import { buildUserContextWrapper } from '@tabtin/agent-runtime/engine/user-context-wrapper'
import {
  selectRecentHistoryForRuntime,
  isCrossTurnMemoryEnabled,
  DEFAULT_MAX_HISTORY_MESSAGES,
  type HistorySourceMessage,
} from '@tabtin/agent-runtime/history'
import { resolveComposerPresetPrompt } from './composerPresetPrompt'
import { resolveContextBlocks } from './contextBlockResolution'
import { createViteEnvReader } from './sendDispatchInputs'
import { buildExternalArchiveLlmBoundaryMessage } from '@components/onboarding/external-import/externalArchivePromptBoundary'
import { isExternalOpenedSession } from '@components/onboarding/external-import/externalOpenedSessionRegistry'
import {
  historyHasExternalArchiveBoundary,
  isExternalArchiveDecorationMessage,
} from '@components/onboarding/external-import/mergeExternalArchiveMessages'

type ReplyToContext = {
  messageId: string
  preview: { role: 'user' | 'assistant' | 'system' | 'tool'; author?: string; text: string }
}

type PromptContextLogger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

/**
 * 产品域：拼装发给 runtime 的执行文本 `effectiveMessage`。
 *
 * 顺序与语义（quoted → composer preset → @引用）与 stale_after_turn 折叠口径来自
 * 产品规则；实际的引用解析 IO 由注入的 `resolveContextBlocks` 承担。
 */
export async function assemblePromptContext(params: {
  message: string
  replyTo?: ReplyToContext
  contextBlocks?: Array<Record<string, unknown>>
  staleAfterTurn: string
  log: PromptContextLogger
}): Promise<string> {
  const { message, replyTo, contextBlocks, staleAfterTurn, log } = params

  let effectiveMessage = message
  const appendPromptContext = (contextText: string): void => {
    if (!contextText.trim()) return
    effectiveMessage = effectiveMessage.trim()
      ? `${effectiveMessage}\n\n${contextText}`
      : contextText
  }

  //  引用回复：把被引用消息正文包成 `<context type="quoted-message">` 前置进 prompt。
  if (replyTo?.messageId) {
    const quotedAuthor = replyTo.preview.author
      ? `${replyTo.preview.author}（${replyTo.preview.role}）`
      : replyTo.preview.role
    const quotedBody = `用户引用回复了以下消息：\n${quotedAuthor}: ${replyTo.preview.text}`
    appendPromptContext(buildUserContextWrapper('quoted-message', quotedBody, {
      stale_after_turn: staleAfterTurn,
    }))
  }

  if (contextBlocks && contextBlocks.length > 0) {
    const composerPresetText = resolveComposerPresetPrompt(contextBlocks)
    if (composerPresetText) {
      appendPromptContext(buildUserContextWrapper('referenced', composerPresetText, {
        stale_after_turn: staleAfterTurn,
      }))
      log.info('[Local] Composer preset 解析成功, context_text length=%d', composerPresetText.length)
    }

    try {
      const contextText = await resolveContextBlocks(contextBlocks)
      if (contextText) {
        appendPromptContext(buildUserContextWrapper('referenced', contextText, {
          stale_after_turn: staleAfterTurn,
        }))
        log.info('[Local] @ 引用解析成功, context_text length=%d', contextText.length)
      } else {
        // ：context chip 已入队但解析为空 → preload 会拒空 prompt；记脱敏摘要便于诊断
        log.warn('[Local] @ 引用解析结果为空', {
          blockCount: contextBlocks.length,
          blockTypes: contextBlocks.map((block) =>
            typeof block.type === 'string' ? block.type : 'unknown',
          ),
        })
      }
    } catch (resolveErr) {
      log.warn('[Local] @ 引用解析失败 (non-blocking):', resolveErr)
    }
  }

  return effectiveMessage
}

/**
 * 产品域：按 agent_config 跨轮记忆开关，从 renderer 内存消息快照派生 runtime history。
 * 关闭或无历史时返回 undefined，行为等同旧版不传 history。
 */
export function buildCrossTurnHistory(params: {
  agentConfig: AgentConfigV2 | undefined
  snapshotMessages: ChatMessage[]
  currentUserMessageId: string
  sessionId: string
  log: PromptContextLogger
  /**
   * DeepSeek V4 等 implicit-thinking provider：保留工具轮 thinking 以便跨轮回传
   * reasoning_content（否则上游 400）。默认 false（丢弃， 现状）。
   */
  preserveReasoningForToolTurns?: boolean
  preserveAllReasoningHistory?: boolean
}): ReturnType<typeof selectRecentHistoryForRuntime> | undefined {
  const {
    agentConfig,
    snapshotMessages,
    currentUserMessageId,
    sessionId,
    log,
    preserveReasoningForToolTurns,
    preserveAllReasoningHistory,
  } = params

  const ctmFlat: { cross_turn_memory?: boolean } = {
    cross_turn_memory: agentConfig?.conversation?.cross_turn_memory,
  }
  if (!isCrossTurnMemoryEnabled(ctmFlat, createViteEnvReader('VITE_DISABLE_CROSS_TURN_MEMORY'))) {
    return undefined
  }

  // W4c 跨边界字段映射：daemon `HistorySourceMessage` 窄接口仍用字段名 `blocks_json`；
  // renderer ChatMessage 已切到 `content_blocks_json`，调用 daemon 前做映射。
  const historySource: HistorySourceMessage[] = snapshotMessages.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    message_kind: m.message_kind,
    metadata: m.metadata as HistorySourceMessage['metadata'],
    blocks_json: m.content_blocks_json as unknown as HistorySourceMessage['blocks_json'],
  }))

  // 旧会话可能只有 UI 用的 system 横幅（会被滤掉），发消息时临时补 LLM 边界，
  // 避免模型把导入的助手自称当成自己。
  // 可信判定：打开登记，或 hydrate 写入的 `ext-*` id——不认普通会话伪造 metadata。
  const hasTrustedExternalArchiveId = (m: { id?: string }): boolean =>
    typeof m.id === 'string' && m.id.startsWith('ext-')
  const hasExternalArchive =
    isExternalOpenedSession(sessionId)
    || historySource.some(hasTrustedExternalArchiveId)
  const hasExternalBoundary = historyHasExternalArchiveBoundary(historySource)
  const resolveBoundaryMeta = (): {
    source: string
    sourceSessionId: string
    title: string
    cwd: string | null
  } => {
    const sample = historySource.find((m) => {
      const meta = m.metadata as Record<string, unknown> | null | undefined
      return meta?.external_archive === true || meta?.system_fact === 'external_archive_prefix'
        || meta?.system_fact === 'external_archive_llm_boundary'
        || (typeof m.id === 'string' && m.id.startsWith('ext-'))
    })
    const meta = (sample?.metadata ?? {}) as Record<string, unknown>
    return {
      source: typeof meta.source === 'string' ? meta.source : 'external',
      sourceSessionId:
        typeof meta.source_session_id === 'string' ? meta.source_session_id : 'unknown',
      title: typeof meta.title === 'string' ? meta.title : '',
      cwd: typeof meta.cwd === 'string' ? meta.cwd : null,
    }
  }
  if (hasExternalArchive && !hasExternalBoundary) {
    const boundary = buildExternalArchiveLlmBoundaryMessage(resolveBoundaryMeta())
    // 插在最后一条外来消息之后；找不到则追加在末尾（本轮 user 会由 excludeCurrentTurn 剔除）
    let insertAt = -1
    for (let i = 0; i < historySource.length; i += 1) {
      const candidate = historySource[i]
      if (candidate && isExternalArchiveDecorationMessage(candidate)) {
        insertAt = i + 1
      }
    }
    const injected: HistorySourceMessage = {
      id: boundary.id,
      role: 'user',
      content: boundary.content,
      message_kind: 'external_archive_context',
      metadata: boundary.metadata as HistorySourceMessage['metadata'],
      blocks_json: boundary.content_blocks_json as HistorySourceMessage['blocks_json'],
    }
    if (insertAt < 0 || insertAt >= historySource.length) {
      historySource.push(injected)
    } else {
      historySource.splice(insertAt, 0, injected)
    }
  }

  const history = selectRecentHistoryForRuntime(historySource, {
    maxMessages: DEFAULT_MAX_HISTORY_MESSAGES,
    excludeCurrentTurn: true,
    currentUserMessageId,
    sessionId,
    includeSourceMessageIds: true,
    preserveReasoningForToolTurns,
    preserveAllReasoningHistory,
  })

  // 裁窗后边界可能被切掉，或时间戳甩尾后错位到 live 之后（L3 / ）
  // ——输出侧移除旧边界，钉回最后一条外来正文之后（无外来行则置顶）。
  if (hasExternalArchive && history.length > 0) {
    const isBoundaryMsg = (m: (typeof history)[number]): boolean => {
      const text = typeof m.content === 'string' ? m.content : ''
      if (text.trimStart().startsWith('<context type="external-archive"')) return true
      const sid = m.sourceMessageId
      return typeof sid === 'string' && sid.startsWith('ext-llm-boundary')
    }
    const isArchiveBody = (m: (typeof history)[number]): boolean => {
      const sid = m.sourceMessageId
      if (typeof sid !== 'string' || !sid.startsWith('ext-')) return false
      if (sid.startsWith('ext-llm-boundary') || sid.startsWith('ext-prefix')) return false
      return true
    }
    let insertAt = 0
    for (let i = 0; i < history.length; i += 1) {
      if (isArchiveBody(history[i]!)) insertAt = i + 1
    }
    const existingIdx = history.findIndex(isBoundaryMsg)
    // 边界须紧挨最后一条外来正文（窗口内无外来行时置顶）
    if (!(existingIdx >= 0 && existingIdx === insertAt)) {
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (isBoundaryMsg(history[i]!)) history.splice(i, 1)
      }
      insertAt = 0
      for (let i = 0; i < history.length; i += 1) {
        if (isArchiveBody(history[i]!)) insertAt = i + 1
      }
      const boundary = buildExternalArchiveLlmBoundaryMessage(resolveBoundaryMeta())
      history.splice(insertAt, 0, {
        role: 'user' as const,
        content: boundary.content ?? '',
        sourceMessageId: boundary.id,
      })
    }
  }

  log.info('[Local] cross-turn memory prepared, history_len=%d', history.length)
  return history.length === 0 ? undefined : history
}
