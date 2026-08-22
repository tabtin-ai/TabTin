import type { ChatMessage } from '@tabtin/chat-client'
import type { SubagentRun } from '../../../stores/chat/shared/types'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function blockText(block: unknown): string {
  if (!block || typeof block !== 'object') return ''
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

function getBlockPayload(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const maybeEntry = input as { block?: unknown }
  const block = maybeEntry.block && typeof maybeEntry.block === 'object'
    ? maybeEntry.block
    : input
  return block && typeof block === 'object' ? block as Record<string, unknown> : null
}

function isBackgroundSubagentToolBlock(block: Record<string, unknown>): boolean {
  if (block.type !== 'tool_use') return false
  const name = typeof block.name === 'string' ? block.name : ''
  if (name !== 'agent' && name !== 'task') return false
  const input = block.input
  if (!input || typeof input !== 'object') return false
  const rec = input as Record<string, unknown>
  return rec.background === true || rec.run_in_background === true
}

export function subagentMessageText(message: ChatMessage): string {
  const runtimeBlocks = Array.isArray(message.blocks)
    ? message.blocks.map((entry) => blockText(entry.block))
    : []
  const persistedBlocks = Array.isArray(message.content_blocks_json)
    ? message.content_blocks_json.map(blockText)
    : []
  const texts = [...runtimeBlocks, ...persistedBlocks].filter(Boolean)
  return (texts.join('\n') || message.content || '').trim()
}

export function collectBackgroundSubagentToolCallIds(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const candidates = [
      ...(Array.isArray(message.blocks) ? message.blocks : []),
      ...(Array.isArray(message.content_blocks_json) ? message.content_blocks_json : []),
    ]
    for (const candidate of candidates) {
      const block = getBlockPayload(candidate)
      if (!block || !isBackgroundSubagentToolBlock(block)) continue
      const id = typeof block.id === 'string'
        ? block.id
        : typeof (candidate as { block_id?: unknown }).block_id === 'string'
          ? (candidate as { block_id: string }).block_id
          : undefined
      if (id) ids.add(id)
    }
  }
  return ids
}

function taskMessageId(subagentRunId: string, parentToolCallId?: string): string {
  return `subagent-task:${subagentRunId}:${parentToolCallId ?? 'initial'}`
}

function hasTaskMessage(messages: readonly ChatMessage[], input: {
  task: string
  messageId: string
}): boolean {
  const normalizedTask = input.task.trim()
  if (!normalizedTask) return true
  return messages.some((message) => (
    message.id === input.messageId
    || (
      message.role === 'user'
      && !String(message.id ?? '').startsWith('subagent-task:')
      && subagentMessageText(message) === normalizedTask
    )
  ))
}

function syntheticTaskMessage(input: {
  subagentRunId: string
  parentToolCallId?: string
  task: string
  createdAt: string
  pinFirst: boolean
}): ChatMessage {
  return {
    id: taskMessageId(input.subagentRunId, input.parentToolCallId),
    role: 'user',
    content: input.task,
    content_blocks_json: [{ type: 'text', text: input.task }],
    created_at: input.createdAt,
    metadata: input.pinFirst ? { _timeline_pin_first: true } : undefined,
  }
}

function cloneTaskMessageBefore(message: ChatMessage, before: ChatMessage): ChatMessage {
  const beforeTs = Date.parse(before.created_at)
  if (!Number.isFinite(beforeTs)) return message
  return {
    ...message,
    created_at: new Date(Math.max(0, beforeTs - 1)).toISOString(),
  }
}

function insertTaskMessageBeforeSummary(
  messages: readonly ChatMessage[],
  taskMessage: ChatMessage,
  summary?: string,
): ChatMessage[] | null {
  const normalizedSummary = summary?.trim()
  if (!normalizedSummary) return null
  const insertAt = messages.findIndex((message) => (
    message.role === 'assistant'
    && subagentMessageText(message).includes(normalizedSummary)
  ))
  if (insertAt < 0) return null
  const positionedTaskMessage = cloneTaskMessageBefore(taskMessage, messages[insertAt])
  return [
    ...messages.slice(0, insertAt),
    positionedTaskMessage,
    ...messages.slice(insertAt),
  ]
}

