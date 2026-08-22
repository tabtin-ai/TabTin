/**
 * Restores agentSteps and toolEvents from content_blocks_json of historical messages.
 *
 * When a session is loaded from the server or cache, the runtime state
 * (agentSteps, toolEvents) is empty because it only lives in memory during
 * streaming. This helper extracts tool_call and thinking blocks from the
 * last assistant message's content_blocks_json and populates the store so that
 * historical external Agent conversations display tool calls and thinking.
 */

import i18n from '@/i18n'
import type { ChatMessage } from '@tabtin/chat-client'
import { isAgentModeName, type AgentModeName, type AgentStep, type AgentStepStatus, type AgentStepType, type ToolEvent, type ToolPhase } from '../../shared/types'
import { humanizeToolName, summarizeToolInput, summarizeToolOutput, unwrapToolOutputFence } from '../../shared/helpers'

export interface RestoredRuntimeState {
  agentSteps: AgentStep[]
  toolEvents: ToolEvent[]
  agentMode?: AgentModeName
}

type NativeToolResult = {
  content: unknown
  isError: boolean
}

function collectNativeToolResults(messages: ChatMessage[]): Map<string, NativeToolResult> {
  const out = new Map<string, NativeToolResult>()
  for (const msg of messages) {
    const blocks = msg.content_blocks_json ?? []
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const record = block as Record<string, unknown>
      if (record.type !== 'tool_result') continue
      const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : ''
      if (!toolUseId) continue
      out.set(toolUseId, {
        content: record.content,
        isError: record.is_error === true,
      })
    }
  }
  return out
}

function durationFromOutput(output: unknown): number | undefined {
  if (!output || typeof output !== 'object') return undefined
  const obj = output as Record<string, unknown>
  const raw = obj.durationMs ?? obj.duration_ms
  return typeof raw === 'number' ? raw : undefined
}

/**
 * Scans the most recent assistant messages (up to 5) for content_blocks_json containing
 * tool_call / thinking blocks and converts them into AgentStep + ToolEvent arrays
 * for display in the execution steps sidebar. Results are capped at 200 entries.
 */
