/**
 * 轮次窗口 / 轮末判定 —— 「本轮产物」挂载点与流式可见性。
 *
 * 方案 A：仅真实用户消息分轮；其余一律轮内。挂载点落在轮内最后一个
 * 可承载产物的 assistant 段（llm / tool_artifact / error_envelope）。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import type { TurnArtifact } from './turnArtifactTypes'
import {
  canHostTurnArtifacts,
  isRegularUserMessage,
} from './turnTransparency'

/** 含 fromIndex 的用户轮在 messages 中的 [start, limit]（含两端）。 */
function getUserTurnBounds(messages: ChatMessage[], fromIndex: number): { start: number; limit: number } {
  let start = 0
  for (let i = fromIndex; i >= 0; i--) {
    if (isRegularUserMessage(messages[i])) {
      start = i + 1
      break
    }
  }
  let limit = messages.length - 1
  for (let i = fromIndex + 1; i < messages.length; i++) {
    if (isRegularUserMessage(messages[i])) {
      limit = i - 1
      break
    }
  }
  return { start, limit }
}

/** 从 turnEndIndex 向前划定本轮消息窗口。 */
export function getTurnMessageWindow(messages: ChatMessage[], turnEndIndex: number): ChatMessage[] {
  if (turnEndIndex < 0 || turnEndIndex >= messages.length) return []
  const { start } = getUserTurnBounds(messages, turnEndIndex)
  return messages.slice(start, turnEndIndex + 1)
}

/**
 * 给定任意轮内 index，返回该轮产物挂载末尾 index。
 * 落在用户轮内最后一个 canHostTurnArtifacts 的消息上（跳过 trailing push/profile）。
 */
export function getTurnEndIndex(messages: ChatMessage[], fromIndex: number): number {
  if (fromIndex < 0 || fromIndex >= messages.length) return fromIndex
  const { start, limit } = getUserTurnBounds(messages, fromIndex)
  for (let i = limit; i >= start; i--) {
    if (canHostTurnArtifacts(messages[i])) return i
  }
  return fromIndex
}

export function isTurnEndSlot(messages: ChatMessage[], index: number): boolean {
  const message = messages[index]
  if (!message) return false
  if (isRegularUserMessage(message)) return false
  if (!canHostTurnArtifacts(message)) return false
  return getTurnEndIndex(messages, index) === index
}

export function findLastTurnEndIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnEndSlot(messages, i)) return i
  }
  return -1
}

/**
 * 当前可展示的「本轮」轮末：最后一个其后没有普通用户消息的轮末。
 *
 * `findLastTurnEndIndex` 在 `user₁ → assistant₁ → user₂` 时仍返回 `assistant₁`，
 * 产物卡需要继续挂在上一轮；Changes / 侧栏统计不能把上一轮 Diff 当成 `user₂` 的本轮。
 * pending user 间隙（新任务已发出、新 assistant 未到）返回 -1。
 * trailing profile / push-notification 不是普通用户消息，不打断上一轮。
 */
export function findLastClosedTurnEndIndex(messages: ChatMessage[]): number {
  const end = findLastTurnEndIndex(messages)
  if (end < 0 || hasRegularUserAfter(messages, end)) return -1
  return end
}

/** 当前已闭合轮末消息 ID；没有已闭合轮时返回 null。 */
export function getLatestClosedTurnEndMessageId(messages: ChatMessage[]): string | null {
  const index = findLastClosedTurnEndIndex(messages)
  return index >= 0 ? messages[index]?.id ?? null : null
}

function hasRegularUserAfter(messages: ChatMessage[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    if (isRegularUserMessage(messages[i])) return true
  }
  return false
}

/**
 * ：该轮末是否仍是「开着的流式末轮」。
 *
 *  要藏的是正在生成的那一轮；旧条件 `isStreaming && index === lastTurnEnd`
 * 会在新 user 已写入、新 assistant 未到时误藏上一轮。补上「其后无普通 user」即可。
 *
 * 发送路径契约：user 入列后才进入 busy（ 由 run_sync / run_state 驱动）
 * 调用，保证 busy 变为 true 时 messages 已含后续普通 user。
 */
export function isOpenStreamingTurnEnd(
  messages: ChatMessage[],
  index: number,
  isStreaming: boolean,
): boolean {
  return isStreaming
    && index === findLastTurnEndIndex(messages)
    && !hasRegularUserAfter(messages, index)
}

/** MessageList 产物卡是否挂载。 */
export function shouldShowTurnArtifactsCard(options: {
  sessionId: string | null | undefined
  artifacts: TurnArtifact[] | undefined
  messages: ChatMessage[]
  index: number
  isStreaming: boolean
}): boolean {
  const { sessionId, artifacts, messages, index, isStreaming } = options
  if (!sessionId || !artifacts || artifacts.length === 0) return false
  if (!isTurnEndSlot(messages, index)) return false
  return !isOpenStreamingTurnEnd(messages, index, isStreaming)
}
