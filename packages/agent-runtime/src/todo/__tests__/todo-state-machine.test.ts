import { describe, expect, it } from 'vitest'
import {
  applyTodoAction,
  TODO_ITEM_FROZEN,
  TODO_INVALID_ITEMS,
  TODO_LIST_ALREADY_OPEN,
  TODO_LIST_NOT_OPEN,
  type TodoListState,
} from '../todo-state-machine.js'

const empty: TodoListState = { open: null }

describe('applyTodoAction', () => {
  it('open 无 items → 失败', () => {
    const r = applyTodoAction(empty, { action: 'open', items: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error_kind).toBe(TODO_INVALID_ITEMS)
  })

  it('open 带 items → 进入 open', () => {
    const r = applyTodoAction(empty, {
      action: 'open',
      items: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.closed).toBe(false)
      expect(r.state.open?.map((t) => t.id)).toEqual(['a', 'b'])
    }
  })

  it('open 不允许初始 paused，paused 只能由 update 表达真实阻塞', () => {
    const r = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'oauth', content: '等待授权', status: 'paused' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error_kind).toBe(TODO_INVALID_ITEMS)
  })

  it('已有 open 再 open → TODO_LIST_ALREADY_OPEN', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'a', content: 'A', status: 'pending' }],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const r = applyTodoAction(opened.state, {
      action: 'open',
      items: [{ id: 'x', content: 'X', status: 'pending' }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error_kind).toBe(TODO_LIST_ALREADY_OPEN)
  })

  it('completed 项不可 update/remove', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [
        { id: 'a', content: 'A', status: 'completed' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const upd = applyTodoAction(opened.state, {
      action: 'update',
      id: 'a',
      status: 'in_progress',
    })
    expect(upd.ok).toBe(false)
    if (!upd.ok) expect(upd.error_kind).toBe(TODO_ITEM_FROZEN)

    const rem = applyTodoAction(opened.state, { action: 'remove', id: 'a' })
    expect(rem.ok).toBe(false)
    if (!rem.ok) expect(rem.error_kind).toBe(TODO_ITEM_FROZEN)
  })

  it('全完成自动 close', () => {
    let state: TodoListState = empty
    const open = applyTodoAction(state, {
      action: 'open',
      items: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
    })
    expect(open.ok).toBe(true)
    if (!open.ok) return
    state = open.state

    const u1 = applyTodoAction(state, { action: 'update', id: 'a', status: 'completed' })
    expect(u1.ok).toBe(true)
    if (!u1.ok) return
    expect(u1.closed).toBe(false)
    state = u1.state

    const u2 = applyTodoAction(state, {
      action: 'update',
      id: 'b',
      status: 'completed',
    })
    expect(u2.ok).toBe(true)
    if (!u2.ok) return
    expect(u2.closed).toBe(true)
    expect(u2.state.open).toBeNull()
  })

  it('显式 close 未完成变 cancelled，可再 open', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [
        { id: 'a', content: 'A', status: 'in_progress' },
        { id: 'b', content: 'B', status: 'pending' },
      ],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const closed = applyTodoAction(opened.state, { action: 'close' })
    expect(closed.ok).toBe(true)
    if (!closed.ok) return
    expect(closed.closed).toBe(true)
    expect(closed.snapshot.every((t) => t.status === 'cancelled')).toBe(true)
    expect(closed.state.open).toBeNull()

    const again = applyTodoAction(closed.state, {
      action: 'open',
      items: [{ id: 'c', content: 'C', status: 'pending' }],
    })
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.state.open?.map((t) => t.id)).toEqual(['c'])
  })

  it('无 open 时 update → TODO_LIST_NOT_OPEN', () => {
    const r = applyTodoAction(empty, { action: 'update', id: 'a', status: 'completed' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error_kind).toBe(TODO_LIST_NOT_OPEN)
  })

  it('add 可追加新项', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'a', content: 'A', status: 'pending' }],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const added = applyTodoAction(opened.state, {
      action: 'add',
      item: { id: 'b', content: 'B' },
    })
    expect(added.ok).toBe(true)
    if (added.ok) expect(added.snapshot.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('add 不允许直接追加 paused 项', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'a', content: 'A', status: 'pending' }],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const added = applyTodoAction(opened.state, {
      action: 'add',
      item: { id: 'blocked', content: '等待授权', status: 'paused' },
    })
    expect(added.ok).toBe(false)
    if (!added.ok) expect(added.error_kind).toBe(TODO_INVALID_ITEMS)
  })

  it('阻塞等待时可把当前项更新为 paused，列表保持 open', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'oauth', content: '等待授权', status: 'in_progress' }],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const paused = applyTodoAction(opened.state, {
      action: 'update',
      id: 'oauth',
      status: 'paused',
      content: '等待用户完成 OAuth 授权后回复已授权',
    })
    expect(paused.ok).toBe(true)
    if (!paused.ok) return
    expect(paused.closed).toBe(false)
    expect(paused.state.open?.[0]?.status).toBe('paused')
  })

  it('有 paused 阻塞项时不允许 add 另一个 in_progress', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [{ id: 'oauth', content: '等待授权', status: 'in_progress' }],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const paused = applyTodoAction(opened.state, {
      action: 'update',
      id: 'oauth',
      status: 'paused',
      content: '等待用户完成 OAuth 授权后回复已授权',
    })
    expect(paused.ok).toBe(true)
    if (!paused.ok) return

    const added = applyTodoAction(paused.state, {
      action: 'add',
      item: { id: 'next', content: '继续后续任务', status: 'in_progress' },
    })
    expect(added.ok).toBe(false)
    if (!added.ok) {
      expect(added.error_kind).toBe('invalid_param_format')
      expect(added.message).toContain('paused')
    }
  })

  it('有 paused 阻塞项时不允许 update 其他项为 in_progress，但允许恢复 paused 项', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [
        { id: 'oauth', content: '等待授权', status: 'in_progress' },
        { id: 'next', content: '继续后续任务', status: 'pending' },
      ],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const paused = applyTodoAction(opened.state, {
      action: 'update',
      id: 'oauth',
      status: 'paused',
      content: '等待用户完成 OAuth 授权后回复已授权',
    })
    expect(paused.ok).toBe(true)
    if (!paused.ok) return

    const startOther = applyTodoAction(paused.state, {
      action: 'update',
      id: 'next',
      status: 'in_progress',
    })
    expect(startOther.ok).toBe(false)
    if (!startOther.ok) expect(startOther.error_kind).toBe('invalid_param_format')

    const resumePaused = applyTodoAction(paused.state, {
      action: 'update',
      id: 'oauth',
      status: 'in_progress',
      content: 'OAuth 已授权，继续处理',
    })
    expect(resumePaused.ok).toBe(true)
    if (resumePaused.ok) {
      expect(resumePaused.state.open?.find((t) => t.id === 'oauth')?.status).toBe('in_progress')
      expect(resumePaused.state.open?.find((t) => t.id === 'next')?.status).toBe('pending')
    }
  })

  it('不允许多个 paused 后恢复其中一个形成 paused + in_progress', () => {
    const opened = applyTodoAction(empty, {
      action: 'open',
      items: [
        { id: 'a', content: '等待 A', status: 'in_progress' },
        { id: 'b', content: '等待 B', status: 'pending' },
      ],
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return

    const pauseA = applyTodoAction(opened.state, {
      action: 'update',
      id: 'a',
      status: 'paused',
      content: '等待 A 解除阻塞',
    })
    expect(pauseA.ok).toBe(true)
    if (!pauseA.ok) return

    const pauseB = applyTodoAction(pauseA.state, {
      action: 'update',
      id: 'b',
      status: 'paused',
      content: '等待 B 解除阻塞',
    })
    expect(pauseB.ok).toBe(false)
    if (!pauseB.ok) {
      expect(pauseB.error_kind).toBe('invalid_param_format')
      expect(pauseB.message).toContain('paused')
    }

    const resumeA = applyTodoAction(pauseA.state, {
      action: 'update',
      id: 'a',
      status: 'in_progress',
      content: 'A 已解除阻塞，继续处理',
    })
    expect(resumeA.ok).toBe(true)
    if (resumeA.ok) {
      expect(resumeA.state.open?.map((t) => `${t.id}:${t.status}`)).toEqual([
        'a:in_progress',
        'b:pending',
      ])
    }
  })
})
