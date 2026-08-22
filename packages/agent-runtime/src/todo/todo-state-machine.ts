/**
 * Todo 列表生命周期状态机。
 *
 * 同时最多一份 open 列表；completed 项冻结；全完成自动 close；
 * paused 项保持 open，供解除阻塞后恢复并最终 completed；
 * 显式 close 将剩余未完成项标为 cancelled。
 */

export const TODO_LIST_ALREADY_OPEN = 'todo_list_already_open' as const
export const TODO_LIST_NOT_OPEN = 'todo_list_not_open' as const
export const TODO_ITEM_FROZEN = 'todo_item_frozen' as const
export const TODO_INVALID_ITEMS = 'todo_invalid_items' as const

export type TodoItemStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  content: string
  status: TodoItemStatus
}

export interface TodoListState {
  /** 当前未关闭列表；null 表示无 open 列表。 */
  open: TodoItem[] | null
}

export type TodoActionName = 'open' | 'add' | 'update' | 'remove' | 'close'

export interface TodoToolInput {
  action: TodoActionName
  items?: unknown
  item?: unknown
  id?: unknown
  content?: unknown
  status?: unknown
}

export interface TodoApplySuccess {
  ok: true
  state: TodoListState
  /** 本次操作后的列表快照（close 后仍为关闭瞬间的全量）。 */
  snapshot: TodoItem[]
  closed: boolean
  action: TodoActionName
}

export interface TodoApplyFailure {
  ok: false
  error_kind:
    | typeof TODO_LIST_ALREADY_OPEN
    | typeof TODO_LIST_NOT_OPEN
    | typeof TODO_ITEM_FROZEN
    | typeof TODO_INVALID_ITEMS
    | 'missing_required_param'
    | 'invalid_param_format'
  message: string
  hint?: string
  field?: string
}

export type TodoApplyResult = TodoApplySuccess | TodoApplyFailure

const VALID_STATUSES = new Set<string>(['pending', 'in_progress', 'paused', 'completed', 'cancelled'])
const ADDABLE_STATUSES = new Set<string>(['pending', 'in_progress'])

function isSettled(todos: readonly TodoItem[]): boolean {
  if (todos.length === 0) return false
  return todos.every((t) => t.status === 'completed' || t.status === 'cancelled')
}

function parseItem(raw: unknown, opts?: { allowCompleted?: boolean; allowPaused?: boolean }): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  if (typeof o.content !== 'string' || !o.content.trim()) return null
  if (typeof o.status !== 'string' || !VALID_STATUSES.has(o.status)) return null
  if (!opts?.allowCompleted && o.status === 'completed') return null
  if (opts?.allowPaused === false && o.status === 'paused') return null
  return { id: o.id, content: o.content, status: o.status as TodoItemStatus }
}

function parseItems(raw: unknown): TodoItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const items: TodoItem[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const item = parseItem(entry, { allowCompleted: true, allowPaused: false })
    if (!item) return null
    if (seen.has(item.id)) return null
    seen.add(item.id)
    items.push(item)
  }
  if (items.filter((t) => t.status === 'in_progress').length > 1) return null
  return items
}

function cloneOpen(open: TodoItem[]): TodoItem[] {
  return open.map((t) => ({ ...t }))
}

function maybeAutoClose(open: TodoItem[]): { open: TodoItem[] | null; closed: boolean; snapshot: TodoItem[] } {
  if (isSettled(open)) {
    return { open: null, closed: true, snapshot: open }
  }
  return { open, closed: false, snapshot: open }
}

function hasPausedTodo(open: readonly TodoItem[], exceptIndex?: number): boolean {
  return open.some((t, i) => i !== exceptIndex && t.status === 'paused')
}

function hasInProgressTodo(open: readonly TodoItem[], exceptIndex?: number): boolean {
  return open.some((t, i) => i !== exceptIndex && t.status === 'in_progress')
}

function fail(
  error_kind: TodoApplyFailure['error_kind'],
  message: string,
  extra?: { hint?: string; field?: string },
): TodoApplyFailure {
  return { ok: false, error_kind, message, ...extra }
}

/**
 * 对当前列表状态应用一次 todo 工具入参。纯函数、无副作用。
 */
