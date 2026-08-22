import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TodoPanel } from '../TodoPanel'
import { TodoProgressStrip } from '../TodoProgressStrip'
import type { TodoItem } from '@stores/chat/shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'card.todo') return '待办事项'
      if (key === 'card.todoProgressText') return `${opts?.done}/${opts?.total}`
      if (key === 'card.todoProgressToggleLabel') {
        return `待办事项，已完成 ${opts?.done} / ${opts?.total}`
      }
      if (key === 'card.todoCurrent') return `当前：${opts?.content}`
      if (key === 'card.todoPausedCurrent') return `已暂停：${opts?.content}`
      if (key === 'card.todoAwaitingSubagents') return `等待子任务：${opts?.content}`
      if (key === 'card.todoAllDone') return '待办已完成'
      if (key === 'card.todoOpenDetails') {
        return `查看全部待办，已完成 ${opts?.done} / ${opts?.total}`
      }
      return String(opts?.defaultValue ?? key)
    },
  }),
}))

describe('TodoPanel', () => {
  it('只用完成分数展示待办进度，不再追加百分比文本', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: '整理需求', status: 'completed' },
      { id: 't2', content: '实现 UI', status: 'completed' },
      { id: 't3', content: '补测试', status: 'pending' },
      { id: 't4', content: '废弃步骤', status: 'cancelled' },
    ]

    const { container } = render(<TodoPanel todos={todos} />)

    expect(screen.getByText('2/3')).toBeTruthy()
    expect(container.textContent).not.toContain('67%')
    expect(
      screen.getByRole('button', { name: '待办事项，已完成 2 / 3' }),
    ).toBeTruthy()
  })

  it('父 run awaiting_subagents 时摘要条显示等待子任务而不是已暂停', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: '整理需求', status: 'completed' },
      { id: 't2', content: '等待研究员汇总', status: 'in_progress' },
      { id: 't3', content: '补测试', status: 'pending' },
    ]

    render(<TodoProgressStrip todos={todos} paused awaitingSubagents />)

    expect(screen.getByText('等待子任务：等待研究员汇总')).toBeTruthy()
    expect(screen.queryByText('已暂停：等待研究员汇总')).toBeNull()
  })

  it('Attention Dock 中只展示当前任务，暂停时不保留运行中动效', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: '整理需求', status: 'completed' },
      { id: 't2', content: '实现 UI', status: 'in_progress' },
      { id: 't3', content: '补测试', status: 'pending' },
    ]

    const { container } = render(<TodoProgressStrip todos={todos} paused />)

    expect(screen.getByText('已暂停：实现 UI')).toBeTruthy()
    expect(screen.getByText('1/3')).toBeTruthy()
    expect(screen.queryByText('补测试')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(
      screen.getByRole('button', { name: '查看全部待办，已完成 1 / 3' }),
    ).toBeTruthy()
  })

  it('从摘要条展开后直接展示列表，不再嵌套旧版折叠入口', () => {
    const todos: TodoItem[] = [
      { id: 't1', content: '整理需求', status: 'completed' },
      { id: 't2', content: '实现 UI', status: 'in_progress' },
      { id: 't3', content: '补测试', status: 'pending' },
    ]

    render(<TodoProgressStrip todos={todos} />)
    fireEvent.click(
      screen.getByRole('button', { name: '查看全部待办，已完成 1 / 3' }),
    )

    expect(screen.getByText('补测试')).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: '待办事项，已完成 1 / 3' }),
    ).toBeNull()

    const details = screen.getByTestId('todo-progress-details')
    expect(details.className).toContain(
      'w-[min(32rem,var(--radix-popover-trigger-width))]',
    )
    expect(details.className).toContain(
      'max-w-[var(--radix-popover-content-available-width)]',
    )
  })
})
