import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ToolStepCard } from '../ToolStepCard'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? key),
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async importOriginal => ({
  ...(await importOriginal<typeof import('@tabtin/smartsheet-ui')>()),
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className} data-testid="scroll-area">
      {children}
    </div>
  ),
}))

vi.mock('../../cards', () => ({}))

// 折叠行「后台」徽标只需判定函数；mock 掉真实 TerminalCard 模块避免拉入重依赖
// （真实判定逻辑在 TerminalCard.test.tsx 的 isBackgroundTerminalTask 纯函数用例覆盖）。
vi.mock('../../cards/TerminalCard', () => ({
  isBackgroundTerminalTask: (input: unknown, output: unknown) => {
    const inner = ((input as { kwargs?: Record<string, unknown> })?.kwargs ?? input) as Record<string, unknown> | undefined
    if (inner?.wait_ms === 0) return true
    const o = (output ?? {}) as Record<string, unknown>
    return o.backgrounded === true || o.status === 'running'
  },
}))

vi.mock('../../registry/iconMap', () => ({
  resolveIcon: () => function MockIcon({ className }: { className?: string }) {
    return <svg className={className} data-testid="mock-tool-icon" />
  },
}))

vi.mock('../../registry/toolCardRegistry', () => ({
  getToolDescriptor: (toolName: string) => {
    if (toolName === 'edit_file' || toolName === 'apply_patch') {
      return {
        id: 'diff',
        category: 'tool',
        labelKey: 'chat.card.diff',
        icon: 'FilePenLine',
        riskLevel: 'strict',
        defaultCollapsed: false,
        renderer: 'DiffCard',
      }
    }
    if (toolName === 'run_terminal_command') {
      return {
        id: 'terminal',
        category: 'tool',
        labelKey: 'chat.card.terminal',
        icon: 'Terminal',
        riskLevel: 'strict',
        defaultCollapsed: false,
        renderer: 'TerminalCard',
      }
    }
    return {
      id: 'generic',
      category: 'tool',
      labelKey: `chat.card.${toolName}`,
      icon: 'Wrench',
      riskLevel: 'review',
      defaultCollapsed: false,
      renderer: 'GenericToolCard',
    }
  },
  getToolLabelKey: (toolName: string) => (
    toolName === 'edit_file' ? 'chat.card.diff' : `chat.card.${toolName}`
  ),
  getCompactSummary: (toolName: string, input: unknown) => {
    if (toolName === 'summary_tool') return 'Fetch current document content'
    if (toolName === 'run_terminal_command') {
      const args = input && typeof input === 'object' ? input as Record<string, unknown> : {}
      return typeof args.command === 'string' ? args.command : null
    }
    return null
  },
  extractToolOutput: (_toolName: string, output: unknown) => (
    typeof output === 'string' ? null : output
  ),
  getToolRenderer: () => 'GenericToolCard',
}))

vi.mock('../../registry/cardRenderers', () => ({
  registerCardRenderer: vi.fn(),
  getCardRenderer: (name: string) => {
    if (name === 'DiffCard') {
      return function MockDiffCard() {
        return <div data-testid="mock-diff-card">calculator.html</div>
      }
    }
    return function MockGenericToolCard() {
      return <div data-testid="mock-generic-tool-card">generic body</div>
    }
  },
}))

