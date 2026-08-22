import React from 'react'
import { render, act, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consumeCapsuleMorph: vi.fn((_direction: string, _target: HTMLElement) => false),
  shouldHideCapsuleForMorph: vi.fn(() => false),
  getCapsuleMorphRevealDelayMs: vi.fn(() => 0),
  MORPH_DURATION_MS: 420,
  busy: false,
  chatState: {
    messagesBySessionId: {} as Record<string, unknown[]>,
    pendingApprovalBySessionId: {} as Record<string, unknown>,
    pendingAskUserBySessionId: {} as Record<string, unknown>,
  },
  runtimeState: {
    runStateBySessionId: {} as Record<string, unknown>,
    runProjectionBySessionId: {} as Record<string, { queuedRunIds: string[] }>,
  },
  wsState: {
    suspendedSessionIds: [] as string[],
  },
}))

vi.mock('../chatCapsuleMorph', () => ({
  consumeCapsuleMorph: (direction: string, target: HTMLElement) =>
    mocks.consumeCapsuleMorph(direction, target),
  shouldHideCapsuleForMorph: () => mocks.shouldHideCapsuleForMorph(),
  getCapsuleMorphRevealDelayMs: () => mocks.getCapsuleMorphRevealDelayMs(),
  MORPH_DURATION_MS: mocks.MORPH_DURATION_MS,
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReducedMotion: () => false,
  motion: {
    button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
      initial?: unknown
      animate?: { opacity?: number }
      exit?: unknown
      transition?: unknown
      layout?: unknown
      whileHover?: unknown
      whileTap?: unknown
      style?: React.CSSProperties
      className?: string
    }>(
      ({
        children,
        initial,
        animate,
        exit: _exit,
        transition: _transition,
        layout: _layout,
        whileHover: _whileHover,
        whileTap: _whileTap,
        style,
        className,
        ...props
      }, ref) => (
        <button
          ref={ref}
          type="button"
          data-testid="capsule-root"
          data-initial={initial === false ? 'false' : 'enter'}
          data-opacity={String(animate?.opacity ?? style?.opacity ?? '')}
          className={className}
          style={style}
          {...props}
        >
          {children}
        </button>
      ),
    ),
    span: ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      layout: _layout,
      ...props
    }: React.HTMLAttributes<HTMLSpanElement> & {
      initial?: unknown
      animate?: unknown
      exit?: unknown
      transition?: unknown
      layout?: unknown
    }) => <span {...props}>{children}</span>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: typeof mocks.chatState) => unknown) =>
    selector(mocks.chatState),
}))

vi.mock('@stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: () => mocks.busy,
}))

vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (state: typeof mocks.runtimeState) => unknown) =>
    selector(mocks.runtimeState),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (s: {
    agentCache: Record<string, unknown>
    selectedAgent: null
  }) => unknown) => selector({ agentCache: {}, selectedAgent: null }),
}))

vi.mock('@stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (state: typeof mocks.wsState) => unknown) =>
    selector(mocks.wsState),
}))

import { AgentChatCapsule } from '../AgentChatCapsule'

