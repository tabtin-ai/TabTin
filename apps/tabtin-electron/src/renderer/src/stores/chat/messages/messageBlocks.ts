/**
 * messageBlocks —— 前端对话内容块的**单一 SSoT**。
 *
 * ## 定位（单一数据源）
 *
 * 运行时内容块唯一落在 `ChatMessage.blocks`（`messagesBySessionId` 里的消息壳上）——
 * **没有第二份索引**。读路径只认 `message.blocks`，不再于读时反序列化
 * `content_blocks_json`。
 *
 * ## 响应式（Zustand 原生绑定）
 *
 *   - 写：`commitBlocks` / clear / hydrate 经 `useChatStore.setState` **不可变**
 *     替换该条消息（新 message 对象 + 新 session 数组）。禁止对已入 store 的
 *     对象原地 mutate `blocks`（否则数组引用不变时列表不重渲、selector 也可能不醒）。
 *   - 读：`useMessageBlocksById` / `useSessionBlocksRecord` 用 Zustand selector
 *     订同一份 `message.blocks`；业务侧无手写 notify / listener map。
 *   - 列表性能：不在 store 订阅层挡引用变化；由 MessageBubble memo（不比
 *     `blocks`）+ 气泡内 blocks selector 吸收 token 级刷新。
 *
 * ## 实时 + 历史
 *
 *   - 实时：引擎每帧 flush `commitBlocks` → setState 写 `message.blocks`。
 *   - 历史：store 入口 `hydrateSessionBlocksFromJson` 从 `content_blocks_json`
 *     **不可变**灌入后，经 `setSessionMessages` 换新数组进列表。
 */

import { useCallback } from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { setContentBlocksBridge } from './contentBlocksMirrorRegistry'
import { useChatStore } from '@stores/chat/useChatStore'
import { ensureMessageRuntimeBlocks } from './ensureMessageRuntimeBlocks'

export { ensureMessageRuntimeBlocks } from './ensureMessageRuntimeBlocks'

// ── ChatMessage 旁挂前端内存字段 `blocks`（不入库） ─────────────────────
declare module '@tabtin/chat-client' {
  interface ChatMessage {
    /**
     * 前端内存 SSoT（唯一 store）：实时 / 历史 / 子代理统一的 `ContentBlockEntry[]`
     * （含流式元数据）。**不入库**——落库 / API 序列化仍走 `content_blocks_json`。
     * 实时由 `commitBlocks` 经 Zustand 不可变写入；历史由入口 hydrate（不可变
     * 换新对象）灌入。读路径只认它。
     */
    blocks?: ContentBlockEntry[]
  }
}

const EMPTY_BLOCKS: readonly ContentBlockEntry[] = Object.freeze(
  [],
) as readonly ContentBlockEntry[]

const EMPTY_RECORD: Record<string, ContentBlockEntry[]> = Object.freeze({})

function findMessage(sessionId: string, messageId: string): ChatMessage | undefined {
  return useChatStore.getState().messagesBySessionId?.[sessionId]?.find((m) => m.id === messageId)
}

/** session 块记录快照：仅当各 mid 的 blocks 引用有变才换新 record。 */
const _recordSnapshotCache = new Map<
  string,
  { record: Record<string, ContentBlockEntry[]> }
>()

/** 测试用：清空派生缓存（跨用例残留时用）。 */
export function __resetMessageBlocks(): void {
  _recordSnapshotCache.clear()
}

// ── 已提交块读写（引擎经 bridge 调用） ────────────────────────────────

/** 读某消息的已提交块（find message → message.blocks）；无壳 / 无块则 undefined。 */
export function getCommittedBlocks(
  sessionId: string,
  messageId: string,
): ContentBlockEntry[] | undefined {
  return findMessage(sessionId, messageId)?.blocks
}

/**
 * 取某 session 全部块，展平成 `Record<mid, entries>`。
 * 每次新建对象——非响应式即时读。响应式消费走 `useSessionBlocksRecord`。
 */
export function getSessionBlocksRecord(
  sessionId: string,
): Record<string, ContentBlockEntry[]> | undefined {
  const messages = useChatStore.getState().messagesBySessionId?.[sessionId]
  if (!messages) return undefined
  const record: Record<string, ContentBlockEntry[]> = {}
  for (const m of messages) {
    if (m.blocks !== undefined) record[m.id] = m.blocks as ContentBlockEntry[]
  }
  return record
}

function buildSessionBlocksRecord(
  messages: readonly ChatMessage[] | undefined,
): Record<string, ContentBlockEntry[]> {
  if (!messages) return {}
  const record: Record<string, ContentBlockEntry[]> = {}
  for (const m of messages) {
    if (m.blocks !== undefined) record[m.id] = m.blocks as ContentBlockEntry[]
  }
  return record
}

function sessionBlocksRecordUnchanged(
  prev: Record<string, ContentBlockEntry[]>,
  next: Record<string, ContentBlockEntry[]>,
): boolean {
  const prevKeys = Object.keys(prev)
  const nextKeys = Object.keys(next)
  if (prevKeys.length !== nextKeys.length) return false
  for (const key of nextKeys) {
    if (prev[key] !== next[key]) return false
  }
  return true
}

