import type { ContentBlock, Message } from '../engine/contracts/conversation.js'
import type { Tool, ToolContext, ToolResult } from '../engine/contracts/tools.js'
import { jsonError } from '../capability/core/_utils.js'
import {
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NO_UI_SESSION,
} from '../engine/errors/error-kinds.js'

export const SHOW_FLOW_VIEW_TOOL_NAME = 'show_flow_view'
const MAX_NODES = 100

type FlowNodeStatus = 'pending' | 'active' | 'complete' | 'blocked' | 'skipped'

interface FlowNode {
  id: string
  parent_id?: string
  label: string
  detail?: string
  status: FlowNodeStatus
}

interface FlowViewInput {
  loading_message?: string
  title: string
  summary: string
  nodes: FlowNode[]
}

let usedToolUseBlocks = new WeakSet<ContentBlock>()

const inputSchema = {
  type: 'object',
  properties: {
    loading_message: { type: 'string', description: '流式生成期间显示的简短进度。' },
    title: { type: 'string', description: '流程视图标题。' },
    summary: { type: 'string', description: '无障碍与旧客户端使用的简短摘要。' },
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_NODES,
      description: '按输出顺序渐进展示的扁平流程节点；父节点应先于子节点。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '本视图内唯一的稳定节点标识。' },
          parent_id: { type: 'string', description: '可选父节点标识；根节点省略。' },
          label: { type: 'string', description: '节点短标题。' },
          detail: { type: 'string', description: '可选补充说明。' },
          status: {
            type: 'string',
            enum: ['pending', 'active', 'complete', 'blocked', 'skipped'],
            description: '节点状态。',
          },
        },
        required: ['id', 'label'],
      },
    },
  },
  required: ['title', 'summary', 'nodes'],
} as unknown as Tool['inputSchema']

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

type ValidationResult<T> = { value: T; error?: never } | { value?: never; error: ToolResult }

function readInputEnvelope(input: unknown): ValidationResult<{
  raw: Record<string, unknown>
  title: string
  summary: string
  rawNodes: unknown[]
}> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: jsonError('show_flow_view requires an object input', { error_kind: INVALID_PARAM_FORMAT }) }
  }
  const raw = input as Record<string, unknown>
  const title = readText(raw.title)
  const summary = readText(raw.summary)
  if (!title || !summary || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    return {
      error: jsonError('title, summary, and a non-empty nodes array are required', {
        error_kind: MISSING_REQUIRED_PARAM,
        hint: 'Pass 1-100 nodes. Put each parent before its children.',
      }),
    }
  }
  if (raw.nodes.length > MAX_NODES) {
    return { error: jsonError(`nodes exceeds the ${MAX_NODES} item limit`, { error_kind: INVALID_PARAM_FORMAT }) }
  }
  return { value: { raw, title, summary, rawNodes: raw.nodes } }
}

function normalizeNodes(rawNodes: unknown[]): ValidationResult<FlowNode[]> {
  const nodes: FlowNode[] = []
  const ids = new Set<string>()
  const statuses = new Set<FlowNodeStatus>(['pending', 'active', 'complete', 'blocked', 'skipped'])
  for (let index = 0; index < rawNodes.length; index += 1) {
    const item = rawNodes[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: jsonError(`nodes[${index}] must be an object`, { error_kind: INVALID_PARAM_FORMAT }) }
    }
    const node = item as Record<string, unknown>
    const id = readText(node.id)
    const label = readText(node.label)
    if (!id || !label) {
      return { error: jsonError(`nodes[${index}] requires id and label`, { error_kind: MISSING_REQUIRED_PARAM }) }
    }
    if (ids.has(id)) {
      return { error: jsonError(`duplicate node id: ${id}`, { error_kind: INVALID_PARAM_FORMAT }) }
    }
    ids.add(id)
    const parentId = readText(node.parent_id) || undefined
    const status = statuses.has(node.status as FlowNodeStatus) ? node.status as FlowNodeStatus : 'pending'
    nodes.push({
      id,
      label,
      status,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(readText(node.detail) ? { detail: readText(node.detail) } : {}),
    })
  }
  return { value: nodes }
}

function validateGraph(nodes: FlowNode[]): ToolResult | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.parent_id && !byId.has(node.parent_id)) {
      return jsonError(`missing parent node: ${node.parent_id}`, { error_kind: INVALID_PARAM_FORMAT })
    }
    const visited = new Set([node.id])
    let parentId = node.parent_id
    while (parentId) {
      if (visited.has(parentId)) {
        return jsonError(`cycle detected at node: ${node.id}`, { error_kind: INVALID_PARAM_FORMAT })
      }
      visited.add(parentId)
      parentId = byId.get(parentId)?.parent_id
    }
  }
  const positions = new Map(nodes.map((node, index) => [node.id, index]))
  for (const [index, node] of nodes.entries()) {
    if (node.parent_id && (positions.get(node.parent_id) ?? Number.POSITIVE_INFINITY) >= index) {
      return jsonError(`parent node must appear before child: ${node.id}`, {
        error_kind: INVALID_PARAM_FORMAT,
        hint: 'Order nodes from roots to leaves so streaming can reveal the hierarchy progressively.',
      })
    }
  }
  return undefined
}

