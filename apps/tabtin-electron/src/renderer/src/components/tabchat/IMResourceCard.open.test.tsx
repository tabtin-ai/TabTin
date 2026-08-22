import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { openIMResourceFromChat, openImResourceInCanvas } from './IMResourceCard'
import { useAuthStore } from '@/stores/useAuthStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'

const { mockEnsureSpaceSelectedWithFeedback } = vi.hoisted(() => ({
  mockEnsureSpaceSelectedWithFeedback: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: mockEnsureSpaceSelectedWithFeedback,
}))

const t = ((key: string) => key) as TFunction

describe('openIMResourceFromChat', () => {
  afterEach(() => {
    mockEnsureSpaceSelectedWithFeedback.mockClear()
    useAuthStore.setState({ user: null })
    useSpaceStore.setState({ spaces: [], selectedSpace: null })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
    useSpaceViewPrefsStore.setState({ canvasCollapsedByScopeKey: {} })
  })

  it('opens same-space IM table cards in the desktop scope instead of a Session scope', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'space-1', organization_id: 'org-1' }],
      selectedSpace: { id: 'space-1', organization_id: 'org-1' },
    } as never)

    await openIMResourceFromChat({
      resourceType: 'table',
      resourceId: 'table-1',
      name: '客户表',
      spaceId: 'space-1',
      organizationId: 'org-1',
    }, t)

    const desktopScopeKey = 'desktop:organization:org-1:user:user-1'
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).toHaveProperty(
      desktopScopeKey,
      'tabdata:table-1',
    )
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace).not.toHaveProperty(
      'conversation:session-1',
    )
  })

  it('opens organization-owned IM docs that have no legacy space id', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-1' }],
      selectedSpace: { id: 'host-space-1', organization_id: 'org-1' },
    } as never)

    await openIMResourceFromChat({
      resourceType: 'document',
      resourceId: 'doc-org-1',
      name: '刚新建的文档',
      organizationId: 'org-1',
    }, t)

    const desktopScopeKey = 'desktop:organization:org-1:user:user-1'
    const state = useSpaceContextTabsStore.getState()
    expect(state.activeKeyBySpace).toHaveProperty(desktopScopeKey, 'tabdoc:doc-org-1')
    expect(state.itemsBySpace[desktopScopeKey]?.['tabdoc:doc-org-1']?.meta).toMatchObject({
      organizationId: 'org-1',
      foreignShared: true,
    })
  })

  it('opens foreign shared IM docs through the current visible workspace', async () => {
    useAuthStore.setState({ user: { id: 'user-1' } as never })
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-host' }],
      selectedSpace: { id: 'host-space-1', organization_id: 'org-host' },
    } as never)

    await openIMResourceFromChat({
      resourceType: 'document',
      resourceId: 'doc-1',
      name: '新展开不可能的放松',
      spaceId: 'resource-space-1',
      organizationId: 'org-resource',
    }, t)

    expect(mockEnsureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
      'host-space-1',
      expect.objectContaining({ organizationId: 'org-host' }),
    )
    const desktopScopeKey = 'desktop:organization:org-host:user:user-1'
    const state = useSpaceContextTabsStore.getState()
    expect(state.activeKeyBySpace).toHaveProperty(desktopScopeKey, 'tabdoc:doc-1')
    expect(state.itemsBySpace[desktopScopeKey]?.['tabdoc:doc-1']?.meta).toMatchObject({
      spaceId: 'resource-space-1',
      organizationId: 'org-resource',
      foreignShared: true,
    })
  })
})

describe('openImResourceInCanvas', () => {
  afterEach(() => {
    useAuthStore.setState({ user: null })
    useSpaceStore.setState({ spaces: [], selectedSpace: null })
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
    useSpaceViewPrefsStore.setState({ canvasCollapsedByScopeKey: {} })
  })

  it('opens the resource in the conversation scope and expands the collapsed canvas', () => {
    const scopeKey = 'im:conv-1'
    useSpaceViewPrefsStore.getState().setCanvasCollapsedForScope(scopeKey, true)
    useSpaceStore.setState({
      spaces: [{ id: 'host-space-1', organization_id: 'org-1' }],
      selectedSpace: { id: 'host-space-1', organization_id: 'org-1' },
    } as never)

    openImResourceInCanvas(
      {
        resourceType: 'table',
        resourceId: 'table-123',
        name: '123',
        spaceId: 'resource-space-1',
        organizationId: 'org-1',
      },
      {
        conversationId: 'conv-1',
        scopeKey,
        executionSpaceId: 'host-space-1',
      },
    )

    const tabs = useSpaceContextTabsStore.getState()
    expect(tabs.activeKeyBySpace).toHaveProperty(scopeKey, 'tabdata:table-123')
    expect(useSpaceViewPrefsStore.getState().canvasCollapsedByScopeKey[scopeKey]).toBe(false)
  })
})
