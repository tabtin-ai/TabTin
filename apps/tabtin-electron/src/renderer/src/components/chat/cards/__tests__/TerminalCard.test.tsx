/**
 * TerminalCard — 渲染契约 regression
 *
 * 折叠行（W4.5 §step row）承载 description / 截断 command 摘要；命令 + 输出 +
 * 状态收进展开区。compactSummary（terminalToolCards.ts）仍供 Conversation
 * Canvas 等其它消费方使用。
 *
 * 本文件聚焦：
 *   1. TerminalCard 折叠行 + 展开区 description / command 分工
 *   2. TerminalCardRenderer 从 input 提取 description 并透传
 *   3. 等待输出 / 错误 / running 等 phase 边界 UI
 *   4. agent transcript / Space 终端跳转等业务行为
 */

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { TerminalCard, TerminalCardRenderer, isBackgroundTerminalTask, terminalLoadingSkeletonMinHeightPx, TERMINAL_OUTPUT_MAX_HEIGHT_PX } from '../TerminalCard'

const {
  mockAddSpaceSession,
  mockEnsureSpaceSelectedWithFeedback,
  mockOpenResourceTab,
  mockPtyAgentKill,
  mockPtyAgentDetach,
  mockPtyHas,
  mockSnapshotSave,
  mockTerminalState,
  mockTranscriptState,
  mockToast,
  resolveTerminalSessionSpaceId,
} = vi.hoisted(() => {
  const isTerminalTabScopeKey = (value: string | null | undefined): boolean =>
    Boolean(value?.startsWith('conversation:') || value?.startsWith('desktop:'))

  const resolveTerminalSessionSpaceId = (options: {
    sessionFromStore?: { spaceId: string; executionSpaceId?: string } | null
    hiddenTranscriptSpaceId?: string | null
    spaceIdProp?: string | null
    sessionId?: string | null
  }): string | null => {
    const { sessionFromStore, hiddenTranscriptSpaceId, spaceIdProp, sessionId } = options
    if (sessionFromStore?.executionSpaceId) return sessionFromStore.executionSpaceId
    const storeSpaceId = sessionFromStore?.spaceId
    if (storeSpaceId && !isTerminalTabScopeKey(storeSpaceId)) return storeSpaceId
    if (hiddenTranscriptSpaceId) return hiddenTranscriptSpaceId
    if (spaceIdProp) return spaceIdProp
    if (!sessionId?.startsWith('agent-')) return null
    const match = sessionId.slice('agent-'.length).match(/^(.+)-\d{10,17}(?:-[a-z0-9]+)?$/i)
    return match?.[1] || null
  }

  return {
    mockAddSpaceSession: vi.fn(),
    mockEnsureSpaceSelectedWithFeedback: vi.fn(),
    mockOpenResourceTab: vi.fn(),
    mockPtyAgentKill: vi.fn(),
    mockPtyAgentDetach: vi.fn(),
    mockPtyHas: vi.fn(),
    mockSnapshotSave: vi.fn(),
    mockToast: vi.fn(),
    mockTerminalState: {
      sessionsBySpace: {} as Record<string, Array<{
        id: string
        spaceId: string
        executionSpaceId?: string
        title: string
        source: 'user' | 'agent'
        status: 'active' | 'closed'
        createdAt: number
        closedAt?: number
        cwd?: string
      }>>,
      addSpaceSession: vi.fn(),
    },
    mockTranscriptState: {
      transcriptsById: {} as Record<string, {
        id: string
        spaceId: string
        title: string
        source: 'agent'
        status: 'active' | 'closed'
        createdAt: number
        closedAt?: number
        cwd?: string
      }>,
    },
    resolveTerminalSessionSpaceId,
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = String(opts?.defaultValue ?? key)
      return template.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => String(opts?.[token] ?? ''))
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({
    children,
    className,
    style,
    ...rest
  }: {
    children: React.ReactNode
    className?: string
    style?: React.CSSProperties
    'data-testid'?: string
  }) => (
    <div
      className={className}
      style={style}
      data-testid={rest['data-testid'] ?? 'scroll-area'}
    >
      {children}
    </div>
  ),
  toast: mockToast,
  // ChatIconTooltip（copy / open 按钮的 tooltip）依赖这些导出——#1204 给 ChatIconTooltip
  // 引入 Tooltip* 后本 mock 未跟进，导致整个文件挂在「No TooltipProvider export」。
  // passthrough 渲染 children 即可（这些测试只验命令 / 状态 / 输出，不验 tooltip 浮层）。
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('../../utils/clipboard', () => ({
  safeCopyToClipboard: vi.fn((_text: string, cb: () => void) => cb()),
}))

vi.mock('@components/context-space/sources/terminal', () => ({
  deriveAgentTerminalSpaceId: (sessionId: string | null | undefined) => {
    if (!sessionId?.startsWith('agent-')) return null
    const match = sessionId.slice('agent-'.length).match(/^(.+)-\d{10,17}(?:-[a-z0-9]+)?$/i)
    return match?.[1] || null
  },
  resolveTerminalSessionSpaceId,
  useAgentTerminalTranscriptStore: (selector: (state: typeof mockTranscriptState) => unknown) =>
    selector(mockTranscriptState),
  useTerminalSessionStore: (selector: (state: typeof mockTerminalState) => unknown) =>
    selector({ ...mockTerminalState, addSpaceSession: mockAddSpaceSession }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (state: { openResourceTab: typeof mockOpenResourceTab }) => unknown) =>
    selector({ openResourceTab: mockOpenResourceTab }),
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: mockEnsureSpaceSelectedWithFeedback,
}))

const TOOL_NAME = 'run_terminal_command'
const TOOL_ID = 'tc_test'

beforeEach(() => {
  vi.clearAllMocks()
  mockTerminalState.sessionsBySpace = {}
  mockTranscriptState.transcriptsById = {}
  mockEnsureSpaceSelectedWithFeedback.mockResolvedValue(true)
  mockPtyHas.mockResolvedValue({ exists: false })
  mockPtyAgentKill.mockResolvedValue({ success: true })
  mockPtyAgentDetach.mockResolvedValue({ success: true })
  mockSnapshotSave.mockResolvedValue({ success: true, saved: 1, failed: 0 })
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      pty: {
        has: mockPtyHas,
        agentKill: mockPtyAgentKill,
        agentDetach: mockPtyAgentDetach,
        snapshotSave: mockSnapshotSave,
      },
    },
  })
})

