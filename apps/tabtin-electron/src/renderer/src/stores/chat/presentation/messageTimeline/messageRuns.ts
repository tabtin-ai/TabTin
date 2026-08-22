/**
 * messageRuns — 连续助手段的分组与块流拼接。
 *
 * 合并同一段可见助手输出里的 llm + tool_artifact，拼成单个 BlockTimeline。
 * 中间若只夹着 UI 隐藏脚手架（context / HITL fact / skill 注入），继续合并；
 * 若夹着可见消息（push 完成条 / error / 真实 user 等），各段就地渲染，不跨缺口拼块。
 *
 * 用户轮分界只认 `isRegularUserMessage`（见 turnTransparency）；本模块不负责分轮。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { isContextInjectionMessage } from '@/stores/chat/messages/utils/semanticMessageCount'
import { deriveResolvedAskChoicePresentation } from '../messageBubble/resolvedAskChoicePresentation'
import {
  isLlmAssistantSegment,
  isToolArtifactMessage,
} from './turnTransparency'

/**
 * 一个连续助手 run（llm 段数 ≥ 2 时才登记）。
 * memberIndices 升序；中间可跳过 UI 隐藏脚手架。
 */
export interface AssistantRun {
  /** 首段下标——渲染锚点（虚拟行 key 稳定）。 */
  firstIndex: number
  /** 末段下标——footer / 复制 / diff 取末段。 */
  lastIndex: number
  /** 覆盖的全部可见助手下标（升序；不含被跳过的隐藏脚手架）。 */
  memberIndices: number[]
}

function canBridgeAcrossForRunMerge(message: ChatMessage): boolean {
  if (isContextInjectionMessage(message)) return true
  if ((message.message_kind ?? 'llm') === 'hitl_interaction') {
    const metadata = message.metadata as Record<string, unknown> | null | undefined
    return deriveResolvedAskChoicePresentation(metadata) === null
  }
  if (message.role === 'user' && (message.message_kind ?? 'llm') !== 'llm') return true
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  return message.role === 'user' && metadata?.source === 'skill_invoke'
}

/**
 * 扫描物化后的段序列，把可连续展示的 llm（及夹在其间的 tool_artifact）分组。
 * 遇 UI 隐藏脚手架继续扫；遇可见非 llm / 非 tool_artifact 即停。
 * 不比较 `agent_run_id`。
 */
export function computeAssistantRuns(messages: readonly ChatMessage[]): Map<number, AssistantRun> {
  const map = new Map<number, AssistantRun>()
  const n = messages.length
  let i = 0
  while (i < n) {
    if (!isLlmAssistantSegment(messages[i])) {
      i++
      continue
    }
    const memberIndices: number[] = [i]
    let llmSegmentCount = 1
    let pendingToolArtifacts: number[] = []
    let j = i + 1
    while (j < n) {
      const candidate = messages[j]
      if (isToolArtifactMessage(candidate)) {
        pendingToolArtifacts.push(j)
        j++
        continue
      }
      if (isLlmAssistantSegment(candidate)) {
        memberIndices.push(...pendingToolArtifacts, j)
        pendingToolArtifacts = []
        llmSegmentCount++
        j++
        continue
      }
      if (canBridgeAcrossForRunMerge(candidate)) {
        j++
        continue
      }
      break
    }
    if (llmSegmentCount >= 2) {
      const run: AssistantRun = {
        firstIndex: memberIndices[0],
        lastIndex: memberIndices[memberIndices.length - 1],
        memberIndices,
      }
      for (const k of memberIndices) map.set(k, run)
    }
    i = j
  }
  return map
}

/**
 * 把成员段块**按序拼接**成一条 `ContentBlockEntry[]`。
 *
 * 优先级（与 resolveMessageContentBlocks 对齐）：
 * - ：store 有块 → 只用 store（不读可能过期的 props.blocks）
 * - ：store 空 → 回落 `message.blocks`（子代理详情虚拟 session 永不写 store；
 *   归档 / live 投影的块挂在消息 props 上）
 */
export function assembleRunContentBlocks(
  memberMessages: readonly ChatMessage[],
  blocksByMessageId: Record<string, ContentBlockEntry[]>,
): ContentBlockEntry[] {
  const out: ContentBlockEntry[] = []
  for (const message of memberMessages) {
    const fromStore = blocksByMessageId[message.id]
    if (fromStore && fromStore.length > 0) {
      out.push(...fromStore)
      continue
    }
    const fromMessage = message.blocks
    if (Array.isArray(fromMessage) && fromMessage.length > 0) {
      out.push(...(fromMessage as ContentBlockEntry[]))
    }
  }
  return out
}
