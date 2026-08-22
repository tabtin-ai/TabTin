import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SessionWorktreeIndicator } from '../SessionWorktreeIndicator'
import { SessionListRow } from '../SessionListRow'
import type { ChatSession } from '@tabtin/chat-client'

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({
    content,
    children,
  }: {
    content: string
    children: React.ReactNode
  }) => (
    <span data-testid="tooltip" data-content={content}>
      {children}
    </span>
  ),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      pendingApprovalBySessionId: {},
      pendingAskUserBySessionId: {},
    }),
}))

vi.mock('@/stores/useSessionReadStore', () => ({
  useSessionReadStore: () => false,
}))

vi.mock('@/stores/chat/session/sessionReadProjection', () => ({
  resolveSessionHasUnreadReply: () => false,
}))

vi.mock('@/utils/buildSessionReferenceClipboardText', () => ({
  warmSpacePathCache: vi.fn(),
}))

vi.mock('../SessionStatusIcon', () => ({
  SessionStatusIcon: () => <span data-testid="status-icon" />,
}))

const session = {
  id: 's1',
  title: '会话 A',
  status: 'active',
  updated_at: '2026-08-12T00:00:00Z',
} as ChatSession

const t = (key: string, opts?: { defaultValue?: string; branch?: string; path?: string }) => {
  if (key === 'session.linkedWorktreeIndicator') {
    return `独立工作树：${opts?.branch} · ${opts?.path}`
  }
  return opts?.defaultValue ?? key
}

describe('SessionWorktreeIndicator', () => {
  it('仅渲染中性灰并行路径图标与可访问文案', () => {
    render(
      <SessionWorktreeIndicator
        indicator={{ kind: 'linked', branch: 'feat/x', path: '/wt/x' }}
        fadeOnRowHoverClassName="opacity-100"
        label="独立工作树：feat/x · /wt/x"
      />,
    )
    const el = screen.getByTestId('session-linked-worktree-indicator')
    expect(el.getAttribute('aria-label')).toBe('独立工作树：feat/x · /wt/x')
    expect(el.className).toContain('text-muted-foreground/80')
    expect(el.className).not.toContain('text-success')
    const svg = el.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.querySelectorAll('rect').length).toBe(3)
    expect(svg?.querySelectorAll('path').length).toBe(3)
    expect(svg?.querySelectorAll('circle').length).toBe(0)
    expect(el.textContent?.trim()).toBe('')
  })
})

describe('SessionListRow linked worktree 布局', () => {
  const baseProps = {
    session,
    isActive: false,
    isPinned: false,
    forkingSessionId: null,
    onSelectSession: vi.fn(),
    onForkSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onDragStart: vi.fn(),
    onSetContextMenu: vi.fn(),
    onSetArchiveTarget: vi.fn(),
    sessionRowActionOpacity: 'opacity-100',
    t,
  }

  it('有 indicator 时常显在最右侧槽位，且带 hover 淡出 class', () => {
    render(
      <SessionListRow
        {...baseProps}
        linkedWorktreeIndicator={{ kind: 'linked', branch: 'feat/x', path: '/wt/x' }}
      />,
    )
    const el = screen.getByTestId('session-linked-worktree-indicator')
    expect(el.className).toContain('group-hover:opacity-0')
    expect(el.closest('[data-testid="tooltip"]')?.getAttribute('data-content')).toBe(
      '独立工作树：feat/x · /wt/x',
    )
    const slot = el.closest('.absolute.right-0')
    expect(slot).toBeTruthy()
  })

  it('无 indicator 时不渲染', () => {
    render(<SessionListRow {...baseProps} linkedWorktreeIndicator={null} />)
    expect(screen.queryByTestId('session-linked-worktree-indicator')).toBeNull()
  })
})