describe('AgentChatCapsule morph 入场', () => {
  beforeEach(() => {
    mocks.consumeCapsuleMorph.mockReset()
    mocks.shouldHideCapsuleForMorph.mockReset()
    mocks.getCapsuleMorphRevealDelayMs.mockReset()
    mocks.consumeCapsuleMorph.mockReturnValue(false)
    mocks.shouldHideCapsuleForMorph.mockReturnValue(false)
    mocks.getCapsuleMorphRevealDelayMs.mockReturnValue(0)
    mocks.busy = false
    mocks.chatState.messagesBySessionId = {}
    mocks.chatState.pendingApprovalBySessionId = {}
    mocks.chatState.pendingAskUserBySessionId = {}
    mocks.runtimeState.runStateBySessionId = {}
    mocks.runtimeState.runProjectionBySessionId = {}
    mocks.wsState.suspendedSessionIds = []
  })

  it('morph 隐藏窗口期内跳过 framer enter，且结束后才 opacity=1', () => {
    mocks.shouldHideCapsuleForMorph.mockReturnValue(true)
    mocks.consumeCapsuleMorph.mockReturnValue(true)
    mocks.getCapsuleMorphRevealDelayMs.mockReturnValue(mocks.MORPH_DURATION_MS)
    vi.useFakeTimers()

    const { getByTestId } = render(
      <AgentChatCapsule
        sessionId={null}
        agentId="agent-1"
        agentName="助手"
        seenUntilTs={0}
        onExpand={() => {}}
      />,
    )

    const root = getByTestId('capsule-root')
    expect(mocks.consumeCapsuleMorph).toHaveBeenCalledWith('to-capsule', expect.any(HTMLElement))
    expect(root.getAttribute('data-initial')).toBe('false')
    expect(root.getAttribute('data-opacity')).toBe('0')
    expect(root.className).toMatch(/invisible/)

    act(() => {
      vi.advanceTimersByTime(mocks.MORPH_DURATION_MS)
    })
    expect(getByTestId('capsule-root').getAttribute('data-opacity')).toBe('1')

    vi.useRealTimers()
  })

  it('pending 已消费但仍在隐藏窗口期时保持隐藏（抗 Strict 重挂）', () => {
    // 二次挂载：consume 返回 false，但 reveal delay 仍 > 0
    mocks.shouldHideCapsuleForMorph.mockReturnValue(true)
    mocks.consumeCapsuleMorph.mockReturnValue(false)
    mocks.getCapsuleMorphRevealDelayMs.mockReturnValue(300)
    vi.useFakeTimers()

    const { getByTestId } = render(
      <AgentChatCapsule
        sessionId={null}
        agentId="agent-1"
        agentName="助手"
        seenUntilTs={0}
        onExpand={() => {}}
      />,
    )

    expect(getByTestId('capsule-root').getAttribute('data-opacity')).toBe('0')
    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(getByTestId('capsule-root').getAttribute('data-opacity')).toBe('0')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(getByTestId('capsule-root').getAttribute('data-opacity')).toBe('1')

    vi.useRealTimers()
  })

  it('无 morph 时保留 framer enter', () => {
    mocks.shouldHideCapsuleForMorph.mockReturnValue(false)
    mocks.consumeCapsuleMorph.mockReturnValue(false)
    mocks.getCapsuleMorphRevealDelayMs.mockReturnValue(0)

    const { getByTestId } = render(
      <AgentChatCapsule
        sessionId={null}
        agentId={null}
        agentName={null}
        seenUntilTs={0}
        onExpand={() => {}}
      />,
    )

    expect(getByTestId('capsule-root').getAttribute('data-initial')).toBe('enter')
  })

  it('头像与 Agent 设置使用同一身份投影，且不展示 Agent 原始输出', () => {
    mocks.chatState.messagesBySessionId = {
      'session-1': [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '这段 Agent 原始输出不应出现在胶囊',
          created_at: 200,
        },
      ],
    }

    render(
      <AgentChatCapsule
        sessionId="session-1"
        agentId="agent-xiaodou"
        agentName="小豆子"
        seenUntilTs={100}
        onExpand={() => {}}
      />,
    )

    const avatarWrap = screen.getByTestId('capsule-agent-avatar')
    expect(avatarWrap.querySelector('img')).toBeTruthy()
    expect(screen.getByText('capsule.status.complete')).toBeTruthy()
    expect(screen.queryByText('这段 Agent 原始输出不应出现在胶囊')).toBeNull()
  })

  it('工具返回后显示计划下一步，并让已调用工具数随状态更新', () => {
    mocks.busy = true
    mocks.runtimeState.runStateBySessionId = {
      'session-1': {
        phase: 'planning',
        completedToolCalls: 1,
        totalToolCalls: 0,
      },
    }

    const { rerender } = render(
      <AgentChatCapsule
        sessionId="session-1"
        agentId="agent-1"
        agentName="助手"
        seenUntilTs={0}
        onExpand={() => {}}
      />,
    )

    expect(screen.getByText('capsule.status.planningNext')).toBeTruthy()
    expect(screen.getByTestId('capsule-tool-metric').textContent).toBe('1')
    expect(screen.getByTestId('capsule-tool-metric').getAttribute('title')).toBe('capsule.toolsUsed')
    expect(screen.getByTestId('capsule-tool-count').textContent).toBe('1')

    mocks.runtimeState.runStateBySessionId = {
      'session-1': {
        phase: 'planning',
        completedToolCalls: 2,
        totalToolCalls: 0,
      },
    }
    rerender(
      <AgentChatCapsule
        sessionId="session-1"
        agentId="agent-1"
        agentName="助手"
        seenUntilTs={0}
        onExpand={() => {}}
      />,
    )

    expect(screen.getByTestId('capsule-tool-count').textContent).toBe('2')
  })
})