export function restoreRuntimeStateFromHistory(messages: ChatMessage[]): RestoredRuntimeState {
  const agentSteps: AgentStep[] = []
  const toolEvents: ToolEvent[] = []

  const MAX_RESTORE_MESSAGES = 5
  const MAX_AGENT_STEPS = 200

  const assistantMsgs = messages.filter(m => m.role === 'assistant' && m.content_blocks_json?.length)
  if (assistantMsgs.length === 0) return { agentSteps, toolEvents }

  const nativeToolResults = collectNativeToolResults(messages)
  const recentMsgs = assistantMsgs.slice(-MAX_RESTORE_MESSAGES)
  for (const msg of recentMsgs) {
    const blocks = msg.content_blocks_json ?? []
    const msgTimestamp = new Date(msg.created_at).getTime() || Date.now()

    for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
      const block = blocks[blockIdx]
      if (block.type === 'thinking' && block.content) {
        agentSteps.push({
          id: `history-thinking-${msg.id}-${blockIdx}`,
          type: 'thinking' as AgentStepType,
          title: 'Thinking',
          detail: block.content,
          status: 'done' as AgentStepStatus,
          timestamp: msgTimestamp,
        })
      }

      if (block.type === 'metadata' && block.error) {
        const metadataError = typeof block.error === 'string'
          ? block.error
          : (typeof (block as { error_message?: unknown }).error_message === 'string'
              ? (block as { error_message?: string }).error_message
              : undefined)
            || (typeof block.content === 'string' && block.content.trim().length > 0 ? block.content : undefined)
        agentSteps.push({
          id: `history-metadata-${msg.id}-${blockIdx}`,
          type: 'lifecycle' as AgentStepType,
          title: i18n.t('chat:messages.error', { defaultValue: 'Execution failed' }),
          detail: metadataError,
          status: 'error' as AgentStepStatus,
          timestamp: msgTimestamp,
        })
      }

      if (block.type === 'tool_call') {
        const toolName = block.tool_name || 'unknown'
        const toolCallId = block.tool_call_id || `history-tc-${msg.id}-${toolName}-${agentSteps.length}`
        const phase: ToolPhase = block.error ? 'error' : 'end'
        const displayName = humanizeToolName(toolName)
        const input = block.input ?? block.args ?? block.data
        const inputSummary = block.args_summary || summarizeToolInput(toolName, input)
        // PRD 08 W12（FR-09 fence）+ 2026-05-10 dogfood 修复：
        // blocks-collector 在 phase=end 时把 runtime fence-wrapped string 原样
        // 写进 block.output（参见 packages/agent-runtime/src/engine/blocks-collector.ts:78）。
        // 实时路径 toolHandler 已对 payload.output 调 unwrapToolOutputFence；
        // hydrate 路径必须做对称剥 fence，否则 FileReadCard / extractFileRead /
        // GenericToolCard 等下游消费者拿到带 fence 的 string，把 (output as any).data
        // 当对象访问得到 undefined → 显示「文件内容为空」。
        // 对错误 case 不剥 fence——错误文案通常是 plain string（permission denied 等），
        // 走 restoredError 分支用原 block.output 文案。
        const unwrappedOutput = phase === 'error' ? block.output : unwrapToolOutputFence(block.output)
        const outputSummary = block.output_summary || summarizeToolOutput(toolName, unwrappedOutput)
        const restoredError = typeof block.error === 'string'
          ? block.error
          : block.error && typeof block.output === 'string' && block.output.trim().length > 0
            ? block.output
            : block.error
              ? 'Error'
              : null

        toolEvents.push({
          id: toolCallId,
          toolName,
          phase,
          input,
          output: unwrappedOutput,
          error: restoredError,
          timestamp: msgTimestamp,
          durationMs: block.duration_ms,
          inputSummary,
          outputSummary,
          startedAt: msgTimestamp,
        })

        agentSteps.push({
          id: `tool-${toolCallId}`,
          type: 'tool_start' as AgentStepType,
          title: i18n.t('chat:agentSteps.toolCall', { name: displayName }),
          detail: phase === 'error'
            ? (restoredError || undefined)
            : (outputSummary || inputSummary || undefined),
          status: (phase === 'error' ? 'error' : 'done') as AgentStepStatus,
          timestamp: msgTimestamp,
          toolName,
          toolCallId,
          durationMs: block.duration_ms,
        })
      }

      const nativeBlock = block as Record<string, unknown>
      if (nativeBlock.type === 'tool_use') {
        const toolName = typeof nativeBlock.name === 'string' ? nativeBlock.name : 'unknown'
        const toolCallId = typeof nativeBlock.id === 'string'
          ? nativeBlock.id
          : `history-tu-${msg.id}-${toolName}-${agentSteps.length}`
        const input = nativeBlock.input
        const inputSummary = summarizeToolInput(toolName, input)
        const result = nativeToolResults.get(toolCallId)
        const phase: ToolPhase = result?.isError ? 'error' : result ? 'end' : 'start'
        const unwrappedOutput = result && !result.isError
          ? unwrapToolOutputFence(result.content)
          : result?.content
        const outputSummary = result && !result.isError
          ? summarizeToolOutput(toolName, unwrappedOutput)
          : undefined
        const restoredError = result?.isError
          ? (typeof result.content === 'string' && result.content.trim().length > 0 ? result.content : 'Error')
          : null
        const durationMs = durationFromOutput(unwrappedOutput)
        const displayName = humanizeToolName(toolName)

        toolEvents.push({
          id: toolCallId,
          toolName,
          phase,
          input,
          output: unwrappedOutput,
          error: restoredError,
          timestamp: msgTimestamp,
          durationMs,
          inputSummary,
          outputSummary,
          startedAt: msgTimestamp,
        })

        agentSteps.push({
          id: `tool-${toolCallId}`,
          type: 'tool_start' as AgentStepType,
          title: i18n.t('chat:agentSteps.toolCall', { name: displayName }),
          detail: phase === 'error'
            ? (restoredError || undefined)
            : (outputSummary || inputSummary || undefined),
          status: (phase === 'error' ? 'error' : phase === 'start' ? 'running' : 'done') as AgentStepStatus,
          timestamp: msgTimestamp,
          toolName,
          toolCallId,
          durationMs,
        })
      }
    }
  }

  const lastUserMsg = [...messages].reverse().find(
    m => m.role === 'user' && m.metadata?.agentMode
  )
  const rawAgentMode = lastUserMsg?.metadata?.agentMode
  const agentMode = isAgentModeName(rawAgentMode) ? rawAgentMode : undefined

  return {
    agentSteps: agentSteps.length > MAX_AGENT_STEPS ? agentSteps.slice(-MAX_AGENT_STEPS) : agentSteps,
    toolEvents: toolEvents.length > MAX_AGENT_STEPS ? toolEvents.slice(-MAX_AGENT_STEPS) : toolEvents,
    agentMode,
  }
}
