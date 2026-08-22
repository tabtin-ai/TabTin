import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'
import { ChatSessionHistoryMenu } from '../ChatSessionHistoryMenu'

const mocks = vi.hoisted(() => ({
  archiveConfirm: null as null | (() => void | Promise<void>),
  listSessionSharesBySession: vi.fn().mockResolvedValue([]),
  revokeSessionShare: vi.fn(),
  setSessionShare: vi.fn(),
  externalTargets: new Map<string, {
    source: string
    sourceSessionId: string
    title: string
    openedSessionId: string
  }>(),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      beginOptimisticArchive: vi.fn(),
      rollbackOptimisticArchive: vi.fn(),
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  listSessionSharesBySession: mocks.listSessionSharesBySession,
  revokeSessionShare: mocks.revokeSessionShare,
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({ setSessionShare: mocks.setSessionShare }),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: unknown) => {
      if (
        options
        && typeof options === 'object'
        && typeof (options as { defaultValue?: unknown }).defaultValue === 'string'
      ) {
        return (options as { defaultValue: string }).defaultValue
      }
      return '新对话'
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="mock-tooltip-content">{children}</span>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
}))

vi.mock('@components/ui', () => ({
  ConfirmDialog: ({ open, description, onConfirm, onOpenChange, isLoading }: {
    open: boolean
    description: string
    onConfirm: () => void | Promise<void>
    onOpenChange: (open: boolean) => void
    isLoading?: boolean
  }) => {
    mocks.archiveConfirm = onConfirm
    return open ? (
      <div>
        {description}
        <button disabled={isLoading} onClick={() => void onConfirm()}>确认</button>
        <button onClick={() => onOpenChange(false)}>取消</button>
      </div>
    ) : null
  },
}))

vi.mock('@components/onboarding/external-import/externalOpenedSessionRegistry', () => ({
  resolveExternalOpenedSession: (sessionId: string) => mocks.externalTargets.get(sessionId) ?? null,
}))

function makeSession(index: number, overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: `session-${index}`,
    title: `对话 ${index}`,
    message_count: 2,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: `2026-06-${String(index).padStart(2, '0')}T00:00:00.000Z`,
    last_message_at: `2026-06-${String(index).padStart(2, '0')}T12:00:00.000Z`,
    ...overrides,
  } as ChatSession
}

function setScrollMetrics(element: HTMLElement, metrics: {
  clientWidth: number
  scrollWidth: number
  scrollLeft?: number
}) {
  Object.defineProperty(element, 'clientWidth', {
    configurable: true,
    value: metrics.clientWidth,
  })
  Object.defineProperty(element, 'scrollWidth', {
    configurable: true,
    value: metrics.scrollWidth,
  })
  Object.defineProperty(element, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: metrics.scrollLeft ?? 0,
  })
}