function insertTaskMessageByTime(messages: readonly ChatMessage[], taskMessage: ChatMessage, startedAt?: number): ChatMessage[] {
  if (!startedAt) return [...messages, taskMessage]
  const insertAt = messages.findIndex((message) => {
    const ts = Date.parse(message.created_at)
    return Number.isFinite(ts) && ts >= startedAt
  })
  if (insertAt < 0) return [...messages, taskMessage]
  return [
    ...messages.slice(0, insertAt),
    taskMessage,
    ...messages.slice(insertAt),
  ]
}

export function buildSubagentVisibleMessages(input: {
  messages: readonly ChatMessage[]
  taskRuns: readonly SubagentRun[]
  subagentRunId: string
}): ChatMessage[] {
  let base = [...input.messages]
  input.taskRuns.forEach((taskRun, index) => {
    const task = taskRun.task?.trim()
    const messageId = taskMessageId(input.subagentRunId, taskRun.parentToolCallId)
    if (!task || hasTaskMessage(base, { task, messageId })) return

    const hasAnyUserMessage = base.some((message) => message.role === 'user')
    const taskMessage = syntheticTaskMessage({
      subagentRunId: input.subagentRunId,
      parentToolCallId: taskRun.parentToolCallId,
      task,
      createdAt: taskRun.startedAt ? new Date(taskRun.startedAt).toISOString() : (base[0]?.created_at ?? new Date().toISOString()),
      pinFirst: index === 0 && !hasAnyUserMessage,
    })
    if (index === 0) {
      base = hasAnyUserMessage
        ? insertTaskMessageByTime(base, taskMessage, taskRun.startedAt)
        : [taskMessage, ...base]
      return
    }

    base = insertTaskMessageBeforeSummary(base, taskMessage, taskRun.summary)
      ?? insertTaskMessageByTime(base, taskMessage, taskRun.startedAt)
  })
  return base
}

function isTerminalStatus(status: SubagentRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function hasSubagentCompletionNotification(
  messages: readonly ChatMessage[],
  subagentRunId: string,
): boolean {
  return messages.some((message) => {
    const content = message.content ?? ''
    return /<task-notification\b[^>]*kind\s*=\s*["']subagent-completed["'][^>]*>/i.test(content)
      && content.includes(`<subagent-run-id>${subagentRunId}</subagent-run-id>`)
  })
}

function syntheticSubagentCompletionMessage(input: {
  ownerRunId: string
  run: SubagentRun
}): ChatMessage {
  const { ownerRunId, run } = input
  const label = run.label || run.role || run.task || '子 Agent'
  const durationMs = run.stats?.duration_ms ?? run.elapsedMs
  const lines = [
    'A background sub-agent finished while you were doing other work:',
    '',
    '<task-notification kind="subagent-completed">',
    `<subagent-run-id>${escapeXml(run.subagentRunId)}</subagent-run-id>`,
    `<label>${escapeXml(label)}</label>`,
    `<status>${escapeXml(run.status)}</status>`,
    ...(Number.isFinite(durationMs) ? [`<duration-ms>${Math.max(0, Math.round(durationMs ?? 0))}</duration-ms>`] : []),
    ...(run.parentToolCallId ? [`<parent-tool-call-id>${escapeXml(run.parentToolCallId)}</parent-tool-call-id>`] : []),
    ...(run.summary ? [`<summary>${escapeXml(run.summary)}</summary>`] : []),
    '</task-notification>',
  ]
  const createdAt = new Date(run.endedAt || run.startedAt || Date.now()).toISOString()
  return {
    id: `subagent-completion:${ownerRunId}:${run.subagentRunId}`,
    role: 'user',
    content: lines.join('\n'),
    content_blocks_json: [{ type: 'text', text: lines.join('\n') }],
    created_at: createdAt,
    subagent_run_id: ownerRunId,
    agent_run_id: ownerRunId,
    metadata: {
      triggered_by: 'push-notification',
      synthetic: 'nested_subagent_completion',
    },
  } as ChatMessage
}

export function appendNestedSubagentCompletionNotifications(input: {
  messages: readonly ChatMessage[]
  descendantRuns: readonly SubagentRun[]
  subagentRunId: string
}): ChatMessage[] {
  const additions = input.descendantRuns
    .filter((run) => run.background === true && isTerminalStatus(run.status))
    .filter((run) => !hasSubagentCompletionNotification(input.messages, run.subagentRunId))
    .map((run) => syntheticSubagentCompletionMessage({ ownerRunId: input.subagentRunId, run }))

  if (additions.length === 0) return [...input.messages]

  return [...input.messages, ...additions]
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
}