/** 构造结构化 terminal data + 任意 input 形态。 */
function makeProps(overrides: {
  description?: unknown
  command?: string
  intent?: string
  inputShape?: 'flat' | 'kwargs' | 'invalid'
}) {
  const { description, command = 'ls src/', intent, inputShape = 'flat' } = overrides
  const inputObj: Record<string, unknown> = { command }
  if (description !== undefined) inputObj.description = description

  const wrappedInput =
    inputShape === 'kwargs' ? { kwargs: inputObj } : inputShape === 'invalid' ? null : inputObj

  return {
    id: TOOL_ID,
    toolName: TOOL_NAME,
    phase: 'end' as const,
    input: wrappedInput,
    intent,
    data: {
      kind: 'terminal' as const,
      command,
      stdout: 'foo.ts\nbar.ts\n',
      stderr: '',
      exit_code: 0,
      cwd: '/tmp/x',
    },
  }
}

// body-only：TerminalCard 现在直接渲染终端窗口内容（命令 + 输出），卡片级
// 折叠 + 下沉外框由外层 ToolStepCard 统一提供。内容无需展开即可见，故为 no-op。
function expandTerminalCard() {
  /* no-op: TerminalCard body 内容直接渲染 */
}

describe('TerminalCard · body 直接渲染命令与输出', () => {
  function makeTerminalCardProps(overrides: { description?: string } = {}): React.ComponentProps<typeof TerminalCard> {
    return {
      command: 'ls src/',
      stdout: 'foo.ts\nbar.ts\n',
      stderr: '',
      exitCode: 0,
      cwd: '/tmp/x',
      ...overrides,
    }
  }

  it('直接渲染命令本体（$ + 命令）与输出', () => {
    render(<TerminalCard {...makeTerminalCardProps()} />)
    expect(screen.getByText('ls src/')).toBeTruthy()
    expect(screen.getByText(/foo\.ts/)).toBeTruthy()
  })

  it('description prop 不在 body 渲染（描述由外层折叠行承载）', () => {
    render(<TerminalCard {...makeTerminalCardProps({ description: 'List files in src directory' })} />)
    expect(screen.queryByText('List files in src directory')).toBeNull()
    expect(screen.getByText('ls src/')).toBeTruthy()
  })
})

describe('TerminalCardRenderer · body 渲染命令', () => {
  it('结构化 terminal data → 渲染命令与输出', () => {
    render(<TerminalCardRenderer {...makeProps({})} />)
    expect(screen.getByText('ls src/')).toBeTruthy()
    expect(screen.getByText(/foo\.ts/)).toBeTruthy()
  })

  it('input 完全无效（null）→ 不 crash，仍渲染命令', () => {
    render(<TerminalCardRenderer {...makeProps({ inputShape: 'invalid' })} />)
    expect(screen.getByText('ls src/')).toBeTruthy()
  })

  it('待同步态优先显示 runtime intent，而不是 input.description 或 command', () => {
    render(
      <TerminalCardRenderer
        {...makeProps({
          command: 'git status --short',
          description: '旧描述',
          intent: '检查工作区状态',
        })}
        data={undefined}
        output={undefined}
      />,
    )

    expect(screen.getByText('检查工作区状态')).toBeTruthy()
    expect(screen.queryByText('旧描述')).toBeNull()
    expect(screen.queryByText('git status --short')).toBeNull()
    expect(screen.queryByText('$ git status --short')).toBeNull()
  })
})