export function applyTodoAction(state: TodoListState, input: unknown): TodoApplyResult {
  if (!input || typeof input !== 'object') {
    return fail('missing_required_param', 'todo input must be an object', {
      field: 'action',
      hint: 'Pass action as one of: open, add, update, remove, close.',
    })
  }
  const raw = input as TodoToolInput
  const action = raw.action
  if (
    action !== 'open' &&
    action !== 'add' &&
    action !== 'update' &&
    action !== 'remove' &&
    action !== 'close'
  ) {
    return fail('invalid_param_format', `Invalid action "${String(action)}"`, {
      field: 'action',
      hint: 'Use action: open | add | update | remove | close.',
    })
  }

  switch (action) {
    case 'open':
      return applyOpen(state, raw.items)
    case 'add':
      return applyAdd(state, raw.item)
    case 'update':
      return applyUpdate(state, raw)
    case 'remove':
      return applyRemove(state, raw.id)
    case 'close':
      return applyClose(state)
  }
}

function applyOpen(state: TodoListState, itemsRaw: unknown): TodoApplyResult {
  if (state.open !== null) {
    return fail(TODO_LIST_ALREADY_OPEN, 'A todo list is already open', {
      hint: 'Call todo(action="close") before opening a new list.',
    })
  }
  const items = parseItems(itemsRaw)
  if (!items) {
    return fail(TODO_INVALID_ITEMS, 'open requires a non-empty items[] with unique ids', {
      field: 'items',
      hint: 'Pass items: [{ id, content, status }, ...] with at most one in_progress. Use update(status="paused") after a real blocking condition is found.',
    })
  }
  const next = maybeAutoClose(items)
  return {
    ok: true,
    action: 'open',
    state: { open: next.open },
    snapshot: next.snapshot,
    closed: next.closed,
  }
}

function requireOpen(state: TodoListState): TodoApplyFailure | TodoItem[] {
  if (state.open === null) {
    return fail(TODO_LIST_NOT_OPEN, 'No open todo list', {
      hint: 'Call todo(action="open", items=[...]) first.',
    })
  }
  return state.open
}

function applyAdd(state: TodoListState, itemRaw: unknown): TodoApplyResult {
  const openOrErr = requireOpen(state)
  if (!Array.isArray(openOrErr)) return openOrErr

  if (!itemRaw || typeof itemRaw !== 'object') {
    return fail(TODO_INVALID_ITEMS, 'add requires item with id and content', {
      field: 'item',
    })
  }
  const rawItem = itemRaw as Record<string, unknown>
  const statusRaw = rawItem.status === undefined ? 'pending' : rawItem.status
  const item = parseItem({ ...rawItem, status: statusRaw }, { allowCompleted: false, allowPaused: false })
  if (!item || !ADDABLE_STATUSES.has(item.status)) {
    return fail(TODO_INVALID_ITEMS, 'add requires item with id, content, and pending|in_progress status', {
      field: 'item',
      hint: 'Do not add items already completed or paused; use update(status="paused") after a real blocking condition is found.',
    })
  }
  if (openOrErr.some((t) => t.id === item.id)) {
    return fail(TODO_INVALID_ITEMS, `Todo id "${item.id}" already exists`, {
      field: 'item.id',
      hint: 'Use update for existing ids, or pick a new id.',
    })
  }
  const open = cloneOpen(openOrErr)
  if (item.status === 'in_progress' && open.some((t) => t.status === 'in_progress')) {
    return fail('invalid_param_format', 'At most one task can be in_progress', {
      field: 'item.status',
    })
  }
  if (item.status === 'in_progress' && hasPausedTodo(open)) {
    return fail('invalid_param_format', 'Cannot start another task while a paused task is still blocked', {
      field: 'item.status',
      hint: 'Resume or complete the paused task before starting another in_progress item.',
    })
  }
  open.push(item)
  const next = maybeAutoClose(open)
  return { ok: true, action: 'add', state: { open: next.open }, snapshot: next.snapshot, closed: next.closed }
}

