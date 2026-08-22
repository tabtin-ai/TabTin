/**
 * Agent 回合尾部活动状态。
 *
 * 同一时刻只能有一个活动行：
 * - Thinking / Text / 工具执行：由各自真实 block 承接；
 * - 工具完成到下一段 Thinking 正文：显示 planningNext；
 * - 尚无有效块：显示 pending。
 */
import { getThinkingBody } from './thinkingBody'

export type AgentAwaitingThoughtPhase =
  | 'hidden'
  | 'pending'
  | 'planningNext'

export type ContentBlockLike = {
  block?: {
    type?: string
    text?: string
    thinking?: string
    id?: string
    tool_use_id?: string
  } | null
  finalized?: boolean
}

/** 真实 thinking 已开始流出文本：由 ThinkingBlockView 承接，等待壳让位。 */
export function hasStreamingThinkingContent(
  blocks: readonly ContentBlockLike[] | null | undefined,
): boolean {
  return (blocks ?? []).some((entry) => {
    const type = entry.block?.type
    if (type !== 'thinking' && type !== 'redacted_thinking') return false
    if (entry.finalized === true) return false
    return getThinkingBody(entry.block).trim().length > 0
  })
}

export type AgentTurnTailActivity =
  | 'none'
  | 'thinking'
  | 'text'
  | 'settledTool'
  | 'unsettledTool'
  | 'other'

/**
 * 当前 run 末尾的用户可见活动归属。
 *
 * `tool_result` / `mcp_tool_result` 是工具卡的附属输出，扫描时跳过它们，以便结果到达后仍将尾部
 * 归属为对应的 settled tool。空 Thinking 同样跳过，保留工具后的 planning
 * 空窗；但 finalized Thinking 是已可见的步骤，必须阻断 planningNext。
 */
export function resolveAgentTurnTailActivity(
  blocks: readonly ContentBlockLike[] | null | undefined,
  settledToolIds?: ReadonlySet<string>,
): AgentTurnTailActivity {
  const entries = blocks ?? []
  const nativeResultIds = new Set<string>()
  const mcpResultIds = new Set<string>()
  const nativeToolIds = new Set<string>()
  const mcpToolIds = new Set<string>()

  for (const entry of entries) {
    const block = entry.block
    const id = typeof block?.id === 'string' ? block.id : undefined
    const toolUseId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined
    if (block?.type === 'tool_use' && id) nativeToolIds.add(id)
    if (block?.type === 'mcp_tool_use' && id) mcpToolIds.add(id)
    if (block?.type === 'tool_result' && toolUseId) nativeResultIds.add(toolUseId)
    if (block?.type === 'mcp_tool_result' && toolUseId) mcpResultIds.add(toolUseId)
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    const block = entry.block
    const type = block?.type
    if (!type) continue
    if (type === 'tool_result' || type === 'mcp_tool_result') continue
    if (type === 'thinking' || type === 'redacted_thinking') {
      if (!entry.finalized && !getThinkingBody(block).trim()) continue
      return 'thinking'
    }
    if (type === 'text') {
      if (!block.text?.trim()) continue
      return 'text'
    }
    if (type === 'tool_use' || type === 'mcp_tool_use') {
      if (entry.finalized !== true) return 'unsettledTool'
      const id = typeof block.id === 'string' ? block.id : undefined
      const isMcpTool = type === 'mcp_tool_use'
      const hasMatchingResult = isMcpTool
        ? mcpResultIds.has(id ?? '')
        : nativeResultIds.has(id ?? '')
      // lifecycle notice 只有 id 没有 block 类型。若相同 id 同时出现在 MCP 与
      // 原生工具里，它无法证明当前这张卡已结束，必须等同类型 result 来判定。
      const lifecycleSettled = !!id
        && !((isMcpTool ? nativeToolIds : mcpToolIds).has(id))
        && settledToolIds?.has(id)
      if (hasMatchingResult || lifecycleSettled) return 'settledTool'
      return 'unsettledTool'
    }
    return 'other'
  }
  return 'none'
}

export type ResolveAgentAwaitingThoughtPhaseInput = {
  /** streaming 且非 HITL（与原 tail 可见口径一致） */
  sessionPulseVisible: boolean
  isLastAssistantMsg: boolean
  tailActivity: AgentTurnTailActivity
}

export function resolveAgentAwaitingThoughtPhase(
  input: ResolveAgentAwaitingThoughtPhaseInput,
): AgentAwaitingThoughtPhase {
  if (!input.sessionPulseVisible || !input.isLastAssistantMsg) return 'hidden'
  if (input.tailActivity === 'settledTool') return 'planningNext'
  if (input.tailActivity === 'none') return 'pending'
  return 'hidden'
}
