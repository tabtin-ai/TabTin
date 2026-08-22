/**
 * 会话标题生成幂等触发器（dedupe）。
 *
 * ## 协议
 *
 * 本模块只负责触发 ``POST /sessions/:id/generate-title``，**必须携带
 * ``user_message``**，与消息落库 ACK / DB 回读解耦。
 *
 * 1. HTTP 立即返 ``{accepted, reason?}``，不带 title
 * 2. LLM 完成后经 ``agent.user.title_updated`` 落地
 * 3. 触发点：发送热路径（有真 sessionId + 正文时立刻发）
 *
 * 不再提供 ACK / lifecycle.end / selectSession 触发。
 */

import type { ChatClient, ChatMessage, ChatSession } from '@tabtin/chat-client'
import { createLogger } from '@/utils/logger'
import { countSemanticUserMessages } from '../utils/semanticMessageCount'

const log = createLogger('TitleGen')

/** 已触发过的 sessionId 集合 + 各自的清理 timer。 */
const triggeredSessions = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 单条 entry 在 dedupe 集合里保留多久——5 分钟够覆盖 LLM 慢调用 + 用户犹豫
 * 重发，但不会无限增长。强制重新生成走 ``force=true``，与本 dedupe 无关。
 */
const DEDUPE_TTL_MS = 5 * 60 * 1000

/** 释放 dedupe 锁，允许同 session 再次触发。 */
export function releaseTitleGenerationDedupe(sessionId: string): void {
  const timer = triggeredSessions.get(sessionId)
  if (timer) {
    clearTimeout(timer)
  }
  triggeredSessions.delete(sessionId)
}

export interface RequestTitleOnceDeps {
  sessionId: string
  /** 用于生成标题的用户正文（必填，trim 后非空）。 */
  userMessage: string
  /**
   * 触发条件：通常用 ``defaultShouldGenerateTitle(messages)``——仅首轮语义 user。
   */
  shouldTrigger: () => boolean
  getChatClient: () => ChatClient
  /** 手动重生成时传 true；跳过本模块 5 分钟 dedupe。 */
  force?: boolean
}

/**
 * 仅当本会话只有 ≤ 1 条真实 user 消息时自动触发。
 * 合成 user（environment_context 等）不计入。
 */
export function defaultShouldGenerateTitle(messages: readonly ChatMessage[]): boolean {
  return countSemanticUserMessages(messages) <= 1
}

/**
 * fork 数字编号占位：后端 title_is_default=true（pending）时，
 * 即使已有拷贝来的多条 user，首次发送新消息仍应触发生成。
 */
export function shouldGenerateTitleOnSend(
  messages: readonly ChatMessage[],
  session?: Pick<ChatSession, 'title_is_default' | 'forked_from_id' | 'title_generation_status'> | null,
): boolean {
  if (defaultShouldGenerateTitle(messages)) return true
  if (!session?.forked_from_id) return false
  if (session.title_generation_status === 'done') return false
  return session.title_is_default === true
}

/**
 * 请求生成标题：同一 sessionId 在 5 分钟窗口内只发一次（force 除外）。
 *
 * @returns ``true`` = 已发起请求；``false`` = 被跳过
 */
export function requestTitleGenerationOnce(deps: RequestTitleOnceDeps): boolean {
  const { sessionId, shouldTrigger, getChatClient, force = false } = deps
  const userMessage = deps.userMessage.trim()
  if (!userMessage) {
    log.warn('[TitleGen] skip generateTitle: empty userMessage session=%s', sessionId.slice(0, 8))
    return false
  }

  if (!force && triggeredSessions.has(sessionId)) {
    log.debug('[dedupe] skip generateTitle (already triggered) session=%s', sessionId.slice(0, 8))
    return false
  }

  if (!force && !shouldTrigger()) {
    return false
  }

  if (!force) {
    const timer = setTimeout(() => {
      triggeredSessions.delete(sessionId)
    }, DEDUPE_TTL_MS)
    triggeredSessions.set(sessionId, timer)
  }

  getChatClient()
    .sessions.generateTitle(sessionId, { userMessage, force: force === true })
    .then((result) => {
      log.info(
        '[TitleGen] generate-title accepted=%s reason=%s session=%s',
        result?.accepted,
        result?.reason ?? '(none)',
        sessionId.slice(0, 8),
      )
      if (result?.accepted === false && !force) {
        releaseTitleGenerationDedupe(sessionId)
      }
    })
    .catch((err) => {
      log.warn(
        `[TitleGen] generate-title HTTP error session=${sessionId.slice(0, 8)} err=${err?.message || String(err)}`,
      )
      if (!force) {
        releaseTitleGenerationDedupe(sessionId)
      }
    })

  return true
}

/**
 * 发送热路径：首轮用户正文随 HTTP 立刻触发生成。
 * fork 占位标题会话在首次新消息时同样触发（见 shouldGenerateTitleOnSend）。
 */
export function requestTitleGenerationOnSend(deps: {
  sessionId: string
  userMessage: string
  getMessages: () => readonly ChatMessage[]
  getChatClient: () => ChatClient
  getSession?: () => Pick<ChatSession, 'title_is_default' | 'forked_from_id' | 'title_generation_status'> | null | undefined
}): boolean {
  return requestTitleGenerationOnce({
    sessionId: deps.sessionId,
    userMessage: deps.userMessage,
    shouldTrigger: () => shouldGenerateTitleOnSend(deps.getMessages(), deps.getSession?.() ?? null),
    getChatClient: deps.getChatClient,
  })
}

/**
 * @internal 仅供测试
 */
export function _resetTitleGenerationDedupeForTests(): void {
  for (const timer of triggeredSessions.values()) {
    clearTimeout(timer)
  }
  triggeredSessions.clear()
}