function applyUpdate(state: TodoListState, raw: TodoToolInput): TodoApplyResult {
  const openOrErr = requireOpen(state)
  if (!Array.isArray(openOrErr)) return openOrErr

  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    return fail('missing_required_param', 'update requires id', { field: 'id' })
  }
  const hasContent = typeof raw.content === 'string'
  const hasStatus = typeof raw.status === 'string'
  if (!hasContent && !hasStatus) {
    return fail('missing_required_param', 'update requires content and/or status', {
      field: 'content',
      hint: 'Provide at least one of content or status.',
    })
  }
  if (hasStatus && !VALID_STATUSES.has(raw.status as string)) {
    return fail('invalid_param_format', `Invalid status "${String(raw.status)}"`, { field: 'status' })
  }

  const open = cloneOpen(openOrErr)
  const idx = open.findIndex((t) => t.id === raw.id)
  if (idx < 0) {
    return fail(TODO_INVALID_ITEMS, `Todo id "${raw.id}" not found`, {
      field: 'id',
      hint: 'Use an id from the current open list.',
    })
  }
  const current = open[idx]!
  if (current.status === 'completed') {
    return fail(TODO_ITEM_FROZEN, `Todo "${raw.id}" is completed and cannot be modified`, {
      hint: 'Completed items are frozen. Add a new item or close and open a new list.',
    })
  }

  const nextStatus = hasStatus ? (raw.status as TodoItemStatus) : current.status
  const nextContent = hasContent ? (raw.content as string) : current.content
  if (!nextContent.trim()) {
    return fail(TODO_INVALID_ITEMS, 'content cannot be empty', { field: 'content' })
  }
  if (
    nextStatus === 'in_progress' &&
    open.some((t, i) => i !== idx && t.status === 'in_progress')
  ) {
    return fail('invalid_param_format', 'At most one task can be in_progress', {
      field: 'status',
    })
  }
  if (nextStatus === 'in_progress' && hasPausedTodo(open, idx)) {
    return fail('invalid_param_format', 'Cannot start another task while a paused task is still blocked', {
      field: 'status',
      hint: 'Resume or complete the paused task before starting another in_progress item.',
    })
  }
  if (nextStatus === 'paused' && hasPausedTodo(open, idx)) {
    return fail('invalid_param_format', 'Cannot pause another task while a paused task is still blocked', {
      field: 'status',
      hint: 'Resume or complete the paused task before pausing another item.',
    })
  }
  if (nextStatus === 'paused' && hasInProgressTodo(open, idx)) {
    return fail('invalid_param_format', 'Cannot pause a task while another task is in_progress', {
      field: 'status',
      hint: 'Only the currently blocking task should be paused.',
    })
  }
  open[idx] = { id: current.id, content: nextContent, status: nextStatus }
  const next = maybeAutoClose(open)
  return { ok: true, action: 'update', state: { open: next.open }, snapshot: next.snapshot, closed: next.closed }
}

function applyRemove(state: TodoListState, idRaw: unknown): TodoApplyResult {
  const openOrErr = requireOpen(state)
  if (!Array.isArray(openOrErr)) return openOrErr

  if (typeof idRaw !== 'string' || !idRaw.trim()) {
    return fail('missing_required_param', 'remove requires id', { field: 'id' })
  }
  const current = openOrErr.find((t) => t.id === idRaw)
  if (!current) {
    return fail(TODO_INVALID_ITEMS, `Todo id "${idRaw}" not found`, { field: 'id' })
  }
  if (current.status === 'completed') {
    return fail(TODO_ITEM_FROZEN, `Todo "${idRaw}" is completed and cannot be removed`, {
      hint: 'Completed items stay until the list is closed.',
    })
  }
  const open = openOrErr.filter((t) => t.id !== idRaw)
  if (open.length === 0) {
    // 删光未完成项后若只剩空列表——视为 close（无项可展示）
    return { ok: true, action: 'remove', state: { open: null }, snapshot: [], closed: true }
  }
  const next = maybeAutoClose(open)
  return { ok: true, action: 'remove', state: { open: next.open }, snapshot: next.snapshot, closed: next.closed }
}

function applyClose(state: TodoListState): TodoApplyResult {
  const openOrErr = requireOpen(state)
  if (!Array.isArray(openOrErr)) return openOrErr

  const snapshot = cloneOpen(openOrErr).map((t) =>
    t.status === 'pending' || t.status === 'in_progress' || t.status === 'paused'
      ? { ...t, status: 'cancelled' as const }
      : t,
  )
  return {
    ok: true,
    action: 'close',
    state: { open: null },
    snapshot,
    closed: true,
  }
}

/** 从消息历史重放 todo tool_use，得到当前列表状态与最后关闭快照。 */
export function replayTodoActions(
  actions: ReadonlyArray<{ input: unknown }>,
  seedOpen?: readonly TodoItem[] | null,
): {
  state: TodoListState
  lastClosedSnapshot: TodoItem[] | null
} {
  let state: TodoListState = {
    open: seedOpen ? seedOpen.map((t) => ({ ...t })) : null,
  }
  let lastClosedSnapshot: TodoItem[] | null = null
  for (const { input } of actions) {
    const result = applyTodoAction(state, input)
    if (!result.ok) continue
    state = result.state
    if (result.closed) lastClosedSnapshot = result.snapshot
  }
  return { state, lastClosedSnapshot }
}
