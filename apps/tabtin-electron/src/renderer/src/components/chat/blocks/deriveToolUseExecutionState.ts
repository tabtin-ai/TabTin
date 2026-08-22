import { routeToolUseView } from './toolUseBlockViewLogic'
import { deriveToolUseLifecycleState } from './deriveToolUseLifecycleState'
import type { ContentBlockEntry, SiblingToolResult } from './types'

export function deriveToolUseExecutionState(params: {
  entry: ContentBlockEntry
  toolName: string
  effectiveInput: unknown
  inputFinalized: boolean
  sessionId: string | null
  toolCallId: string
  siblingToolResult?: SiblingToolResult
  storedToolResult?: {
    content?: unknown
    is_error?: boolean
    presentation?: {
      kind: string
      data?: Record<string, unknown>
    }
  }
  lifecycleEvent?: Parameters<typeof deriveToolUseLifecycleState>[0]['lifecycleEvent']
  isStreaming?: boolean
  isLastAssistantMsg?: boolean
  todoSnapshot: unknown[] | undefined
}) {
  const lifecycle = deriveToolUseLifecycleState({
    lifecycleEvent: params.lifecycleEvent,
    siblingToolResult: params.siblingToolResult,
    storedToolResult: params.storedToolResult,
    entryFinalized: params.entry.finalized,
    isStreaming: params.isStreaming,
    isLastAssistantMsg: params.isLastAssistantMsg,
  })
  const viewRoute = routeToolUseView({
    entry: params.entry,
    toolName: params.toolName,
    effectiveInput: params.effectiveInput,
    phase: lifecycle.phase,
    inputFinalized: params.inputFinalized,
    todoSnapshot: params.todoSnapshot,
    sessionId: params.sessionId,
    presentation: lifecycle.presentation,
  })

  return {
    ...lifecycle,
    viewRoute,
  }
}
