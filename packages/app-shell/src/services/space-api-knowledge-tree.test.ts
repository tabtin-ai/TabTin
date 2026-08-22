import { beforeEach, describe, expect, it, vi } from 'vitest'

const authenticatedRequest = vi.fn()

vi.mock('./base.js', () => ({
  authenticatedRequest: (...args: unknown[]) => authenticatedRequest(...args),
  apiBaseUrl: () => 'https://api.tabtin.test/api',
  formatApiErrorMessage: vi.fn(),
}))

import { SpaceApiService } from './space-api.js'

describe('SpaceApiService knowledge tree ownership filter', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { organization_id: 'org-1', roots: [] },
      },
    })
  })

  it('#11281 sends owned_only for the root tree', async () => {
    await SpaceApiService.listKnowledgeTree('org-1', {
      item_types: 'tabdoc,tabdata',
      depth: 4,
      owned_only: true,
    })

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/organizations/org-1/knowledge-tree?item_types=tabdoc%2Ctabdata&depth=4&owned_only=true',
      method: 'GET',
    })
  })

  it('#11281 sends owned_only for lazy-loaded children', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { children: [], node_id: 'node-1', node_type: 'tabdoc' } },
    })

    await SpaceApiService.listKnowledgeTreeChildren('org-1', 'node-1', {
      node_type: 'tabdoc',
      item_types: 'tabdoc,tabdata',
      owned_only: true,
    })

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/organizations/org-1/knowledge-tree/nodes/node-1/children?node_type=tabdoc&item_types=tabdoc%2Ctabdata&owned_only=true',
      method: 'GET',
    })
  })
})