describe('TerminalCardRenderer · phase / 状态边界 + 业务行为', () => {
  it('phase=error → 直接走 ErrorBanner（错误优先，description 不喧宾夺主）', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="error"
        input={{ command: 'rm -rf /', description: 'Show date' }}
        output={undefined}
        error={'命令被安全策略拦截'}
      />,
    )

    // 错误状态下 ErrorBanner 是首屏焦点，description 不该在这条路径上显示
    expect(screen.getByText('命令被安全策略拦截')).toBeTruthy()
    expect(screen.queryByText('Show date')).toBeNull()
    expect(screen.queryByText('$ rm -rf /')).toBeNull()
  })

  it('phase=start + 完全无 input/output → 显示 LoadingPlaceholder，description 路径不触发', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="start"
        input={undefined}
        output={undefined}
      />,
    )

    // LoadingPlaceholder 渲染时 description 没有内容来源；不应 crash
    // 没有 description 文本节点是契约
    expect(screen.queryByText(/Discard|List files|Show/)).toBeNull()
  })

  it('Phase2 Task6：loading 态保留稳定有界骨架 min-height，且小于 CARD_MAX_HEIGHT.md', () => {
    const minH = terminalLoadingSkeletonMinHeightPx()
    expect(minH).toBeGreaterThan(0)
    expect(minH).toBeLessThan(TERMINAL_OUTPUT_MAX_HEIGHT_PX)
    expect(TERMINAL_OUTPUT_MAX_HEIGHT_PX).toBe(250)

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="start"
        input={undefined}
        output={undefined}
      />,
    )
    const skeleton = screen.getByTestId('terminal-loading-skeleton')
    expect(skeleton.style.minHeight).toBe(`${minH}px`)
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0)
  })

  it('Phase2 Task6：完成态短输出不永久撑满 250px；长输出在 CARD_MAX_HEIGHT.md 内滚', () => {
    const { rerender } = render(
      <TerminalCard
        command="echo hi"
        stdout="hi"
        stderr=""
        exitCode={0}
        cwd=""
        displayStatus="success"
      />,
    )
    const shortScroll = screen.getByTestId('terminal-output-scroll')
    expect(shortScroll.style.maxHeight).toBe(`${TERMINAL_OUTPUT_MAX_HEIGHT_PX}px`)
    // 完成态外框不得强制 minHeight=250，避免短输出永久留白
    const shortCard = screen.getByTestId('terminal-card')
    const shortMin = shortCard.style.minHeight
    expect(shortMin === '' || shortMin === '0px' || Number.parseInt(shortMin, 10) < TERMINAL_OUTPUT_MAX_HEIGHT_PX).toBe(true)

    const longOut = Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n')
    rerender(
      <TerminalCard
        command="seq 200"
        stdout={longOut}
        stderr=""
        exitCode={0}
        cwd=""
        displayStatus="success"
      />,
    )
    const longScroll = screen.getByTestId('terminal-output-scroll')
    expect(longScroll.style.maxHeight).toBe(`${TERMINAL_OUTPUT_MAX_HEIGHT_PX}px`)
    // 虚拟行高度由内部 ScrollArea 封顶，不随 stdout 无限增长
    expect(longScroll.textContent).toContain('line-0')
  })

  it('phase=start + running terminal 无 stdout → 显示运行中 elapsed heartbeat，而不是普通 no_output', () => {
    const startedAt = Date.now() - 12_000
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="start"
        input={{ command: 'du -sh ~', description: '查看用户主目录总大小' }}
        output={{ command: 'du -sh ~', stdout: '', stderr: '' }}
        startedAt={startedAt}
      />,
    )

    expect(screen.getByText('du -sh ~')).toBeTruthy()
    expect(screen.getByText('running...')).toBeTruthy()
    expect(screen.getByText(/运行中 .*暂无输出/)).toBeTruthy()
    expect(screen.queryByText('card.no_output')).toBeNull()
  })

  it('phase=end 但 output 尚未到达时，折叠行只显示 description，不闪同步占位', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        output={undefined}
      />,
    )

    expect(screen.getByText('列目录')).toBeTruthy()
    expect(screen.queryByText('结果正在同步…')).toBeNull()
    expect(screen.queryByText('$ ls -la')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
    expect(screen.queryByText('card.no_output')).toBeNull()
  })

  it('phase=end 但 output 尚未到达时，runtime intent 优先于命令', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'git status --short' }}
        intent="检查工作区状态"
        output={undefined}
      />,
    )

    expect(screen.getByText('检查工作区状态')).toBeTruthy()
    expect(screen.queryByText('git status --short')).toBeNull()
    expect(screen.queryByText('$ git status --short')).toBeNull()
    expect(screen.queryByText('结果正在同步…')).toBeNull()
  })

  it('phase=end + output undefined + 仅有 description → 只显示描述，无同步占位', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ description: '列目录任务' }}
        output={undefined}
      />,
    )

    expect(screen.getByText('列目录任务')).toBeTruthy()
    expect(screen.queryByText('结果正在同步…')).toBeNull()
    expect(screen.queryByText('$')).toBeNull()
  })

  it('phase=end + output undefined + 无 command/description → 不渲染占位', () => {
    const { container } = render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{}}
        output={undefined}
      />,
    )

    expect(screen.queryByText('结果正在同步…')).toBeNull()
    expect(container.querySelector('[data-testid="terminal-card"]')).toBeNull()
  })

  it('结构化 output 缺 command 时用 input.command 兜底显示真实命令', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        data={{
          kind: 'terminal' as const,
          command: '',
          stdout: 'total 8\n',
          stderr: '',
          exit_code: 0,
          cwd: '',
          session_id: 'agent-s1',
        }}
      />,
    )

    expandTerminalCard()
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('total 8')).toBeTruthy()
  })

  it('结构化 terminal 卡片不在内层 footer 重复显示耗时', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        durationMs={87}
        data={{
          kind: 'terminal' as const,
          command: 'ls -la',
          stdout: 'total 8\n',
          stderr: '',
          exit_code: 0,
          cwd: '/work',
          duration_ms: 79,
        }}
      />,
    )

    expandTerminalCard()
    // cwd 精简为末级目录显示，完整路径在 title tooltip
    const cwdEl = screen.getByText('work')
    expect(cwdEl).toBeTruthy()
    expect(cwdEl.getAttribute('title')).toBe('/work')
    expect(screen.queryByText('/work')).toBeNull()
    expect(screen.queryByText('79ms')).toBeNull()
    expect(screen.queryByText('87ms')).toBeNull()
  })

  it('有 agent transcript 时默认不创建 Space 终端标签，只渲染打开按钮', () => {
    const sessionId = 'agent-space-1-1779005704948-1d1z'
    mockTranscriptState.transcriptsById[sessionId] = {
      id: sessionId,
      spaceId: 'space-1',
      title: '列目录',
      source: 'agent',
      status: 'active',
      createdAt: 1779005704948,
      cwd: '/work',
    }

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        data={{
          kind: 'terminal' as const,
          command: '',
          stdout: 'total 8\n',
          stderr: '',
          exit_code: 0,
          cwd: '/work',
          session_id: sessionId,
        }}
      />,
    )

    expandTerminalCard()
    expect(screen.getByLabelText('Open terminal')).toBeTruthy()
    expect(mockAddSpaceSession).not.toHaveBeenCalled()
    expect(mockOpenResourceTab).not.toHaveBeenCalled()
  })

  it('点击打开按钮时才把隐藏 transcript materialize 成 Space 终端标签', async () => {
    const sessionId = 'agent-space-1-1779005704948-1d1z'
    mockTranscriptState.transcriptsById[sessionId] = {
      id: sessionId,
      spaceId: 'space-1',
      title: '列目录',
      source: 'agent',
      status: 'active',
      createdAt: 1779005704948,
      cwd: '/work',
    }

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        data={{
          kind: 'terminal' as const,
          command: '',
          stdout: 'total 8\n',
          stderr: '',
          exit_code: 0,
          cwd: '/work',
          session_id: sessionId,
        }}
      />,
    )

    expandTerminalCard()
    fireEvent.click(screen.getByLabelText('Open terminal'))

    await waitFor(() => {
      expect(mockEnsureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
        'space-1',
        expect.any(Object),
      )
    })
    expect(mockAddSpaceSession).toHaveBeenCalledWith(
      'space-1',
      sessionId,
      '列目录',
      'agent',
      '/work',
      'space-1',
    )
    expect(mockSnapshotSave).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId,
        ansiOutput: '$ ls -la\r\ntotal 8\r\n',
        cwd: '/work',
      }),
    ])
    expect(mockOpenResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'terminal',
      id: sessionId,
      title: '列目录',
      meta: {
        source: 'agent',
        status: 'active',
        cwd: '/work',
        createdAt: 1779005704948,
      },
    })
  })

  it('再次点击「查看终端」时 scope 桶 key 不当作 execution Space（ Bug A）', async () => {
    const sessionId = 'agent-space-1-1779005704948-1d1z'
    const tabScopeKey = 'conversation:chat-session-1'
    mockTerminalState.sessionsBySpace[tabScopeKey] = [{
      id: sessionId,
      spaceId: tabScopeKey,
      executionSpaceId: 'space-1',
      title: '列目录',
      source: 'agent',
      status: 'closed',
      createdAt: 1779005704948,
      cwd: '/work',
    }]

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'ls -la', description: '列目录' }}
        tabScopeKey={tabScopeKey}
        data={{
          kind: 'terminal' as const,
          command: 'ls -la',
          stdout: 'total 8\n',
          stderr: '',
          exit_code: 0,
          cwd: '/work',
          session_id: sessionId,
        }}
      />,
    )

    expandTerminalCard()
    fireEvent.click(screen.getByLabelText('View terminal (ended)'))

    await waitFor(() => {
      expect(mockEnsureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
        'space-1',
        expect.any(Object),
      )
    })
    expect(mockAddSpaceSession).not.toHaveBeenCalled()
    expect(mockOpenResourceTab).toHaveBeenCalledWith(tabScopeKey, expect.objectContaining({
      type: 'terminal',
      id: sessionId,
    }))
  })

  it('缺少隐藏索引时可从 agent_session_id 反推 spaceId 并按需打开', async () => {
    const sessionId = 'agent-98b91af3-c18e-4f8d-92ca-27c7ba403e1f-1779005704948-1d1z'

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'pwd', description: '显示目录' }}
        output={JSON.stringify({
          success: true,
          exitCode: 0,
          stdout: '/work\n',
          stderr: '',
          cwd: '/work',
          agent_session_id: sessionId,
        })}
      />,
    )

    expandTerminalCard()
    fireEvent.click(screen.getByLabelText('Open terminal'))

    await waitFor(() => {
      expect(mockAddSpaceSession).toHaveBeenCalledWith(
        '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
        sessionId,
        'pwd',
        'agent',
        '/work',
        '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
      )
    })
    expect(mockOpenResourceTab).toHaveBeenCalledWith(
      '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
      expect.objectContaining({
        type: 'terminal',
        id: sessionId,
        title: 'pwd',
      }),
    )
    expect(mockSnapshotSave).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId,
        ansiOutput: '$ pwd\r\n/work\r\n',
        cwd: '/work',
      }),
    ])
  })

  it('Agent transcript 仍在 main 进程时点击打开不写快照，避免覆盖实时输出', async () => {
    const sessionId = 'agent-space-1-1779005704948-1d1z'
    mockPtyHas.mockResolvedValue({ exists: true })
    mockTranscriptState.transcriptsById[sessionId] = {
      id: sessionId,
      spaceId: 'space-1',
      title: 'watch tests',
      source: 'agent',
      status: 'active',
      createdAt: 1779005704948,
      cwd: '/work',
    }

    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'pnpm test --watch', description: '看测试' }}
        data={{
          kind: 'terminal' as const,
          command: 'pnpm test --watch',
          stdout: 'running\n',
          stderr: '',
          exit_code: null,
          cwd: '/work',
          session_id: sessionId,
          backgrounded: true,
        }}
      />,
    )

    expandTerminalCard()
    fireEvent.click(screen.getByLabelText('Open terminal'))

    await waitFor(() => {
      expect(mockOpenResourceTab).toHaveBeenCalled()
    })
    expect(mockPtyHas).toHaveBeenCalledWith(sessionId)
    expect(mockSnapshotSave).not.toHaveBeenCalled()
  })

  // 2026-05-17 dogfood 事故端到端回归：terminal 超时场景从 lifecycle 兜底
  // 拿到 runtime `buildToolErrorResult` 的结构化错误 JSON，必须正常渲染
  // 命令 + 错误原因，不该退到"结果正在同步…"或空白 body。
  it('phase=end + 失败结构化 output（error_kind/error）→ 渲染命令 + 把 error 文案显示出来', () => {
    const errorOutput = JSON.stringify({
      success: false,
      error_kind: 'request_timeout',
      abort_reason: 'timeout',
      timeout_ms: 120000,
      stdout: '',
      stderr: '',
      error: 'Command timed out after 120000ms — shell process was terminated.',
      hint: 'Strongly prefer run_in_background: true for unbounded work.',
    })
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'find ~ -name "calculator.html"', description: '查找 calculator.html 文件位置' }}
        output={errorOutput}
      />,
    )

    expect(screen.queryByText('结果正在同步…')).toBeNull()
    expect(screen.getByText('find ~ -name "calculator.html"')).toBeTruthy()
    // error 文案被升到 stderr 渲染出来
    expect(screen.getByText(/timed out after 120000ms/)).toBeTruthy()
    // timeout 是终态，不应再显示 running
    expect(screen.getByText('已超时')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('displayStatus=running 但 session 已 closed → 显示已终止而不是 running（修链 C 假运行）', () => {
    const sessionId = 'agent-space-1-1779005704948-closed'
    mockTranscriptState.transcriptsById[sessionId] = {
      id: sessionId,
      spaceId: 'space-1',
      title: 'long build',
      source: 'agent',
      status: 'closed',
      createdAt: 1779005704948,
      cwd: '/work',
    }

    render(
      <TerminalCard
        command="pnpm build"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
    expect(screen.queryByText(/运行中 .*暂无输出/)).toBeNull()
  })

  it('结构化 terminal data + phase=error + exit_code=null → header 显示已超时而不是 running', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="error"
        input={{ command: 'du -sh ~', description: '查看用户主目录总大小' }}
        output={{
          success: false,
          error_kind: 'request_timeout',
          abort_reason: 'timeout',
          error: 'Command timed out after 120000ms — shell process was terminated.',
        }}
        data={{
          kind: 'terminal' as const,
          command: 'du -sh ~',
          stdout: '',
          stderr: 'Command timed out after 120000ms — shell process was terminated.',
          exit_code: null,
          cwd: '',
          session_id: 'agent-s1',
        }}
      />,
    )

    expect(screen.getByText('du -sh ~')).toBeTruthy()
    expect(screen.getByText('已超时')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
  })
})