function validateInput(input: unknown): ValidationResult<FlowViewInput> {
  const envelope = readInputEnvelope(input)
  if (!envelope.value) return envelope
  const normalized = normalizeNodes(envelope.value.rawNodes)
  if (!normalized.value) return normalized
  const graphError = validateGraph(normalized.value)
  if (graphError) return { error: graphError }

  return {
    value: {
      title: envelope.value.title,
      summary: envelope.value.summary,
      nodes: normalized.value,
      ...(readText(envelope.value.raw.loading_message)
        ? { loading_message: readText(envelope.value.raw.loading_message) }
        : {}),
    },
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildFallbackHtml(input: FlowViewInput): string {
  const children = new Map<string | undefined, FlowNode[]>()
  for (const node of input.nodes) {
    const siblings = children.get(node.parent_id) ?? []
    siblings.push(node)
    children.set(node.parent_id, siblings)
  }
  const render = (parentId?: string): string => {
    const nodes = children.get(parentId) ?? []
    if (nodes.length === 0) return ''
    return `<ol>${nodes.map((node) => `<li><strong>${escapeHtml(node.label)}</strong>${node.detail ? `<p>${escapeHtml(node.detail)}</p>` : ''}${render(node.id)}</li>`).join('')}</ol>`
  }
  return `<section><h3>${escapeHtml(input.title)}</h3>${render()}</section>`
}

function findToolCallId(messages: Message[] | undefined, title: string): string | undefined {
  if (!messages) return undefined
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const blocks = message.content as ContentBlock[]
    const exact = blocks.find((block) => {
      if (block.type !== 'tool_use' || block.name !== SHOW_FLOW_VIEW_TOOL_NAME) return false
      if (usedToolUseBlocks.has(block)) return false
      const input = block.input as Record<string, unknown> | null
      return !!input && readText(input.title) === title
    })
    if (exact?.type === 'tool_use') {
      usedToolUseBlocks.add(exact)
      return exact.id
    }
    const fallback = blocks.find(
      (block) => block.type === 'tool_use'
        && block.name === SHOW_FLOW_VIEW_TOOL_NAME
        && !usedToolUseBlocks.has(block),
    )
    if (fallback?.type === 'tool_use') {
      usedToolUseBlocks.add(fallback)
      return fallback.id
    }
    break
  }
  return undefined
}

export function __resetShowFlowViewUsedRefsForTests(): void {
  usedToolUseBlocks = new WeakSet<ContentBlock>()
}

function generateWidgetId(): string {
  return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * @deprecated Flow View 已从默认 Agent Chat 工具集下架。仅为已发布调用方的
 * API 兼容和历史消息重放保留；新代码不得把它注册回 Agent Chat。
 * 新的飞书画板流程只在 TabDoc 导入时降级为静态文本树。
 */
export function createShowFlowViewTool(): Tool {
  return {
    name: SHOW_FLOW_VIEW_TOOL_NAME,
    policyActionKind: 'object_read',
    description:
      '已弃用的 Flow View 兼容工具，仅为旧调用方保留；不得注册到 Agent Chat 默认工具集。' +
      '新的飞书画板流程随 TabDoc 导入并显示为静态文本树。',
    inputSchema,
    isReadOnly: false,
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const validated = validateInput(input)
      if (!validated.value) return validated.error as ToolResult
      const params = validated.value
      if (!context.emitRichContentBlock) {
        return jsonError('show_flow_view requires a connected UI session', {
          error_kind: NO_UI_SESSION,
          hint: 'Describe the flow in plain text when no UI session is available.',
        })
      }

      const widgetId = generateWidgetId()
      const toolCallId = findToolCallId(context.messages, params.title)
      const payload: Record<string, unknown> = {
        widget_id: widgetId,
        widget_variant: 'flow_view',
        format: 'html',
        code: buildFallbackHtml(params),
        flow_view: { version: 1, title: params.title, nodes: params.nodes },
        ...(params.loading_message ? { loading_message: params.loading_message } : {}),
        ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      }
      context.emitRichContentBlock({ kind: 'widget', summary: params.summary, payload })

      return {
        content: JSON.stringify({
          success: true,
          widget_id: widgetId,
          summary: params.summary,
          llm_message: 'Flow view rendered successfully. Continue with the next step.',
          _block: {
            type: 'tabtin_rich_content',
            kind: 'widget',
            summary: params.summary,
            ...payload,
          },
        }),
        llmStripKeys: ['_block'],
      }
    },
  }
}
