/**
 * TodoCard · 失败 / 被拒绝态不得把入参 todos 当"已创建"渲染
 *
 * 回归背景：`todo` 是 panel-only 工具，待办真正落库只在执行成功
 * （phase='end'）时经 setTodosForSession 写入输入区 docked 面板。
 * 但 `ToolUseBlockView` 的 panel-only 早退条件是 `phase !== 'error'`，
 * 拒绝态（用户点"拒绝"→ phase='error'）会落到 TodoCard；旧实现在 error 态
 * 仍从 **input** 画 todos，导致"拒绝创建待办后还是会创建、且状态永不更新"
 * （input 快照被误当结果）。
 *
 * 本测试锁死：error 态绝不渲染入参 todos 文本；成功态照常渲染。
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// 模拟 prod build：ErrorBanner 在非 DEBUG 下返回 null（错误交给 Agent 处置）。
vi.mock('@/utils/featureFlags', () => ({
  DEBUG_PANELS_ENABLED: false,
  BUILD_PROFILE: 'production',
  IS_PREPROD_BUILD: false,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}))

import { TodoCardRenderer } from '../TodoCard'

const TODOS = [
  { id: 't1', content: '并行调用3个子代理报数', status: 'in_progress' },
  { id: 't2', content: '汇总子代理报数结果并汇报', status: 'pending' },
]

describe('TodoCard · error/被拒绝态', () => {
  it('phase=error（用户拒绝）→ 不渲染入参 todos（不再"还是会创建"）', () => {
    render(
      <TodoCardRenderer
        id="todo-1"
        toolName="todo"
        phase="error"
        input={{ action: 'open', items: TODOS }}
        output={'<tool_use_error>\nkind: permission_denied\ntool: todo\nUser denied tool \'todo\'.\n</tool_use_error>'}
      />,
    )

    expect(screen.queryByText('并行调用3个子代理报数')).toBeNull()
    expect(screen.queryByText('汇总子代理报数结果并汇报')).toBeNull()
  })

  it('phase=error + jsonError envelope → 同样不渲染入参 todos', () => {
    render(
      <TodoCardRenderer
        id="todo-2"
        toolName="todo"
        phase="error"
        input={{ action: 'open', items: TODOS }}
        output={JSON.stringify({ success: false, error: 'At most one task can be in_progress at a time' })}
      />,
    )

    expect(screen.queryByText('并行调用3个子代理报数')).toBeNull()
  })

  it('phase=end（成功）→ 照常渲染 todos（不回归）', () => {
    render(
      <TodoCardRenderer
        id="todo-3"
        toolName="todo"
        phase="end"
        input={{ action: 'open', items: TODOS }}
        output={JSON.stringify({ success: true, todos: TODOS })}
      />,
    )

    expect(screen.getByText('并行调用3个子代理报数')).toBeTruthy()
    expect(screen.getByText('汇总子代理报数结果并汇报')).toBeTruthy()
  })
})
