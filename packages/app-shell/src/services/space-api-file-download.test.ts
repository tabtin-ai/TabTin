import { beforeEach, describe, expect, it, vi } from 'vitest'

const authenticatedRequest = vi.fn()

vi.mock('./base.js', () => ({
  authenticatedRequest: (...args: unknown[]) => authenticatedRequest(...args),
  apiBaseUrl: () => 'https://api.tabtin.test/api',
  formatApiErrorMessage: vi.fn(),
}))

import { SpaceApiService } from './space-api.js'

describe('SpaceApiService file download URL errors', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it.each([
    ['organization', 403, () => SpaceApiService.getOrganizationFileDownloadUrl('org-1', 'item-1')],
    ['workspace', 404, () => SpaceApiService.getSpaceFileDownloadUrl('workspace-1', 'item-1')],
  ])('preserves the HTTP status for %s file exchange failures', async (_scope, status, request) => {
    authenticatedRequest.mockResolvedValue({
      status,
      data: { success: false, message: `request failed with ${status}` },
    })

    await expect(request()).rejects.toMatchObject({
      message: `request failed with ${status}`,
      status,
    })
  })
})
