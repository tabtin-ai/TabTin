import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatInputStatusBanners } from '../ChatInputStatusBanners'
import type { SubagentRun, TodoItem } from '@stores/chat/shared/types'

const mockState = vi.hoisted(() => ({
  currentSessionId: 'session-1',
  runtime: {
    runStateBySessionId: {} as Record<string, { suspended?: boolean }>,
    subagentRunsBySessionId: {} as Record<string, SubagentRun[]>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'card.todoProgressText') return `${opts?.done}/${opts?.total}`
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

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { currentSessionId: string | null }) => unknown) =>
    selector({ currentSessionId: mockState.currentSessionId }),
}))

vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (state: typeof mockState.runtime) => unknown) =>
    selector(mockState.runtime),
}))

const todos: TodoItem[] = [
  { id: 'todo-1', content: '整理需求', status: 'completed' },
  { id: 'todo-2', content: '等待研究员汇总', status: 'in_progress' },
]

function renderBanner() {
  render(<ChatInputStatusBanners sessionTodos={todos} isStreaming={false} />)
}

describe('ChatInputStatusBanners', () => {
  beforeEach(() => {
    mockState.currentSessionId = 'session-1'
    mockState.runtime.runStateBySessionId = {}
    mockState.runtime.subagentRunsBySessionId = {}
  })

  it.each(['pending', 'queued', 'running'] as const)(
    '父 run 已结束但仍有 %s 子任务时，待办条显示等待子任务',
    (status) => {
      mockState.runtime.subagentRunsBySessionId = {
        'session-1': [{ subagentRunId: 'child-1', status } as SubagentRun],
      }

      renderBanner()

      expect(screen.getByText('等待子任务：等待研究员汇总')).toBeTruthy()
      expect(screen.queryByText('已暂停：等待研究员汇总')).toBeNull()
    },
  )

  it('断连挂起但没有 active 子任务时，待办条仍显示已暂停', () => {
    mockState.runtime.runStateBySessionId = {
      'session-1': { suspended: true },
    }

    renderBanner()

    expect(screen.getByText('已暂停：等待研究员汇总')).toBeTruthy()
    expect(screen.queryByText('等待子任务：等待研究员汇总')).toBeNull()
  })
})
