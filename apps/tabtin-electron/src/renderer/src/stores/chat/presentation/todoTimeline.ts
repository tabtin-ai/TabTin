/**
 * todoTimeline —— 待办清单的**纯派生视图**。
 *
 * 单一数据源 = `message.blocks` 里的 `todo` tool_use。按 action 状态机重放。
 * React hook 见 `useTodoTimeline.ts`。本文件刻意不依赖 chat store / helpers，
 * 以便单测可独立加载。
 *
 * 提交边界与 runtime `todo-replay` 对齐：配对 `tool_result.is_error` 的
 * tool_use 不入账，避免失败 open 画出幽灵「1/3」面板。
 *
 * 排序契约：全有 `arrival_seq` 才按 seq；任一缺失则全体按
 * encounter。禁止「有 seq 优先于无 seq」造成收尾批与开批双出口。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { applyTodoAction, type TodoListState } from '@tabtin/agent-runtime/todo'
import type { TodoItem } from '../shared/types'

export interface TodoCompletedGroup {
  anchorToolCallId: string
  todos: TodoItem[]
}

export interface TodoTimeline {
  activeTodos: TodoItem[]
  completedGroups: TodoCompletedGroup[]
  anchorMap: Map<string, TodoItem[]>
}

type BlockEntry = {
  block_id?: string
  pendingInputJson?: string
  block?: {
    type?: string
    name?: string
    id?: string
    input?: unknown
    tool_use_id?: string
    is_error?: boolean
    arrival_seq?: number
  } | null
}

function extractTodoAction(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const kwargs = typeof obj.kwargs === 'object' && obj.kwargs ? (obj.kwargs as Record<string, unknown>) : null
  const args = kwargs ?? obj
  const action = args.action
  if (
    action !== 'open' &&
    action !== 'add' &&
    action !== 'update' &&
    action !== 'remove' &&
    action !== 'close'
  ) {
    return null
  }
  return args
}

function resolveTodoAction(entry: BlockEntry): Record<string, unknown> | null {
  const block = entry.block
  if (!block || block.type !== 'tool_use' || block.name !== 'todo') return null
  const fromInput = extractTodoAction(block.input)
  if (fromInput) return fromInput
  const pending = entry.pendingInputJson?.trim()
  if (!pending) return null
  try {
    return extractTodoAction(JSON.parse(pending))
  } catch {
    return null
  }
}

const NANOSECOND_SCALE_THRESHOLD = 1e16

function readBlockArrivalSeq(block: BlockEntry['block']): number | null {
  if (!block) return null
  const raw = block.arrival_seq
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return raw >= NANOSECOND_SCALE_THRESHOLD ? Math.floor(raw / 1000) : raw
}

interface TodoActionEvent {
  anchorId: string
  seq: number | null
  encounter: number
  input: Record<string, unknown>
}

/** 收集失败的 todo tool_use id（assistant / user 消息上的 tool_result）。 */
function collectFailedTodoIds(messages: readonly ChatMessage[]): Set<string> {
  const todoIds = new Set<string>()
  const failed = new Set<string>()

  for (const msg of messages) {
    if (msg.subagent_run_id) continue
    const blocks = (msg.blocks as BlockEntry[] | undefined) ?? []
    for (const entry of blocks) {
      const block = entry.block
      if (!block) continue
      if (block.type === 'tool_use' && block.name === 'todo' && block.id) {
        todoIds.add(block.id)
      }
    }
  }

  for (const msg of messages) {
    if (msg.subagent_run_id) continue
    const blocks = (msg.blocks as BlockEntry[] | undefined) ?? []
    for (const entry of blocks) {
      const block = entry.block
      if (!block || block.type !== 'tool_result' || !block.is_error) continue
      const toolUseId = block.tool_use_id
      if (toolUseId && todoIds.has(toolUseId)) failed.add(toolUseId)
    }
  }

  return failed
}

export function deriveTodoTimeline(messages: readonly ChatMessage[]): TodoTimeline {
  const failedIds = collectFailedTodoIds(messages)
  const byId = new Map<string, TodoActionEvent>()
  let encounter = 0
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (msg.subagent_run_id) continue
    const blocks = (msg.blocks as BlockEntry[] | undefined) ?? []
    for (const entry of blocks) {
      const block = entry.block
      if (!block || block.type !== 'tool_use' || block.name !== 'todo') continue
      const input = resolveTodoAction(entry)
      if (!input) continue
      const anchorId = block.id ?? entry.block_id
      if (!anchorId) continue
      if (failedIds.has(anchorId)) continue
      const seq = readBlockArrivalSeq(block)
      const next: TodoActionEvent = { anchorId, seq, encounter: encounter++, input }
      const prev = byId.get(anchorId)
      if (!prev) {
        byId.set(anchorId, next)
        continue
      }
      const prevSeq = prev.seq
      const takeNext = seq !== null && prevSeq !== null
        ? seq >= prevSeq
        : seq !== null || prevSeq === null
      if (takeNext) byId.set(anchorId, { ...next, encounter: prev.encounter })
    }
  }

  // 统一排序契约：全有 seq 才按 seq；任一缺失则全体按
  // encounter。禁止「有 seq 优先于无 seq」——那会把早期开批沉底，收尾批先
  // settle 后再被 merge=false/open 顶成双出口（完成卡 + 底栏未完成）。
  const events = Array.from(byId.values())
  const allHaveSeq = events.every((e) => e.seq !== null)
  const ordered = events.sort((a, b) => {
    if (allHaveSeq) return (a.seq as number) - (b.seq as number) || a.encounter - b.encounter
    return a.encounter - b.encounter
  })

  const completedGroups: TodoCompletedGroup[] = []
  let state: TodoListState = { open: null }

  for (const { anchorId, input } of ordered) {
    const result = applyTodoAction(state, input)
    if (!result.ok) continue
    state = result.state
    if (result.closed) {
      completedGroups.push({
        anchorToolCallId: anchorId,
        todos: result.snapshot as TodoItem[],
      })
    }
  }

  const activeTodos: TodoItem[] = state.open ? (state.open as TodoItem[]) : []
  const anchorMap = new Map<string, TodoItem[]>()
  for (const g of completedGroups) anchorMap.set(g.anchorToolCallId, g.todos)

  return { activeTodos, completedGroups, anchorMap }
}
