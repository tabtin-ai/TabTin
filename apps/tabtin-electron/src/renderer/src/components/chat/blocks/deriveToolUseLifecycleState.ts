import {
  buildLifecycleProgressSnapshot,
  deriveToolUsePhase,
  isErrorLikeToolOutput,
  resolveToolOutput,
} from './toolUseBlockViewLogic'
import type { SiblingToolResult } from './types'
import type { ToolPresentation } from '@stores/chat/shared/types'

type LifecycleEvent = {
  phase?: 'start' | 'running' | 'end' | 'error'
  output?: unknown
  durationMs?: number
  startedAt?: number
  presentation?: ToolPresentation
  intent?: string
  progress?: {
    stdout?: string
    outputBytes?: number
    truncated?: boolean
    sessionId?: string
    pid?: number | null
    outputFile?: string
    command?: string
  }
}

function isLifecycleTerminalPhase(phase: LifecycleEvent['phase']): boolean {
  return phase === 'end' || phase === 'error'
}

function resolveIsErrorResult(params: {
  siblingToolResult?: SiblingToolResult
  storedToolResult?: { is_error?: boolean }
  decodedOutput: unknown
  hasTerminalResult: boolean
}): boolean {
  if (!params.hasTerminalResult) return false
  return params.siblingToolResult?.isError === true
    || params.storedToolResult?.is_error === true
    || isErrorLikeToolOutput(params.decodedOutput)
}

export function deriveToolUseLifecycleState(params: {
  lifecycleEvent?: LifecycleEvent
  siblingToolResult?: SiblingToolResult
  storedToolResult?: {
    content?: unknown
    is_error?: boolean
    presentation?: ToolPresentation
  }
  entryFinalized: boolean
  isStreaming?: boolean
  isLastAssistantMsg?: boolean
}) {
  const lifecycleTerminalPhase = isLifecycleTerminalPhase(params.lifecycleEvent?.phase)
  const lifecycleFinalOutput = lifecycleTerminalPhase ? params.lifecycleEvent?.output : undefined
  const lifecycleDurationMs = lifecycleTerminalPhase ? params.lifecycleEvent?.durationMs : undefined
  const lifecycleProgressSnapshot = buildLifecycleProgressSnapshot(
    lifecycleFinalOutput,
    params.lifecycleEvent?.progress,
  )
  const lifecycleToolOutput = lifecycleFinalOutput ?? lifecycleProgressSnapshot
  const decodedOutput = resolveToolOutput({
    siblingToolResult: params.siblingToolResult,
    storedToolResultContent: params.storedToolResult?.content,
    lifecycleToolOutput,
  })
  const hasTerminalResult = Boolean(
    params.siblingToolResult || params.storedToolResult || lifecycleTerminalPhase,
  )
  const isErrorResult = resolveIsErrorResult({
    siblingToolResult: params.siblingToolResult,
    storedToolResult: params.storedToolResult,
    decodedOutput,
    hasTerminalResult,
  })
  const isIntentAvailableBeforeStart = Boolean(
    params.lifecycleEvent?.phase === 'start'
    && params.lifecycleEvent.intent
    && params.lifecycleEvent.startedAt === undefined,
  )
  const phase = isIntentAvailableBeforeStart
    ? 'start'
    : deriveToolUsePhase({
        lifecycleEventPhase: params.lifecycleEvent?.phase,
        isErrorResult,
        hasTerminalResult,
        entryFinalized: params.entryFinalized,
        liveExecutingWindow: Boolean(params.isStreaming && params.isLastAssistantMsg),
      })
  const presentation = params.lifecycleEvent?.presentation
    ?? params.siblingToolResult?.presentation
    ?? params.storedToolResult?.presentation

  return {
    phase,
    decodedOutput,
    lifecycleDurationMs,
    lifecycleStartedAt: params.lifecycleEvent?.startedAt,
    presentation,
    intent: params.lifecycleEvent?.intent,
  }
}
