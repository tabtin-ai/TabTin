/**
 * 从落库 content_blocks_json 抽出 AdminDash「本轮运行诊断」需要的思考 / 工具过程。
 * 兼容 Anthropic 原生块与老 tool_call / thinking.content 形态。
 */

import type { ThreadOverviewMessage } from '@/types/agent-debug'

export interface ProcessThinkingStep {
  kind: 'thinking' | 'redacted_thinking'
  text: string
  durationMs: number | null
}

export interface ProcessToolStep {
  id: string
  name: string
  input: unknown
  result: string | null
  isError: boolean
}

export interface MessageProcessView {
  thinkingSteps: ProcessThinkingStep[]
  toolSteps: ProcessToolStep[]
  /** 从 text 块拼出的全文；overview 的 text_summary 可能被截断 */
  textFromBlocks: string
}

type LooseBlock = Record<string, unknown>

function asRecord(value: unknown): LooseBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as LooseBlock
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringifyToolPayload(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function extractThinkingText(block: LooseBlock): string {
  return (
    asString(block.thinking) ||
    asString(block.content) ||
    asString(block.text) ||
    ''
  ).trim()
}

function extractDurationMs(block: LooseBlock): number | null {
  return (
    asNumber(block.duration_ms) ??
    asNumber(block.durationMs) ??
    asNumber(block.thinking_duration_ms)
  )
}

function extractToolResultText(block: LooseBlock): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part)
        if (!record) return stringifyToolPayload(part)
        return asString(record.text) || asString(record.content) || stringifyToolPayload(part)
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content != null) return stringifyToolPayload(content)
  return asString(block.output) || asString(block.result) || ''
}

/** 汇总某 trace 下消息的 content_blocks（供运行诊断展示）。 */
export function collectContentBlocksForTrace(
  messages: ThreadOverviewMessage[] | null | undefined,
  traceId: string | null | undefined
): unknown[] {
  if (!messages?.length || !traceId) return []
  const blocks: unknown[] = []
  for (const message of messages) {
    if (message.trace_id !== traceId) continue
    if (!Array.isArray(message.content_blocks_json)) continue
    blocks.push(...message.content_blocks_json)
  }
  return blocks
}

/** 是否含可展示的思考 / 工具过程块。 */
export function hasProcessContentBlocks(blocks: unknown[] | null | undefined): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0) return false
  return blocks.some((raw) => {
    const block = asRecord(raw)
    if (!block) return false
    const type = asString(block.type)
    return (
      type === 'thinking' ||
      type === 'redacted_thinking' ||
      type === 'tool_use' ||
      type === 'tool_call' ||
      type === 'tool_result' ||
      type === 'server_tool_use' ||
      type === 'mcp_tool_use' ||
      type === 'mcp_tool_result'
    )
  })
}

export function buildMessageProcessView(
  blocks: unknown[] | null | undefined
): MessageProcessView {
  const empty: MessageProcessView = {
    thinkingSteps: [],
    toolSteps: [],
    textFromBlocks: '',
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return empty

  const thinkingSteps: ProcessThinkingStep[] = []
  const toolSteps: ProcessToolStep[] = []
  const toolById = new Map<string, ProcessToolStep>()
  const textParts: string[] = []

  for (const [index, raw] of blocks.entries()) {
    const block = asRecord(raw)
    if (!block) continue
    const type = asString(block.type)

    if (type === 'thinking') {
      const text = extractThinkingText(block)
      if (!text) continue
      thinkingSteps.push({
        kind: 'thinking',
        text,
        durationMs: extractDurationMs(block),
      })
      continue
    }

    if (type === 'redacted_thinking') {
      thinkingSteps.push({
        kind: 'redacted_thinking',
        text: '推理内容已加密，无法展示正文',
        durationMs: extractDurationMs(block),
      })
      continue
    }

    if (type === 'text') {
      const text = (asString(block.text) || asString(block.content) || '').trim()
      if (text) textParts.push(text)
      continue
    }

    if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
      const id =
        asString(block.id) ||
        asString(block.tool_use_id) ||
        asString(block.block_id) ||
        `tool-${index}`
      const name = asString(block.name) || asString(block.tool_name) || 'unknown_tool'
      const step: ProcessToolStep = {
        id,
        name,
        input: block.input ?? block.args ?? {},
        result: null,
        isError: false,
      }
      toolSteps.push(step)
      toolById.set(id, step)
      continue
    }

    if (type === 'tool_call') {
      const id =
        asString(block.id) ||
        asString(block.tool_call_id) ||
        asString(block.block_id) ||
        `tool-call-${index}`
      const name = asString(block.name) || asString(block.tool_name) || 'unknown_tool'
      const output =
        block.output ?? block.result ?? block.content
      const step: ProcessToolStep = {
        id,
        name,
        input: block.input ?? block.args ?? block.data ?? {},
        result: output == null ? null : stringifyToolPayload(output),
        isError: Boolean(block.is_error || block.error),
      }
      toolSteps.push(step)
      toolById.set(id, step)
      continue
    }

    if (type === 'tool_result' || type === 'mcp_tool_result') {
      const toolUseId =
        asString(block.tool_use_id) ||
        asString(block.tool_call_id) ||
        asString(block.id)
      const resultText = extractToolResultText(block)
      const isError = Boolean(block.is_error)
      if (toolUseId && toolById.has(toolUseId)) {
        const existing = toolById.get(toolUseId)!
        existing.result = resultText
        existing.isError = isError
      } else {
        const step: ProcessToolStep = {
          id: toolUseId || `tool-result-${index}`,
          name: asString(block.name) || 'tool_result',
          input: {},
          result: resultText,
          isError,
        }
        toolSteps.push(step)
        if (toolUseId) toolById.set(toolUseId, step)
      }
    }
  }

  return {
    thinkingSteps,
    toolSteps,
    textFromBlocks: textParts.join('\n\n').trim(),
  }
}

export function formatThinkingDuration(durationMs: number | null): string | null {
  if (durationMs == null || durationMs < 0) return null
  const seconds = durationMs / 1000
  if (seconds < 10) return `${seconds.toFixed(1)} 秒`
  return `${Math.round(seconds)} 秒`
}
