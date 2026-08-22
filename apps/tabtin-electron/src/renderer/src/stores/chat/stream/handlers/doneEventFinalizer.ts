import type { ChatMessage } from '@tabtin/chat-client'
import type { UsageReport } from '@tabtin/agent-wire'
import { projectUsageMetadata } from '@tabtin/agent-host/delivery/usage-metadata-projection'
import { useChatStore } from '@/stores/chat/useChatStore'
import { classifyRunTermination } from '../../messages/actions/runTermination'
import {
  markUserMessageDelivered,
  resolveSourceClientEventId,
} from '../../messages/actions/messageStatusUpdates'
import { buildLiveUsageJsonFromDoneUsage } from '../../messages/actions/sendDispatchInputs'
import { consumeAssistantErrorMeta } from './assistantSessionState'
import {
  clearInterruptedBinding,
  getActiveRunBinding,
} from '../../execution/activeRunBinding'

function terminalMessageId(payload: Record<string, unknown>): string | undefined {
  const id = payload.message_id ?? payload.client_event_id
  return typeof id === 'string' && id ? id : undefined
}

function terminalRunId(payload: Record<string, unknown>): string | undefined {
  const id = payload.run_id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function isMainAssistant(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && !(message as ChatMessage & { subagent_run_id?: unknown }).subagent_run_id
}

function findCurrentMainAssistant(
  messages: readonly ChatMessage[],
  messageId: string | undefined,
): ChatMessage | undefined {
  if (messageId) {
    const exact = messages.find((message) => message.id === messageId)
    if (exact && isMainAssistant(exact)) return exact
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') return undefined
    if (isMainAssistant(message)) return message
  }
  return undefined
}

/**
 * ：ABORT 终态只按 message_id / run_id / interrupted 快照定位，
 * **禁止**回落「最后一条 assistant」（插队后会命中新泡）。
 */
function findAbortedAssistant(
  sessionId: string,
  messages: readonly ChatMessage[],
  payload: Record<string, unknown>,
): ChatMessage | undefined {
  const messageId = terminalMessageId(payload)
  if (messageId) {
    const exact = messages.find((message) => message.id === messageId)
    if (exact && isMainAssistant(exact)) return exact
  }

  const binding = getActiveRunBinding(sessionId)
  const interruptedMessageId = binding.interrupted?.messageId
  if (interruptedMessageId) {
    const fromSnap = messages.find((message) => message.id === interruptedMessageId)
    if (fromSnap && isMainAssistant(fromSnap)) return fromSnap
  }

  const runId = terminalRunId(payload) ?? binding.interrupted?.runId ?? undefined
  if (runId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!isMainAssistant(message)) continue
      if (message.agent_run_id === runId) return message
    }
  }

  // 普通 Stop（未插队）：无 interrupted 快照时，允许「当前尾巴」主 assistant。
  // 一旦发生过插队快照，禁止再扫尾（会命中新 turn）。
  if (!binding.interrupted) {
    return findCurrentMainAssistant(messages, undefined)
  }
  return undefined
}

function newTerminalErrorMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `terminal-error-${Date.now().toString(36)}`
}

/**
 * DONE 的消息级收尾——流式终态错误的**唯一**写气泡入口。
 *
 * 非 ABORT 错误：保证恰好一条主助手消息承载 error_info_json / metadata；
 * 无壳时创建空壳再写入。lifecycle / inject 不再造错误气泡。
 */
