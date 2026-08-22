import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setTaskViewModeForScope: vi.fn(),
  captureTaskViewModeMorph: vi.fn(),
}))

vi.mock('../chatCapsuleMorph', () => ({
  captureTaskViewModeMorph: (...args: unknown[]) => mocks.captureTaskViewModeMorph(...args),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
      ({ children, ...props }, ref) => (
        <div ref={ref} {...props}>{children}</div>
      ),
    ),
    button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
      ({ children, ...props }, ref) => (
        <button ref={ref} type="button" {...props}>{children}</button>
      ),
    ),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../AgentChatCapsule', () => ({
  AgentChatCapsule: ({ onExpand }: { onExpand: () => void }) => (
    <button type="button" data-testid="capsule" onClick={onExpand}>
      capsule
    </button>
  ),
}))

vi.mock('../AgentChatOverlay', () => ({
  AgentChatOverlay: ({
    onCollapse,
    onBackToSplit,
  }: {
    onCollapse: () => void
    onBackToSplit: () => void
  }) => (
    <div data-testid="overlay">
      <button type="button" data-testid="collapse" onClick={onCollapse}>collapse</button>
      <button type="button" data-testid="back-to-split" onClick={onBackToSplit}>back</button>
    </div>
  ),
}))

vi.mock('../AgentChatFloatingPositioners', () => ({
  AgentChatCapsulePositioner: ({
    children,
    onActivate,
    onPlacementChange,
  }: {
    children: (props: { dragging: boolean; onActivate: () => void }) => React.ReactNode
    onActivate: () => void
    onPlacementChange: (placement: { side: 'left' | 'right'; yRatio: number }) => void
  }) => (
    <div data-testid="capsule-positioner">
      {children({ dragging: false, onActivate })}
      <button
        type="button"
        data-testid="move-capsule"
        onClick={() => onPlacementChange({ side: 'left', yRatio: 0.4 })}
      >
        move
      </button>
    </div>
  ),
  AgentChatOverlayPositioner: ({
    children,
  }: {
    children: (props: { transformOrigin: string }) => React.ReactNode
  }) => (
    <div data-testid="overlay-positioner">
      {children({ transformOrigin: '0px 24px' })}
    </div>
  ),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: Object.assign(
    () => ({}),
    {
      getState: () => ({
        setTaskViewModeForScope: mocks.setTaskViewModeForScope,
      }),
    },
  ),
}))

import { useUIStore } from '@stores/useUIStore'
import { AgentChatCapsuleHost } from '../AgentChatCapsuleHost'

const spaceContext = {
  id: 'space-1',
  name: 'Space',
  organization_id: 'org-1',
}

describe('AgentChatCapsuleHost', () => {
  beforeEach(() => {
    mocks.setTaskViewModeForScope.mockClear()
    useUIStore.setState({
      appFocusChatOverlayOpenByScopeKey: {},
      agentChatCapsulePlacement: { side: 'right', yRatio: 1 },
    })
  })

  it('默认渲染胶囊；展开后切换为悬浮面板', () => {
    render(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-1"
        sessionId="sess-1"
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
        organizationId="org-1"
      />,
    )

    expect(screen.getByTestId('capsule')).toBeTruthy()
    expect(screen.queryByTestId('overlay')).toBeNull()

    fireEvent.click(screen.getByTestId('capsule'))

    expect(screen.getByTestId('overlay')).toBeTruthy()
    expect(screen.queryByTestId('capsule')).toBeNull()
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey['conversation:sess-1']).toBe(true)
  })

  it('收起面板会关闭展开态', () => {
    useUIStore.setState({
      appFocusChatOverlayOpenByScopeKey: { 'conversation:sess-1': true },
    })

    render(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-1"
        sessionId="sess-1"
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
      />,
    )

    fireEvent.click(screen.getByTestId('collapse'))

    expect(screen.getByTestId('capsule')).toBeTruthy()
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey['conversation:sess-1']).toBe(false)
  })

  it('拖拽位置作为全局 UI 偏好写入 store', () => {
    render(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-1"
        sessionId="sess-1"
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
      />,
    )

    fireEvent.click(screen.getByTestId('move-capsule'))

    expect(useUIStore.getState().agentChatCapsulePlacement).toEqual({
      side: 'left',
      yRatio: 0.4,
    })
  })

  it('回到分屏会先 capture morph，再写 split 并关闭悬浮面板', () => {
    useUIStore.setState({
      appFocusChatOverlayOpenByScopeKey: { 'conversation:sess-1': true },
    })
    mocks.captureTaskViewModeMorph.mockClear()

    render(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-1"
        sessionId="sess-1"
        agentId={null}
        agentName={null}
        spaceContext={spaceContext}
      />,
    )

    fireEvent.click(screen.getByTestId('back-to-split'))

    expect(mocks.captureTaskViewModeMorph).toHaveBeenCalledWith('app-focus', 'split')
    expect(mocks.setTaskViewModeForScope).toHaveBeenCalledWith('conversation:sess-1', 'split')
    expect(mocks.captureTaskViewModeMorph.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setTaskViewModeForScope.mock.invocationCallOrder[0],
    )
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey['conversation:sess-1']).toBe(false)
  })

  it('展开后 Host 卸载不应清掉展开态（避免 draft→session remount 误收起）', () => {
    useUIStore.setState({
      appFocusChatOverlayOpenByScopeKey: { 'conversation:sess-1': true },
    })

    const { unmount } = render(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-1"
        sessionId="sess-1"
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
      />,
    )

    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey['conversation:sess-1']).toBe(true)
    unmount()
    expect(useUIStore.getState().appFocusChatOverlayOpenByScopeKey['conversation:sess-1']).toBe(true)
  })

  it('scopeKey 变化后不再用已清理的草稿偏好覆盖正式会话模式', () => {
    const { rerender } = render(
      <AgentChatCapsuleHost
        scopeKey="conversation:draft:space-1"
        sessionId={null}
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
      />,
    )

    rerender(
      <AgentChatCapsuleHost
        scopeKey="conversation:sess-new"
        sessionId="sess-new"
        agentId="agent-1"
        agentName="助手"
        spaceContext={spaceContext}
      />,
    )

    expect(mocks.setTaskViewModeForScope).not.toHaveBeenCalled()
  })
})
