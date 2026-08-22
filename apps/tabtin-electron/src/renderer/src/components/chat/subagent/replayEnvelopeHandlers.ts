/**
 * Subagent replay envelope 事件 handler（从 applyEnvelopeEvent 拆分）。
 */

import type { ChatMessage, MessageBlock } from '@tabtin/chat-client'

export interface EnvelopeLine {
  type?: string
  timestamp?: string
  payload?: {
    message_id?: string
    role?: 'user' | 'assistant' | 'system'
    index?: number
    arrival_seq?: number
    model_id?: string | null
    model_name?: string | null
    message_kind?: string
    started_at?: string
    usage?: Record<string, unknown>
    error_info_json?: Record<string, unknown>
    block?: {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }
    delta?: {
      type?: string
      text?: string
      thinking?: string
      partial_json?: string
      stop_reason?: string | null
    }
  }
}

export interface AccumulatingBlock extends MessageBlock {
  _partialJson?: string
  _finalized?: boolean
  _replayIndex?: number
}

export interface ReplayState {
  messagesById: Map<string, ChatMessage>
  messagesOrder: string[]
}

export type ReplayHandlerContext = {
  state: ReplayState
  line: EnvelopeLine
  messageId: string
  payload: NonNullable<EnvelopeLine['payload']>
  mapEnvelopeBlockToMessageBlock: (
    envBlock: NonNullable<NonNullable<EnvelopeLine['payload']>['block']>,
  ) => AccumulatingBlock
  appendToolResultBlock: (
    state: ReplayState,
    envBlock: NonNullable<NonNullable<EnvelopeLine['payload']>['block']>,
    arrivalSeq: number | undefined,
    arrivedAt: string,
  ) => void
  stampArrival: (block: AccumulatingBlock, arrivalSeq: number | undefined, arrivedAt: string) => void
}

function handleMessageStart(ctx: ReplayHandlerContext): void {
  const { state, line, messageId, payload } = ctx
  if (state.messagesById.has(messageId)) return
  const message: ChatMessage = {
    id: messageId,
    role: payload.role ?? 'assistant',
    content: '',
    content_blocks_json: [],
    created_at: payload.started_at ?? line.timestamp ?? new Date().toISOString(),
    ...(payload.model_id !== undefined ? { model_id: payload.model_id } : {}),
    ...(payload.model_name !== undefined ? { model_name: payload.model_name } : {}),
    ...(typeof payload.message_kind === 'string'
      ? { message_kind: payload.message_kind as ChatMessage['message_kind'] }
      : {}),
  }
  state.messagesById.set(messageId, message)
  state.messagesOrder.push(messageId)
}

function handleMessageDelta(ctx: ReplayHandlerContext): void {
  const { state, messageId, payload } = ctx
  const msg = state.messagesById.get(messageId)
  if (!msg) return
  const stopReason = payload.delta?.stop_reason
  if (stopReason != null) msg.stop_reason = stopReason
  if (payload.usage) msg.usage_json = payload.usage
  if (payload.error_info_json) msg.error_info_json = payload.error_info_json
}

function handleContentBlockStart(ctx: ReplayHandlerContext): void {
  const { state, line, messageId, payload } = ctx
  const msg = state.messagesById.get(messageId)
  if (!msg?.content_blocks_json) return
  const envBlock = payload.block
  if (!envBlock) return
  const arrivalSeq = line.payload?.arrival_seq
  const arrivedAt = line.timestamp ?? new Date().toISOString()
  if (envBlock.type === 'tool_result') {
    ctx.appendToolResultBlock(state, envBlock, arrivalSeq, arrivedAt)
    return
  }
  const replayIndex = typeof payload.index === 'number' ? payload.index : msg.content_blocks_json.length
  const newBlock = ctx.mapEnvelopeBlockToMessageBlock(envBlock)
  newBlock._replayIndex = replayIndex
  ctx.stampArrival(newBlock, arrivalSeq, arrivedAt)
  const existingIndex = msg.content_blocks_json.findIndex(
    block => (block as AccumulatingBlock | undefined)?._replayIndex === replayIndex,
  )
  if (existingIndex >= 0) {
    msg.content_blocks_json[existingIndex] = newBlock
  } else {
    msg.content_blocks_json.push(newBlock)
  }
}

function handleContentBlockDelta(ctx: ReplayHandlerContext): void {
  const { state, messageId, payload } = ctx
  const msg = state.messagesById.get(messageId)
  if (!msg?.content_blocks_json) return
  const index = typeof payload.index === 'number' ? payload.index : -1
  const block = msg.content_blocks_json.find(
    b => (b as AccumulatingBlock | undefined)?._replayIndex === index,
  ) as AccumulatingBlock | undefined
  if (!block) return
  const delta = payload.delta
  if (!delta?.type) return
  if (delta.type === 'thinking_delta' && block.type === 'thinking') {
    block.thinking = (block.thinking ?? '') + (delta.thinking ?? '')
  } else if (delta.type === 'text_delta' && block.type === 'text') {
    block.text = (block.text ?? '') + (delta.text ?? '')
  } else if (delta.type === 'input_json_delta' && (block.type as string) === 'tool_use') {
    block._partialJson = (block._partialJson ?? '') + (delta.partial_json ?? '')
  }
}

function handleContentBlockStop(ctx: ReplayHandlerContext): void {
  const { state, messageId, payload } = ctx
  const msg = state.messagesById.get(messageId)
  if (!msg?.content_blocks_json) return
  const index = typeof payload.index === 'number' ? payload.index : -1
  const block = msg.content_blocks_json.find(
    b => (b as AccumulatingBlock | undefined)?._replayIndex === index,
  ) as AccumulatingBlock | undefined
  if (!block) return
  block._finalized = true
  if (block._partialJson != null) {
    try {
      ;(block as MessageBlock).input = JSON.parse(block._partialJson)
    } catch {
      ;(block as MessageBlock).input = block._partialJson
    }
    delete block._partialJson
  }
}

const REPLAY_EVENT_HANDLERS: Record<string, (ctx: ReplayHandlerContext) => void> = {
  'agent.stream.message_start': handleMessageStart,
  'agent.stream.message_delta': handleMessageDelta,
  'agent.stream.content_block_start': handleContentBlockStart,
  'agent.stream.content_block_delta': handleContentBlockDelta,
  'agent.stream.content_block_stop': handleContentBlockStop,
}

export function applyReplayEnvelopeEventWithHandlers(
  ctx: ReplayHandlerContext,
): void {
  const handler = REPLAY_EVENT_HANDLERS[ctx.line.type ?? '']
  if (handler) handler(ctx)
}