export function finalizeDoneEvent(
  sessionId: string,
  payload: Record<string, unknown>,
): void {
  const store = useChatStore.getState()
  let messages = store.messagesBySessionId[sessionId] ?? []
  // 仅写入 assistant metadata；清用户 sendStatus 见下方 source_client_event_id
  const traceId = typeof payload.trace_id === 'string' ? payload.trace_id : undefined
  const doneUsage = payload.usage as UsageReport | undefined
  const doneErrorMessage = (
    typeof payload.error_message === 'string'
      ? payload.error_message
      : typeof payload.errorMessage === 'string'
        ? payload.errorMessage
        : undefined
  )
  const doneErrorClass = typeof payload.error_class === 'string' ? payload.error_class : undefined
  const doneSuggestedAction = typeof payload.suggested_action === 'string'
    ? payload.suggested_action
    : undefined
  const doneErrorExtras = (
    payload.error_extras
    ?? (payload.error_metadata as Record<string, unknown> | undefined)?.error_extras
    ?? (payload.error_metadata as Record<string, unknown> | undefined)?.errorExtras
  ) as Record<string, unknown> | undefined
  const assistantErrorMeta = consumeAssistantErrorMeta(sessionId)
  const errorClass = doneErrorClass ?? assistantErrorMeta?.errorClass
  const suggestedAction = doneSuggestedAction ?? assistantErrorMeta?.suggestedAction
  const errorCategory = (
    typeof payload.error_category === 'string'
      ? payload.error_category
      : assistantErrorMeta?.errorCategory
  )
  // ：与 onDone 共用 classifyRunTermination——硬停 / 预算墙属优雅终止，
  // 仍写入 errorClass 供 ErrorClassCard，但不把「仅有 error_class + error:false」
  // 误判成未知红错之外的额外失败语义（isAborted 仅用户主动停）。
  const { isAborted, isGracefulTermination } = classifyRunTermination(
    errorClass,
    doneErrorMessage,
  )
  const hasTerminationSignal = !!(
    payload.error === true
    || errorClass
    || errorCategory
    || doneErrorMessage
  )
  const isErrorMessage = !!assistantErrorMeta?.isErrorMessage
    || (hasTerminationSignal && !isAborted)
  // 有终止信号或费用元数据时都要合并 metadata（优雅终止也要挂 errorClass）。
  const shouldMergeMetadata = hasTerminationSignal
    || isErrorMessage
    || isGracefulTermination
  const costMeta = doneUsage ? projectUsageMetadata(doneUsage) : {}
  const usageJson = doneUsage ? buildLiveUsageJsonFromDoneUsage(doneUsage) : undefined
  const doneBlocks = Array.isArray(payload.blocks_json)
    ? payload.blocks_json as ChatMessage['content_blocks_json']
    : undefined
  const hardStopSource = typeof payload.hard_stop_source === 'string'
    ? payload.hard_stop_source
    : undefined
  // ：只认 source_client_event_id，禁止用 trace_id。
  const sourceClientEventId = resolveSourceClientEventId(payload)
  if (sourceClientEventId) {
    markUserMessageDelivered(sessionId, sourceClientEventId, {
      getMessages: () => messages,
      patchMessageById: store.patchMessageById,
    })
  }

  // ：非用户 abort 的终态错误必须有可见载体；无壳则创建。
  // ABORT 空壳仍可按  隐藏，故不主动造壳。
  const needsVisibleErrorCarrier = hasTerminationSignal && !isAborted
  const currentMessageId = terminalMessageId(payload)
  let assistant = isAborted
    ? findAbortedAssistant(sessionId, messages, payload)
    : findCurrentMainAssistant(messages, currentMessageId)
  if (!assistant && needsVisibleErrorCarrier) {
    const id = currentMessageId ?? newTerminalErrorMessageId()
    store.ensureAssistantMessage(sessionId, {
      id,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
      message_kind: 'llm',
    })
    messages = store.messagesBySessionId[sessionId] ?? []
    assistant = findCurrentMainAssistant(messages, id)
  }

  if (!assistant) {
    if (isAborted) {
      clearInterruptedBinding(sessionId, terminalRunId(payload))
    }
    return
  }

  store.patchMessageById(sessionId, assistant.id, (message) => {
    const metadata = (message.metadata ?? {}) as Record<string, unknown>
    const prevErrorInfo = (
      message.error_info_json
      && typeof message.error_info_json === 'object'
      && !Array.isArray(message.error_info_json)
    ) ? message.error_info_json as Record<string, unknown> : undefined

    const nextErrorInfo = hasTerminationSignal
      ? {
          ...(prevErrorInfo ?? {}),
          ...(errorClass ? { error_class: errorClass } : {}),
          ...(doneErrorMessage && !isAborted ? { error_message: doneErrorMessage } : {}),
          ...(errorCategory ? { category: errorCategory } : {}),
          ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
          partial_reason: isAborted ? 'aborted' : 'message_stop_fallback',
          ...(isAborted ? { aborted: true } : {}),
          ...(doneErrorExtras ? { error_extras: doneErrorExtras } : {}),
        }
      : undefined

    return {
      ...message,
      ...(doneBlocks?.length ? { content_blocks_json: doneBlocks } : {}),
      ...(usageJson ? { usage_json: usageJson } : {}),
      ...(nextErrorInfo ? { error_info_json: nextErrorInfo } : {}),
      ...((shouldMergeMetadata || Object.keys(costMeta).length > 0) ? {
        metadata: {
          ...metadata,
          ...costMeta,
          ...(isErrorMessage ? { isErrorMessage: true } : {}),
          ...(errorCategory ? { errorCategory } : {}),
          ...(errorClass ? { errorClass } : {}),
          // 用户主动停止：不落 runtime 英文兜底（"Run aborted by user."），
          // UI 只用灰色「已中断」徽标表达。
          ...(doneErrorMessage && !isAborted ? { errorMessage: doneErrorMessage } : {}),
          ...(suggestedAction ? { suggestedAction } : {}),
          ...(doneErrorExtras ? { errorExtras: doneErrorExtras } : {}),
          ...(hardStopSource ? { hardStopSource } : {}),
          ...(traceId ? { traceId } : {}),
          ...(isAborted ? { aborted: true } : {}),
        },
      } : {}),
    }
  })

  if (isAborted) {
    clearInterruptedBinding(sessionId, terminalRunId(payload))
  }
}
