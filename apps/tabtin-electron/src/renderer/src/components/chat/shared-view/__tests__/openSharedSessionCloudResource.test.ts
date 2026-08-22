import { beforeEach, describe, expect, it, vi } from 'vitest'

const openSharedResourceTab = vi.fn()
const expandCanvasForScope = vi.fn()
const ensureSpaceSelectedWithFeedback = vi.fn()

const navigationState = {
  currentConversationId: 'im-1' as string | null,
  isIMActive: true,
}

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: (...args: unknown[]) => openSharedResourceTab(...args),
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: (...args: unknown[]) => expandCanvasForScope(...args),
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: (...args: unknown[]) => ensureSpaceSelectedWithFeedback(...args),
}))

const spaceState = {
  spaces: [] as Array<{ id: string; organization_id: string }>,
  selectedSpace: null as { id: string; organization_id: string } | null,
}

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

import {
  mapSharedCloudResourceType,
  openSharedSessionCloudResourceFromBlock,
  resolveSharedSessionHostSpace,
} from '../openSharedSessionCloudResource'

describe('openSharedSessionCloudResource ( A)', () => {
  beforeEach(() => {
    openSharedResourceTab.mockReset()
    expandCanvasForScope.mockReset()
    ensureSpaceSelectedWithFeedback.mockReset()
    ensureSpaceSelectedWithFeedback.mockImplementation(async () => {
      navigationState.currentConversationId = null
      navigationState.isIMActive = false
      return true
    })
    navigationState.currentConversationId = 'im-1'
    navigationState.isIMActive = true
    spaceState.spaces = [
      { id: 'host-1', organization_id: 'org-1' },
      { id: 'host-2', organization_id: 'org-2' },
    ]
    spaceState.selectedSpace = { id: 'host-1', organization_id: 'org-1' }
  })

  it('maps table/doc aliases', () => {
    expect(mapSharedCloudResourceType('table')).toBe('table')
    expect(mapSharedCloudResourceType('tabdata')).toBe('table')
    expect(mapSharedCloudResourceType('document')).toBe('doc')
    expect(mapSharedCloudResourceType('file')).toBeNull()
  })

  it('opens in the IM canvas without clearing the active conversation', async () => {
    const result = await openSharedSessionCloudResourceFromBlock({
      block: {
        type: 'table',
        resource_id: 'table-1',
        space_id: 'owner-space',
      },
      imCanvas: {
        conversationId: 'im-1',
        scopeKey: 'im:im-1',
        executionSpaceId: 'host-2',
      },
    })

    expect(result).toEqual({ ok: true })
    expect(navigationState).toEqual({
      currentConversationId: 'im-1',
      isIMActive: true,
    })
    expect(openSharedResourceTab).toHaveBeenCalledWith({
      hostSpaceId: 'host-2',
      resourceType: 'table',
      resourceId: 'table-1',
      resourceSpaceId: 'owner-space',
      organizationId: 'org-2',
      title: undefined,
      tabScopeKey: 'im:im-1',
    })
    expect(expandCanvasForScope).toHaveBeenCalledWith('im:im-1')
  })

  it('falls back to selected space + conversationId scope when no IM canvas', async () => {
    const result = await openSharedSessionCloudResourceFromBlock({
      block: { type: 'document', resource_id: 'doc-1' },
      conversationId: 'dm-9',
    })

    expect(result).toEqual({ ok: true })
    expect(navigationState).toEqual({
      currentConversationId: 'im-1',
      isIMActive: true,
    })
    expect(openSharedResourceTab).toHaveBeenCalledWith(
      expect.objectContaining({
        hostSpaceId: 'host-1',
        resourceType: 'doc',
        resourceId: 'doc-1',
        tabScopeKey: 'im:dm-9',
      }),
    )
  })

  it('opens from the native Agent conversation in its explicit tab scope', async () => {
    const result = await openSharedSessionCloudResourceFromBlock({
      block: { type: 'document', resource_id: 'doc-agent' },
      organizationId: 'org-1',
      tabScopeKey: 'conversation:shared-session-1',
    })

    expect(result).toEqual({ ok: true })
    expect(ensureSpaceSelectedWithFeedback).not.toHaveBeenCalled()
    expect(openSharedResourceTab).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: 'doc-agent',
      tabScopeKey: 'conversation:shared-session-1',
    }))
    expect(expandCanvasForScope).toHaveBeenCalledWith('conversation:shared-session-1')
  })

  it('selects the host workspace when opening without a conversation scope', async () => {
    const result = await openSharedSessionCloudResourceFromBlock({
      block: { type: 'table', resource_id: 'table-desktop' },
    })

    expect(result).toEqual({ ok: true })
    expect(ensureSpaceSelectedWithFeedback).toHaveBeenCalledWith('host-1', {
      organizationId: 'org-1',
    })
    expect(openSharedResourceTab).toHaveBeenCalledWith(
      expect.objectContaining({
        hostSpaceId: 'host-1',
        resourceId: 'table-desktop',
      }),
    )
  })

  it('returns unsupported for non cloud resource blocks', async () => {
    const result = await openSharedSessionCloudResourceFromBlock({
      block: { type: 'code', resource_id: 'x' },
    })
    expect(result).toEqual({ ok: false, reason: 'unsupported' })
    expect(openSharedResourceTab).not.toHaveBeenCalled()
  })

  it('resolveSharedSessionHostSpace uses selected space, ignores invisible preferred owner ids', () => {
    expect(resolveSharedSessionHostSpace({})).toEqual({
      hostSpaceId: 'host-1',
      organizationId: 'org-1',
    })
  })

  it('ignores a selected workspace from another organization', () => {
    expect(resolveSharedSessionHostSpace({ organizationId: 'org-2' })).toEqual({
      hostSpaceId: 'host-2',
      organizationId: 'org-2',
    })
  })

  it('does not cross the organization boundary when no matching workspace exists', () => {
    expect(resolveSharedSessionHostSpace({ organizationId: 'org-3' })).toBeNull()
  })

  it('ignores an IM canvas workspace from another organization', () => {
    expect(resolveSharedSessionHostSpace({
      organizationId: 'org-2',
      imCanvas: {
        conversationId: 'im-1',
        scopeKey: 'im:im-1',
        executionSpaceId: 'host-1',
      },
    })).toEqual({
      hostSpaceId: 'host-2',
      organizationId: 'org-2',
    })
  })
})