describe('TerminalCardRenderer · 结构化终态字段优先（终端假运行根治 v3 / PRD §1.3 治本）', () => {
  // 本组钉死「前端优先读结构化 status/killed_reason，不再靠 stderr 英文关键词
  // 反推」这一根治结果。模拟生产路径：后台终态 tool_result 的 content 既被
  // extractTerminal 解成 data（terminal kind），完整字段又保留在 output。
  // displayStatus 由 deriveDisplayStatusFromPayload 读 output 的结构化字段算出。

  /**
   * 模拟生产结构化路径：output 是完整终态对象（含 killed_reason / status /
   * exited_by 等），data 是 extractTerminal 等价产物（剥离了终态字段）。
   */
  function renderStructuredTerminal(output: Record<string, unknown>) {
    const command = String(output.command ?? 'sleep 999')
    const exitCode = (output.exit_code === undefined ? null : output.exit_code) as number | null
    return render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command }}
        output={output}
        data={{
          kind: 'terminal' as const,
          command,
          stdout: String(output.stdout ?? ''),
          stderr: String(output.stderr ?? ''),
          exit_code: exitCode,
          cwd: String(output.cwd ?? ''),
        }}
      />,
    )
  }

  it('killed_reason=app_exit（英文 stderr）→ 显示「应用退出已停止」，不回落失败/运行中', () => {
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'app_exit',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'pnpm dev',
      stderr: 'Process terminated because the app was quitting (app_exit)',
    })

    expect(screen.getByText('应用退出已停止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('★回归点：killed_reason=app_exit + 纯中文 stderr（无英文关键词）→ 仍显示「应用退出已停止」', () => {
    // 这正是本次要根治的回归：文案本地化成中文、stderr 不含
    // terminated/killed/aborted，旧实现会 success:false → inferTerminatedStatusFromText
    // miss → 静默回落「失败」（红色误导）。读结构化 killed_reason 后不受文案影响。
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'app_exit',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'pnpm dev',
      stderr: '因应用正在退出，进程已被停止（app_exit）',
    })

    expect(screen.getByText('应用退出已停止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('killed_reason=hard_timeout（中文 stderr）→ 显示「已超时」', () => {
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'hard_timeout',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'sleep 9999',
      stderr: '命令运行超过硬性超时上限，已被强制结束',
    })

    expect(screen.getByText('已超时')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('killed_reason=kill_tool（中文 stderr）→ 显示「已终止」', () => {
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'kill_tool',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'tail -f log',
      stderr: '进程已被结束',
    })

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('killed_reason=user_interrupt（中文 stderr）→ 显示「已终止」', () => {
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'user_interrupt',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'npm run build',
      stderr: '用户中断了命令',
    })

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('status=killed（无 killed_reason，未来执行 A 契约）→ 显示「已终止」', () => {
    renderStructuredTerminal({
      status: 'killed',
      exit_code: null,
      command: 'some-cmd',
      stderr: '',
    })

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('status=failed + exit_code=null → 显示「失败」', () => {
    renderStructuredTerminal({
      status: 'failed',
      exit_code: null,
      command: 'broken-cmd',
      stderr: 'something went wrong',
    })

    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('status=completed + exit_code=0 → 成功显示「已完成」（绿色，非退出码）', () => {
    renderStructuredTerminal({
      status: 'completed',
      exited_by: 'normal_exit',
      exit_code: 0,
      command: 'ls',
      stdout: 'a\nb\n',
    })

    expandTerminalCard()
    const label = screen.getByText('已完成')
    expect(label.className).toContain('text-success/80')
    expect(label.className).not.toContain('text-destructive')
    expect(screen.queryByText('退出码 0')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('status=completed + exited_by=normal_exit + exit_code=2（grep 无匹配）→ 已完成（不再凭退出码误判失败）', () => {
    // 核心修复回归：grep 无匹配返 2、du 遇无权限返 1 都属正常结束（normal_exit）。
    // 执行层已判 completed，展示层不再凭退出码非零二次裁决「失败」→ 绿色「已完成」。
    renderStructuredTerminal({
      status: 'completed',
      exited_by: 'normal_exit',
      exit_code: 2,
      command: 'grep x',
      stderr: '',
    })

    expandTerminalCard()
    const label = screen.getByText('已完成')
    expect(label.className).toContain('text-success/80')
    expect(label.className).not.toContain('text-destructive')
    expect(screen.queryByText('失败：命令执行失败')).toBeNull()
    expect(screen.queryByText('退出码 2')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('status=completed + exit_code=127 → 失败显示「找不到命令」', () => {
    renderStructuredTerminal({
      status: 'completed',
      exited_by: 'exec_failure',
      exit_code: 127,
      command: 'missing-bin',
      stderr: 'command not found',
    })

    expect(screen.getByText('失败：找不到命令')).toBeTruthy()
    expect(screen.queryByText('退出码 127')).toBeNull()
  })

  it('exited_by=signal（无 killed_reason，中文 stderr，外部 kill/OOM）→ 显示「已终止」', () => {
    renderStructuredTerminal({
      status: 'completed',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'big-job',
      stderr: '进程被信号杀死',
    })

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('exited_by=exec_failure（中文 stderr）→ 显示「失败」', () => {
    renderStructuredTerminal({
      status: 'completed',
      exited_by: 'exec_failure',
      success: false,
      exit_code: null,
      command: 'nonexistent-bin',
      stderr: '命令无法执行',
    })

    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.queryByText('running...')).toBeNull()
  })

  it('app_exit 状态用中性灰而非 destructive 红色（不误导成命令失败）', () => {
    renderStructuredTerminal({
      status: 'completed',
      killed_reason: 'app_exit',
      exited_by: 'signal',
      success: false,
      exit_code: null,
      command: 'pnpm dev',
      stderr: '因应用退出，进程已停止',
    })

    const label = screen.getByText('应用退出已停止')
    expect(label.className).toContain('text-muted-foreground/60')
    expect(label.className).not.toContain('text-destructive')
  })

  // ── legacy 向后兼容：结构化字段缺失（历史数据 / 老版本投递）才回落字符串推断 ──

  it('legacy 兼容：无结构化终态字段 + stderr 含英文 killed → 回落推断为「已终止」', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        output={JSON.stringify({
          success: false,
          command: 'old-cmd',
          stdout: '',
          stderr: 'Process was killed',
          cwd: '/work',
        })}
      />,
    )

    expect(screen.getByText('已终止')).toBeTruthy()
    expect(screen.queryByText('失败')).toBeNull()
  })

  it('legacy 兼容：无结构化终态字段 + exit_code=0 → 成功显示「已完成」', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        output={JSON.stringify({
          command: 'old-ok',
          stdout: 'done\n',
          exit_code: 0,
          cwd: '/work',
        })}
      />,
    )

    expandTerminalCard()
    const label = screen.getByText('已完成')
    expect(label.className).toContain('text-success/80')
    expect(screen.queryByText('退出码 0')).toBeNull()
  })

  // ── Layer 3 诚实降级（终端假运行根治 v3 §5 / 失败模式 F14）──
  // Django celery 主判定把"超 hard_timeout 仍 running 无终态"的快照标成 status:"unknown"，
  // 前端据此渲染诚实"运行状态未知"中性态（非失败红、非无限转圈）+ 查看输出/刷新出口。

  it('status=unknown（celery 标的未知终态）→ 显示「运行状态未知」中性灰，不显示 running/失败', () => {
    renderStructuredTerminal({
      status: 'unknown',
      terminal_state_unknown: true,
      unknown_reason: 'stale_running_no_terminal_state',
      exit_code: null,
      command: 'pnpm dev',
      stdout: 'compiling...\n',
      cwd: '/work',
      output_file: '/tmp/tabtin-agent-tasks/x.log',
      session_id: 'agent-space-1-1779005704948-1d1z',
    })

    const label = screen.getByText('运行状态未知')
    expect(label.className).toContain('text-muted-foreground/60')
    expect(label.className).not.toContain('text-destructive')
    expect(screen.queryByText('running...')).toBeNull()
    expect(screen.queryByText('失败')).toBeNull()
  })

  it('status=unknown → 渲染「运行状态未知（可能已结束，结果未同步）」提示 + 查看输出出口', () => {
    const sessionId = 'agent-space-1-1779005704948-1d1z'
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'pnpm dev' }}
        output={{
          status: 'unknown',
          terminal_state_unknown: true,
          exit_code: null,
          command: 'pnpm dev',
          stdout: 'still going\n',
          cwd: '/work',
          session_id: sessionId,
        }}
        data={{
          kind: 'terminal' as const,
          command: 'pnpm dev',
          stdout: 'still going\n',
          stderr: '',
          exit_code: null,
          cwd: '/work',
          session_id: sessionId,
        }}
      />,
    )

    expect(screen.getByText('运行状态未知（可能已结束，结果未同步）')).toBeTruthy()
    // 可跳转的 agent session（mock 从 session_id 反推出 space-1）→ 提供「查看输出」出口
    expect(screen.getByText('查看输出')).toBeTruthy()
  })

  it('legacy 回归：app_exit 中文 stderr 但无任何结构化字段（极老数据）→ 仍会回落失败（说明结构化字段的必要性）', () => {
    // 文档化：纯老数据（连 killed_reason/exited_by/status 都没有）且 stderr 是
    // 中文时，前端无从判断「这是被终止还是失败」——这正是为什么执行 A 必须保证
    // 终态携带结构化字段。新数据带 killed_reason 后此问题消失（见上方回归点测试）。
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        output={JSON.stringify({
          success: false,
          command: 'pnpm dev',
          stdout: '',
          stderr: '因应用退出，进程已停止',
          cwd: '/work',
        })}
      />,
    )

    // 老数据无结构化字段 + 中文 stderr → legacy 推断 miss → 回落「失败」。
    // 这是已知限制（仅影响升级前的历史数据），不是回归。
    expect(screen.getByText('失败')).toBeTruthy()
  })
})

// ── ：后台/前台判定 + 状态标签归一（「后台」徽标在 ToolStepCard 折叠行，
// 见 ToolStepCard.test.tsx；这里只验判定纯函数与 TerminalCard 状态文案） ──
describe('isBackgroundTerminalTask · 后台判定', () => {
  it('wait_ms=0 持久命中（即便 output 已是 completed 也判后台）', () => {
    expect(isBackgroundTerminalTask({ command: 'sleep 7', wait_ms: 0 }, JSON.stringify({ status: 'completed', exit_code: 0 }))).toBe(true)
  })
  it('output status:running 命中', () => {
    expect(isBackgroundTerminalTask({ command: 'sleep 7' }, JSON.stringify({ status: 'running', pid: 1 }))).toBe(true)
  })
  it('旧 PTY backgrounded:true 命中', () => {
    expect(isBackgroundTerminalTask({ command: 'x' }, { backgrounded: true })).toBe(true)
  })
  it('前台命令（无 wait_ms + completed）→ false', () => {
    expect(isBackgroundTerminalTask({ command: 'ls' }, JSON.stringify({ status: 'completed', exit_code: 0 }))).toBe(false)
  })
})

describe('TerminalCard · 终端结果显示精简', () => {
  it('单行长 JSON stdout 被 pretty-print 成多行缩进（tabtin CLI 输出可读性）', async () => {
    const compactJson = JSON.stringify({
      success: true,
      rows: [
        { id: 1, name: 'alpha', status: 'active' },
        { id: 2, name: 'beta', status: 'archived' },
      ],
      total: 2,
      page: 1,
      has_more: false,
    })
    expect(compactJson.length).toBeGreaterThan(120)

    render(
      <TerminalCard
        command="tabtin table list"
        stdout={compactJson}
        stderr=""
        exitCode={0}
        cwd="/work"
        displayStatus="success"
      />,
    )

    // 压缩单行不再出现，替换为多行缩进形态（key 独立成行）
    expect(screen.queryByText(compactJson)).toBeNull()
    expect(screen.getByText(/"rows": \[/)).toBeTruthy()

    // 复制路径保留原始字节（review P3 #7）：copy 拿到的是压缩单行原文，
    // 不是 pretty-print 后的改写文本。
    fireEvent.click(screen.getByLabelText('card.copy_output'))
    const { safeCopyToClipboard } = await import('../../utils/clipboard')
    const copied = (safeCopyToClipboard as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    expect(copied).toBe(compactJson)
  })

  it('多行 stdout（普通文本 / 已格式化 JSON）原样保留不改写', () => {
    const multiline = 'line one\nline two\nline three'
    render(
      <TerminalCard
        command="cat notes.txt"
        stdout={multiline}
        stderr=""
        exitCode={0}
        cwd="/work"
        displayStatus="success"
      />,
    )
    expect(screen.getByText(/line one\s*line two\s*line three/)).toBeTruthy()
  })

  it('成功态标题栏渲染绿色状态圆点，失败态渲染红色圆点', () => {
    const { container, rerender } = render(
      <TerminalCard
        command="ls"
        stdout="a\n"
        stderr=""
        exitCode={0}
        cwd="/work"
        displayStatus="success"
      />,
    )
    expect(container.querySelector('.bg-success\\/80')).toBeTruthy()

    rerender(
      <TerminalCard
        command="broken"
        stdout=""
        stderr="boom"
        exitCode={null}
        cwd="/work"
        displayStatus="failed"
      />,
    )
    expect(container.querySelector('.bg-destructive\\/80')).toBeTruthy()
  })
})

describe('TerminalCard · Agent 命令停止按钮（ PR-1）', () => {
  const sessionId = 'agent-space-1-1779005704948-stop01'

  it('运行态 + agent sessionId → 显示停止按钮', () => {
    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.getByLabelText('停止命令')).toBeTruthy()
  })

  it('backgrounded 运行态 → 显示停止按钮', () => {
    render(
      <TerminalCard
        command="pnpm test --watch"
        stdout="running\n"
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="backgrounded"
        backgrounded
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.getByLabelText('停止命令')).toBeTruthy()
  })

  it('已结束态 → 不显示停止按钮', () => {
    render(
      <TerminalCard
        command="ls"
        stdout="done\n"
        stderr=""
        exitCode={0}
        cwd="/work"
        displayStatus="success"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.queryByLabelText('停止命令')).toBeNull()
  })

  it('非 agent- sessionId → 不显示停止按钮', () => {
    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId="user-session-1"
        spaceId="space-1"
      />,
    )

    expect(screen.queryByLabelText('停止命令')).toBeNull()
  })

  it('点击停止 → 调 pty.agentKill', async () => {
    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    fireEvent.click(screen.getByLabelText('停止命令'))

    await waitFor(() => {
      expect(mockPtyAgentKill).toHaveBeenCalledWith(sessionId)
    })
  })

  it('停止失败 → toast 提示', async () => {
    mockPtyAgentKill.mockResolvedValueOnce({ success: false })

    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    fireEvent.click(screen.getByLabelText('停止命令'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: '停止失败',
        variant: 'destructive',
      }))
    })
  })
})

