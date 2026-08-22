import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent } from '@dnd-kit/core'

const {
  navigationMock,
  setOrderMock,
  dragEndHandlerRef,
  overlayRenderRef,
  prefsState,
} = vi.hoisted(() => ({
  navigationMock: vi.fn(),
  setOrderMock: vi.fn(),
  dragEndHandlerRef: {
    current: null as ((event: DragEndEvent) => void) | null,
  },
  overlayRenderRef: {
    current: null as ((active: { id: string } | null) => React.ReactNode) | null,
  },
  prefsState: {
    activityRailDomainOrder: undefined as string[] | undefined,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: unknown) => unknown) => selector({ activeRoute: null }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: unknown) => unknown) => selector({
    activityRailDomainOrder: prefsState.activityRailDomainOrder,
    setActivityRailDomainOrder: setOrderMock,
  }),
}))

vi.mock('./primaryNavigation', () => ({
  usePrimaryNavigation: () => ({
    effectiveMainNavTab: 'agent',
    activeAppPage: null,
    messagesUnread: 0,
    messagesUnreadLabel: '',
    collaborationPendingCount: 0,
    collaborationPendingLabel: '',
    handlePrimaryNavigation: navigationMock,
  }),
}))

vi.mock('@/utils/featureFlags', () => ({
  PROJECTS_UI_ENABLED: true,
}))

vi.mock('@/components/common/dnd-kit', () => ({
  DndKitContext: ({
    children,
    onDragEnd,
  }: {
    children: React.ReactNode
    onDragEnd: (event: DragEndEvent) => void
  }) => {
    dragEndHandlerRef.current = onDragEnd
    return <>{children}</>
  },
  Droppable: ({
    children,
    overlayRender,
  }: {
    children: React.ReactNode
    overlayRender: (active: { id: string } | null) => React.ReactNode
  }) => {
    overlayRenderRef.current = overlayRender
    return <>{children}</>
  },
  Draggable: ({
    id,
    children,
  }: {
    id: string
    children: (props: Record<string, unknown>) => React.ReactNode
  }) => <>{children({
    setNodeRef: vi.fn(),
    attributes: { 'data-sortable-id': id },
    listeners: {},
    style: {},
    isDragging: false,
  })}</>,
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock('./OrganizationProfileButton', () => ({
  OrganizationAvatarRailButton: () => null,
  UserAvatarRailButton: () => null,
}))

vi.mock('./CustomerSupportRailButton', () => ({
  CustomerSupportRailButton: () => null,
}))

vi.mock('@components/notification/NotificationBell', () => ({
  NotificationBell: () => null,
}))

vi.mock('./activityRailTooltip', () => ({
  RailIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import { ActivityRail } from './ActivityRail'

describe('ActivityRail domain ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prefsState.activityRailDomainOrder = undefined
    dragEndHandlerRef.current = null
    overlayRenderRef.current = null
  })

  it('keeps click navigation working when drag listeners share the button', () => {
    render(<ActivityRail executionSpaceId="space-1" />)

    fireEvent.click(screen.getByRole('button', { name: '消息' }))

    expect(navigationMock).toHaveBeenCalledOnce()
    expect(navigationMock).toHaveBeenCalledWith('messages')
  })

  it('persists a drag reorder without dispatching navigation', () => {
    render(<ActivityRail executionSpaceId="space-1" />)

    dragEndHandlerRef.current?.({
      active: { id: 'messages' },
      over: { id: 'tasks' },
    } as DragEndEvent)

    expect(setOrderMock).toHaveBeenCalledOnce()
    expect(setOrderMock).toHaveBeenCalledWith([
      'messages',
      'tasks',
      'agents',
      'cloud-docs',
      'projects',
    ])
    expect(navigationMock).not.toHaveBeenCalled()
  })

  it('restores the stored domain order on mount', () => {
    prefsState.activityRailDomainOrder = [
      'cloud-docs',
      'tasks',
      'messages',
      'agents',
      'projects',
    ]

    render(<ActivityRail executionSpaceId="space-1" />)

    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label')))
      .toEqual(['云文档', '任务', '消息', 'AI 分身', '项目'])
  })

  it('ignores a drag that ends outside the rail', () => {
    render(<ActivityRail executionSpaceId="space-1" />)

    dragEndHandlerRef.current?.({
      active: { id: 'messages' },
      over: null,
    } as DragEndEvent)

    expect(setOrderMock).not.toHaveBeenCalled()
    expect(navigationMock).not.toHaveBeenCalled()
  })

  it('renders a pure-presentation drag overlay for the active domain', () => {
    render(<ActivityRail executionSpaceId="space-1" />)

    // overlay 是纯展示层：渲染对应域的图标，不包含可交互的 button（不克隆 Draggable）
    const overlay = overlayRenderRef.current?.({ id: 'cloud-docs' })
    expect(overlay).not.toBeNull()

    const { container } = render(<>{overlay}</>)
    expect(container.querySelector('[data-testid="activity-rail"]')).toBeNull()
    // 纯展示：不渲染 button / aria-label，避免 overlay 内重复 useSortable 与可交互残留
    expect(container.querySelector('button')).toBeNull()
  })
})