describe('ToolStepCard', () => {
  it('工具输出返回前保留稳定的工具摘要行', () => {
    render(
      <ToolStepCard
        id="read-intent-1"
        toolName="read_file"
        phase="start"
        inputFinalized={false}
        input={{}}
        intent="读取项目配置"
      />,
    )

    expect(screen.getByText('读取项目配置')).toBeTruthy()
  })

  it('参数已完整时优先显示具体操作对象，intent 仅作兜底', () => {
    render(
      <ToolStepCard
        id="search-intent-1"
        toolName="summary_tool"
        phase="start"
        inputFinalized
        input={{ search_term: '亿信人形机器人产品型号' }}
        intent="调研各厂商人形机器人产品线"
      />,
    )

    expect(screen.getByText('Fetch current document content')).toBeTruthy()
    expect(screen.queryByText('调研各厂商人形机器人产品线')).toBeNull()
  })

  it('run_terminal_command 参数已完整时仍优先显示 runtime intent，而不是命令', () => {
    render(
      <ToolStepCard
        id="terminal-intent-1"
        toolName="run_terminal_command"
        phase="start"
        inputFinalized
        input={{ command: 'git status --short' }}
        intent="检查工作区状态"
      />,
    )

    expect(screen.getByText('检查工作区状态')).toBeTruthy()
    expect(screen.queryByText('git status --short')).toBeNull()
  })

  it('apply_patch 完成态文本结果不会遮蔽 input 中的结构化 diff', () => {
    const { container } = render(
      <ToolStepCard
        id="patch-1"
        toolName="apply_patch"
        phase="end"
        input={{ changes: { 'src/a.ts': { unified_diff: '@@ -1 +1 @@\n-old\n+new' } } }}
        output="apply_patch 成功"
      />,
    )

    fireEvent.click(container.querySelector('button[aria-expanded="false"]')!)
    expect(screen.getByTestId('mock-diff-card')).toBeTruthy()
  })

  it('DiffCard 默认折叠，并在折叠行显示单次改动统计', () => {
    const { container } = render(
      <ToolStepCard
        id="edit-1"
        toolName="edit_file"
        phase="end"
        input={{ path: '/tmp/calculator.html' }}
        output={{
          kind: 'diff',
          file: '/tmp/calculator.html',
          start_line: 1,
          end_line: 1,
          old_lines: ['old'],
          new_lines: ['new'],
        }}
      />,
    )

    expect(screen.queryByTestId('mock-diff-card')).toBeNull()
    expect(screen.getByTestId('tool-step-diff-stats').textContent).toBe('+1-1')
    const toggle = container.querySelector('button[aria-expanded="false"]')
    expect(toggle).toBeTruthy()
    fireEvent.click(toggle!)
    expect(screen.getByTestId('mock-diff-card')).toBeTruthy()
    expect(container.querySelector('button[aria-expanded="true"]')).toBeTruthy()
  })

  it('apply_patch 多 hunk 汇总全部新增和删除行数', () => {
    render(
      <ToolStepCard
        id="patch-multi-hunk"
        toolName="apply_patch"
        phase="end"
        output={{
          kind: 'diff',
          file: 'src/a.ts',
          start_line: 1,
          end_line: 8,
          old_lines: ['old'],
          new_lines: ['new'],
          replacements: 2,
          hunks: [
            { old_lines: ['old-1'], new_lines: ['new-1', 'new-2'] },
            { old_lines: ['old-2', 'old-3'], new_lines: ['new-3'] },
          ],
        }}
      />,
    )

    expect(screen.getByTestId('tool-step-diff-stats').textContent).toBe('+3-3')
    expect(screen.queryByTestId('mock-diff-card')).toBeNull()
  })

  it('耗时 0ms 在展开的 diff 卡底部显示 <1ms', () => {
    const { container } = render(
      <ToolStepCard
        id="edit-0ms"
        toolName="edit_file"
        phase="end"
        durationMs={0}
        input={{ path: '/tmp/calculator.html' }}
        output={{
          kind: 'diff',
          file: '/tmp/calculator.html',
          start_line: 1,
          end_line: 1,
          old_lines: ['old'],
          new_lines: ['new'],
        }}
      />,
    )

    fireEvent.click(container.querySelector('button[aria-expanded="false"]')!)
    expect(screen.getByText(/<1ms/)).toBeTruthy()
    expect(screen.queryByText(/0ms/)).toBeNull()
  })

  it('普通工具成功后默认折叠，只保留 ToolStepCard 的标题行', () => {
    const { container } = render(
      <ToolStepCard
        id="tool-1"
        toolName="future_tool"
        phase="end"
        input={{ query: 'hello' }}
        output={{ ok: true }}
      />,
    )

    expect(screen.queryByTestId('mock-generic-tool-card')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
    expect(screen.getByText('Tool')).toBeTruthy()
    expect(screen.queryByText('future_tool')).toBeNull()
  })

  it('有 compactSummary 时折叠行只显示摘要（不再并排次要工具名）', () => {
    const { container } = render(
      <ToolStepCard
        id="tool-summary"
        toolName="summary_tool"
        phase="end"
        input={{ query: 'hello' }}
        output={{ ok: true }}
      />,
    )

    expect(screen.getByText('Fetch current document content')).toBeTruthy()
    expect(screen.getByTestId('mock-tool-icon')).toBeTruthy()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
  })

  it('运行中保留工具 icon，状态文案扫光，无 Loader2', () => {
    const { container, rerender } = render(
      <ToolStepCard
        id="tool-running"
        toolName="future_tool"
        phase="start"
        input={{ query: 'hello' }}
      />,
    )

    expect(screen.getByTestId('mock-tool-icon')).toBeTruthy()
    expect(screen.getByTestId('tool-step-status-hint').getAttribute('data-status')).toBe('calling')
    expect(container.querySelector('.animate-spin')).toBeNull()

    rerender(
      <ToolStepCard
        id="tool-running"
        toolName="future_tool"
        phase="running"
        input={{ query: 'hello' }}
      />,
    )

    expect(screen.getByTestId('mock-tool-icon')).toBeTruthy()
    expect(screen.getByTestId('tool-step-status-hint').getAttribute('data-status')).toBe('executing')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('普通工具运行中与失败均默认折叠（：报错也不自动展开）', () => {
    const { container, rerender } = render(
      <ToolStepCard
        id="tool-running"
        toolName="future_tool"
        phase="start"
        input={{ query: 'hello' }}
      />,
    )

    // 进行中也折叠成一行：只显示摘要行，不展开实时详情
    expect(screen.queryByTestId('mock-generic-tool-card')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
    expect(screen.queryByTestId('tool-step-failure-dot')).toBeNull()
    expect(screen.queryByTestId('tool-step-failure-label')).toBeNull()

    rerender(
      <ToolStepCard
        id="tool-error"
        toolName="future_tool"
        phase="error"
        input={{ query: 'hello' }}
        error="boom"
      />,
    )

    // 失败也保持折叠，避免占屏；用户点开再看报错
    expect(screen.queryByTestId('mock-generic-tool-card')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
  })

  it('phase=error 折叠行一眼可黄点一次性 pop，无「失败」文案标', () => {
    const { container, rerender } = render(
      <ToolStepCard
        id="tool-fail-signal"
        toolName="future_tool"
        phase="error"
        input={{ query: 'hello' }}
        error="boom"
      />,
    )
    const dot = screen.getByTestId('tool-step-failure-dot')
    expect(dot.className).toContain('chat-motion-failure-pop')
    expect(dot.className).toContain('bg-warning')
    expect(dot.className).not.toContain('bg-destructive')
    // 一次性 pop：无 shake / 无持续闪烁类
    expect(dot.className).not.toMatch(/shake|animate-pulse|animate-bounce/)
    // ：折叠行只保留黄点，不再叠「失败」destructive 文案
    expect(screen.queryByTestId('tool-step-failure-label')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
    expect(screen.queryByTestId('tool-step-status-hint')).toBeNull()

    // 成功终态不带失败信号（不另开第二套判定）
    rerender(
      <ToolStepCard
        id="tool-fail-signal"
        toolName="future_tool"
        phase="end"
        input={{ query: 'hello' }}
        output={{ ok: true }}
      />,
    )
    expect(screen.queryByTestId('tool-step-failure-dot')).toBeNull()
    expect(screen.queryByTestId('tool-step-failure-label')).toBeNull()
  })

  it('phase=error 展开后仍可见错误详情（折叠行信号不替代展开区）', () => {
    const { container } = render(
      <ToolStepCard
        id="tool-fail-expand"
        toolName="future_tool"
        phase="error"
        input={{ query: 'hello' }}
        error="boom"
      />,
    )
    const toggle = container.querySelector('button[aria-expanded="false"]')
    expect(toggle).toBeTruthy()
    fireEvent.click(toggle!)
    expect(screen.getByTestId('mock-generic-tool-card')).toBeTruthy()
    expect(screen.getByTestId('tool-step-failure-dot')).toBeTruthy()
    expect(screen.queryByTestId('tool-step-failure-label')).toBeNull()
  })

  it('工具运行中与成功均默认折叠（进行中也折叠成一行）', () => {
    const { container, rerender } = render(
      <ToolStepCard
        id="tool-1"
        toolName="future_tool"
        phase="start"
        input={{ query: 'hello' }}
      />,
    )

    // 进行中：折叠
    expect(screen.queryByTestId('mock-generic-tool-card')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()

    rerender(
      <ToolStepCard
        id="tool-1"
        toolName="future_tool"
        phase="end"
        input={{ query: 'hello' }}
        output={{ ok: true }}
      />,
    )

    // 成功：仍折叠
    expect(screen.queryByTestId('mock-generic-tool-card')).toBeNull()
    expect(container.querySelector('button[aria-expanded="false"]')).toBeTruthy()
  })

  // ：后台任务在折叠行就有「后台」徽标，一眼区分前台/后台。
  it('后台终端任务（wait_ms=0）折叠行显示「后台」徽标', () => {
    render(
      <ToolStepCard
        id="bg-1"
        toolName="run_terminal_command"
        phase="end"
        input={{ command: 'sleep 7 && echo done', wait_ms: 0 }}
        output={{ status: 'completed', exit_code: 0 }}
      />,
    )
    const badge = screen.getByTestId('tool-step-background-badge')
    expect(badge).toBeTruthy()
    expect(badge.textContent).toContain('后台')
  })

  it('前台终端任务（无 wait_ms）折叠行不显示「后台」徽标', () => {
    render(
      <ToolStepCard
        id="fg-1"
        toolName="run_terminal_command"
        phase="end"
        input={{ command: 'ls src/' }}
        output={{ status: 'completed', exit_code: 0 }}
      />,
    )
    expect(screen.queryByTestId('tool-step-background-badge')).toBeNull()
  })

  it('非终端工具不显示「后台」徽标（仅对 TerminalCard renderer 判定）', () => {
    render(
      <ToolStepCard
        id="other-1"
        toolName="future_tool"
        phase="end"
        input={{ wait_ms: 0 }}
        output={{ status: 'running' }}
      />,
    )
    expect(screen.queryByTestId('tool-step-background-badge')).toBeNull()
  })
})