describe('ChatSessionHistoryMenu', () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  const OriginalResizeObserver = globalThis.ResizeObserver

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    globalThis.ResizeObserver = OriginalResizeObserver
    mocks.archiveConfirm = null
    mocks.externalTargets.clear()
  })

  it('renders up to eight recent session labels sorted by activity', () => {
    const sessions = Array.from({ length: 10 }, (_, index) => makeSession(index + 1))

    render(
      <ChatSessionHistoryMenu
        sessions={sessions}
        currentSessionId="session-10"
        onSelectSession={vi.fn()}
      />,
    )

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(8)
    expect(buttons[0].textContent).toContain('对话 10')
    expect(buttons[7].textContent).toContain('对话 3')
    expect(screen.queryByText('对话 2')).toBeNull()
    expect(screen.getByRole('button', { name: '对话 10' }).getAttribute('aria-current')).toBe('page')
  })

  it('hides abandoned empty sessions so multi-Space 空「新任务」不占满顶栏', () => {
    render(
      <ChatSessionHistoryMenu
        sessions={[
          makeSession(1, { title: '新任务', message_count: 0 }),
          makeSession(2, { title: '有内容', message_count: 3 }),
          makeSession(3, { title: '新任务', message_count: 0 }),
        ]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '有内容' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '新任务' })).toBeNull()
  })

  it('hides the currently selected empty session — top「新任务」owns the draft', () => {
    render(
      <ChatSessionHistoryMenu
        sessions={[
          makeSession(1, { title: '新任务', message_count: 0 }),
          makeSession(2, { title: '有内容', message_count: 2 }),
        ]}
        currentSessionId="session-1"
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '新任务' })).toBeNull()
    expect(screen.getByRole('button', { name: '有内容' })).toBeTruthy()
  })

  it('selects a session from its label', () => {
    const onSelectSession = vi.fn()

    render(
      <ChatSessionHistoryMenu
        sessions={[makeSession(1)]}
        currentSessionId={null}
        onSelectSession={onSelectSession}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '对话 1' }))

    expect(onSelectSession).toHaveBeenCalledWith('session-1')
  })

  it('requires confirmation before archiving a recent session label', () => {
    const onDeleteSession = vi.fn()

    render(
      <ChatSessionHistoryMenu
        sessions={[makeSession(1)]}
        currentSessionId="session-1"
        onSelectSession={vi.fn()}
        onDeleteSession={onDeleteSession}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭标签：对话 1' }))

    expect(screen.queryByText('确认归档此对话吗？可在项目设置中管理。')).not.toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onDeleteSession).not.toHaveBeenCalled()
  })

  it('keeps confirmation pending until archiving finishes', async () => {
    let finishArchive: (() => void) | undefined
    const archiveResult = new Promise<void>((resolve) => {
      finishArchive = resolve
    })
    const onDeleteSession = vi.fn(() => archiveResult)

    render(
      <ChatSessionHistoryMenu
        sessions={[makeSession(1)]}
        currentSessionId="session-1"
        onSelectSession={vi.fn()}
        onDeleteSession={onDeleteSession}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭标签：对话 1' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认' }).hasAttribute('disabled')).toBe(false)
    })
    const confirmation = mocks.archiveConfirm?.()
    let settled = false
    void Promise.resolve(confirmation).then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)

    await act(async () => {
      finishArchive?.()
      await confirmation
    })
    expect(onDeleteSession).toHaveBeenCalledWith('session-1')
  })

  it('routes an opened external archive to its independent delete confirmation', () => {
    const onDeleteSession = vi.fn()
    const onDeleteExternalArchive = vi.fn()
    mocks.externalTargets.set('session-1', {
      source: 'cursor',
      sourceSessionId: 'source-1',
      title: '外部历史',
      openedSessionId: 'session-1',
    })

    render(
      <ChatSessionHistoryMenu
        sessions={[makeSession(1)]}
        currentSessionId="session-1"
        onSelectSession={vi.fn()}
        onDeleteSession={onDeleteSession}
        onDeleteExternalArchive={onDeleteExternalArchive}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '关闭标签：对话 1' }))

    expect(screen.queryByText(/仅清除本机导入内容/)).not.toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(onDeleteExternalArchive).toHaveBeenCalledTimes(1)
    expect(onDeleteExternalArchive).toHaveBeenCalledWith(mocks.externalTargets.get('session-1'))
  })

  it('only shows full-title tooltip content for truncated labels', async () => {
    render(
      <ChatSessionHistoryMenu
        sessions={[
          { ...makeSession(1), title: '短标题' },
          { ...makeSession(2), title: '这是一个很长很长的最近会话标题' },
        ]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '短标题' })).not.toBeNull()
    await waitFor(() => {
      expect(screen.queryByTestId('mock-tooltip-content')?.textContent).toBe('这是一个很长很长的最近会话标题')
    })
  })

  it('shows tooltip when a label is visually clipped by its rendered width', async () => {
    let resizeCallback: ResizeObserverCallback | null = null
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver

    render(
      <ChatSessionHistoryMenu
        sessions={[{ ...makeSession(1), title: '视觉截断' }]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    const label = screen.getByText('视觉截断')
    setScrollMetrics(label, {
      clientWidth: 24,
      scrollWidth: 64,
      scrollLeft: 0,
    })
    resizeCallback?.([], {} as ResizeObserver)
    fireEvent.mouseEnter(screen.getByRole('button', { name: '视觉截断' }))

    await waitFor(() => {
      expect(screen.queryByTestId('mock-tooltip-content')?.textContent).toBe('视觉截断')
    })
  })

  it('scrolls the active recent session label into view', () => {
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    render(
      <ChatSessionHistoryMenu
        sessions={Array.from({ length: 4 }, (_, index) => makeSession(index + 1))}
        currentSessionId="session-3"
        onSelectSession={vi.fn()}
      />,
    )

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest',
    })
  })

  it('shows edge indicators when recent labels overflow horizontally', async () => {
    const sessions = Array.from({ length: 8 }, (_, index) => makeSession(index + 1))

    render(
      <ChatSessionHistoryMenu
        sessions={sessions}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    const labelGroup = screen.getByRole('group', { name: '最近对话' })
    setScrollMetrics(labelGroup, {
      clientWidth: 160,
      scrollWidth: 320,
      scrollLeft: 0,
    })
    fireEvent(window, new Event('resize'))

    await waitFor(() => {
      expect(screen.queryByTestId('recent-session-scroll-left')).toBeNull()
      expect(screen.queryByTestId('recent-session-scroll-right')).not.toBeNull()
    })

    labelGroup.scrollLeft = 48
    fireEvent.scroll(labelGroup)

    await waitFor(() => {
      expect(screen.queryByTestId('recent-session-scroll-left')).not.toBeNull()
      expect(screen.queryByTestId('recent-session-scroll-right')).not.toBeNull()
    })

    labelGroup.scrollLeft = 160
    fireEvent.scroll(labelGroup)

    await waitFor(() => {
      expect(screen.queryByTestId('recent-session-scroll-left')).not.toBeNull()
      expect(screen.queryByTestId('recent-session-scroll-right')).toBeNull()
    })
  })

  it('maps vertical wheel on recent session labels to horizontal scrolling', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => makeSession(index + 1))

    render(
      <ChatSessionHistoryMenu
        sessions={sessions}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    const labelGroup = screen.getByRole('group', { name: '最近对话' })
    setScrollMetrics(labelGroup, {
      clientWidth: 160,
      scrollWidth: 360,
      scrollLeft: 0,
    })

    fireEvent.wheel(labelGroup, {
      deltaX: 0,
      deltaY: 80,
      deltaMode: 0,
    })

    expect(labelGroup.scrollLeft).toBe(80)
  })

  it('recomputes edge indicators when recent session titles change without count changes', async () => {
    const sessions = Array.from({ length: 2 }, (_, index) => makeSession(index + 1))
    const { rerender } = render(
      <ChatSessionHistoryMenu
        sessions={sessions}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    const labelGroup = screen.getByRole('group', { name: '最近对话' })
    setScrollMetrics(labelGroup, {
      clientWidth: 320,
      scrollWidth: 320,
      scrollLeft: 0,
    })
    fireEvent(window, new Event('resize'))

    await waitFor(() => {
      expect(screen.queryByTestId('recent-session-scroll-right')).toBeNull()
    })

    setScrollMetrics(labelGroup, {
      clientWidth: 160,
      scrollWidth: 360,
      scrollLeft: 0,
    })
    rerender(
      <ChatSessionHistoryMenu
        sessions={[
          {
            ...sessions[0],
            title: '这是一个变长后会触发横向溢出的会话标题',
          },
          sessions[1],
        ]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByTestId('recent-session-scroll-right')).not.toBeNull()
    })
  })
})