describe('TerminalCard · Agent 命令转后台按钮（ PR-2）', () => {
  const sessionId = 'agent-space-1-1779005704948-detach01'

  it('前台 running + agent sessionId → 显示转入后台按钮', () => {
    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.getByLabelText('转入后台')).toBeTruthy()
  })

  it('backgrounded 运行态 → 不显示转入后台按钮', () => {
    render(
      <TerminalCard
        command="pnpm test --watch"
        stdout="running\n"
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="backgrounded"
        backgrounded
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    expect(screen.queryByLabelText('转入后台')).toBeNull()
  })

  it('点击转入后台 → 调 pty.agentDetach', async () => {
    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    fireEvent.click(screen.getByLabelText('转入后台'))

    await waitFor(() => {
      expect(mockPtyAgentDetach).toHaveBeenCalledWith(sessionId)
    })
  })

  it('转入后台失败 → toast 提示', async () => {
    mockPtyAgentDetach.mockResolvedValueOnce({ success: false })

    render(
      <TerminalCard
        command="sleep 999"
        stdout=""
        stderr=""
        exitCode={null}
        cwd="/work"
        displayStatus="running"
        sessionId={sessionId}
        spaceId="space-1"
      />,
    )

    fireEvent.click(screen.getByLabelText('转入后台'))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({
        title: '转入后台失败',
        variant: 'destructive',
      }))
    })
  })
})

describe('TerminalCardRenderer · 后台运行态状态文案归一', () => {
  it('后台运行中（status:running）→ header 状态显示中性「运行中」，不再用琥珀 backgrounded 文案', () => {
    render(
      <TerminalCardRenderer
        id={TOOL_ID}
        toolName={TOOL_NAME}
        phase="end"
        input={{ command: 'sleep 7 && echo done', wait_ms: 0 }}
        output={JSON.stringify({
          status: 'running',
          session_id: 'agent-space-1-1779005704948-bg01',
          pid: 12345,
          output_file: '/tmp/tabtin-agent-tasks/bg01.log',
        })}
        data={{
          kind: 'terminal' as const,
          command: 'sleep 7 && echo done',
          stdout: '',
          stderr: '',
          exit_code: null,
          cwd: '/work',
          backgrounded: true,
          session_id: 'agent-space-1-1779005704948-bg01',
        }}
      />,
    )
    // 「后台」类别标识已移到 ToolStepCard 折叠行；TerminalCard 状态归一为中性运行中。
    expect(screen.getByText('running...')).toBeTruthy()
    expect(screen.queryByText('backgrounded')).toBeNull()
  })
})