function getSessionBlocksRecordSnapshot(
  sessionId: string,
  messages: readonly ChatMessage[] | undefined,
): Record<string, ContentBlockEntry[]> {
  const next = buildSessionBlocksRecord(messages)
  const cached = _recordSnapshotCache.get(sessionId)
  if (cached && sessionBlocksRecordUnchanged(cached.record, next)) {
    return cached.record
  }
  const record = Object.keys(next).length === 0 ? EMPTY_RECORD : next
  _recordSnapshotCache.set(sessionId, { record })
  return record
}

/**
 * 提交某消息的完整块数组（ 单一写入原语）。
 *
 * Zustand 不可变更新：换该条 message 对象与 session 数组引用。列表可跟着
 * 重渲；气泡正文靠 `useMessageBlocksById`，壳层靠 MessageBubble memo 跳过。
 */
export function commitBlocks(
  sessionId: string,
  messageId: string,
  entries: ContentBlockEntry[],
): void {
  useChatStore.setState((state) => {
    const messages = state.messagesBySessionId?.[sessionId]
    if (!messages) return {}
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return {}
    const next = messages.slice()
    next[idx] = { ...messages[idx], blocks: entries }
    return {
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [sessionId]: next,
      },
    }
  })
}

/** 清某 session 上全部消息的 blocks（runtime evict / 测试）。 */
export function clearSessionBlocks(sessionId: string): void {
  _recordSnapshotCache.delete(sessionId)
  useChatStore.setState((state) => {
    const messages = state.messagesBySessionId?.[sessionId]
    if (!messages || messages.length === 0) return {}
    let changed = false
    const next = messages.map((m) => {
      if (m.blocks === undefined) return m
      changed = true
      return { ...m, blocks: undefined }
    })
    if (!changed) return {}
    return {
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [sessionId]: next,
      },
    }
  })
}

/** 清某 session 下指定消息的块（LRU trim 用）。 */
export function clearMessageBlocks(sessionId: string, messageIds: Iterable<string>): void {
  const idSet = messageIds instanceof Set ? messageIds : new Set(messageIds)
  if (idSet.size === 0) return
  useChatStore.setState((state) => {
    const messages = state.messagesBySessionId?.[sessionId]
    if (!messages) return {}
    let changed = false
    const next = messages.map((m) => {
      if (!idSet.has(m.id) || m.blocks === undefined) return m
      changed = true
      return { ...m, blocks: undefined }
    })
    if (!changed) return {}
    return {
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [sessionId]: next,
      },
    }
  })
}

export type HydrateSessionBlocksResult = {
  /** 灌块后的列表；有变更时为新数组，否则与入参同一引用 */
  messages: ChatMessage[]
  /** 本次新灌入 blocks 的 message id */
  hydratedMids: string[]
  /** 是否产生了新 message 对象（调用方必须用本结果写回 store） */
  changed: boolean
}

/**
 * 批量 ensure：给将写入 store 的消息灌 `blocks`（不可变， 方案 A）。
 * 需要灌块时返回新 message + 新数组；绝不原地改入参。
 */
export function hydrateSessionBlocksFromJson(
  messages: readonly ChatMessage[],
): HydrateSessionBlocksResult {
  const hydratedMids: string[] = []
  let changed = false
  const next = messages.map((m) => {
    const ensured = ensureMessageRuntimeBlocks(m)
    if (ensured !== m) {
      changed = true
      hydratedMids.push(m.id)
    }
    return ensured
  })
  if (!changed) {
    return {
      messages: messages as ChatMessage[],
      hydratedMids,
      changed: false,
    }
  }
  return { messages: next, hydratedMids, changed: true }
}

/**
 * 非响应式取块（供纯函数派生器）：直接读旁挂 `message.blocks`。
 */
export function getMessageBlocksSnapshot(
  message: ChatMessage,
): readonly ContentBlockEntry[] {
  return message.blocks ?? EMPTY_BLOCKS
}

/**
 * 响应式读单条消息的已提交块——Zustand selector，订 `message.blocks`。
 */
export function useMessageBlocksById(
  sessionId: string | null | undefined,
  messageId: string | null | undefined,
): readonly ContentBlockEntry[] {
  return useChatStore(
    useCallback(
      (state) => {
        if (!sessionId || !messageId) return EMPTY_BLOCKS
        return (
          state.messagesBySessionId?.[sessionId]?.find((m) => m.id === messageId)?.blocks
          ?? EMPTY_BLOCKS
        )
      },
      [sessionId, messageId],
    ),
  )
}

/**
 * 响应式订阅某 session 的块记录（跨消息消费者）。
 * 数据仍来自各条 `message.blocks`；缓存保证 blocks 引用未变时返回同一 record。
 */
export function useSessionBlocksRecord(
  sessionId: string | null | undefined,
): Record<string, ContentBlockEntry[]> {
  return useChatStore(
    useCallback(
      (state) => {
        if (!sessionId) return EMPTY_RECORD
        return getSessionBlocksRecordSnapshot(
          sessionId,
          state.messagesBySessionId?.[sessionId],
        )
      },
      [sessionId],
    ),
  )
}

// ── 注册桥：runtime 引擎经它 commit / read / clear ────────────────────
setContentBlocksBridge({
  commit: commitBlocks,
  read: getCommittedBlocks,
  clearSession: clearSessionBlocks,
  clearMessages: clearMessageBlocks,
})
