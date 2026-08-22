import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadOrganizationMock = vi.fn()

vi.mock('@/stores/useCollections', () => ({
  useCollections: {
    getState: () => ({
      loadOrganization: loadOrganizationMock,
      collectionsByOrganizationId: {
        'org-1': [{ id: 'folder-a' }, { id: 'folder-b' }],
      },
    }),
  },
}))

describe('cloudFolderRefresh ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadOrganizationMock.mockResolvedValue(undefined)
  })

  it('shouldForceCloudFolderRefreshOnActivate only on inactive → active edge', async () => {
    const { shouldForceCloudFolderRefreshOnActivate } = await import('../cloudFolderRefresh')

    expect(shouldForceCloudFolderRefreshOnActivate(false, true)).toBe(true)
    expect(shouldForceCloudFolderRefreshOnActivate(true, true)).toBe(false)
    expect(shouldForceCloudFolderRefreshOnActivate(false, false)).toBe(false)
    expect(shouldForceCloudFolderRefreshOnActivate(true, false)).toBe(false)
  })

  it('forceRefreshOrganizationCollections always calls loadOrganization with force=true', async () => {
    const { forceRefreshOrganizationCollections } = await import('../cloudFolderRefresh')

    await forceRefreshOrganizationCollections('org-1', 'activate')

    expect(loadOrganizationMock).toHaveBeenCalledTimes(1)
    expect(loadOrganizationMock).toHaveBeenCalledWith('org-1', true)
  })
})
