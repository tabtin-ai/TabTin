import { beforeEach, describe, expect, it, vi } from 'vitest'

import { configureAppShell } from '../runtime.js'
import { MemberApiService } from './member-api.js'


vi.mock('@tabtin/config', () => ({
  API_ENDPOINTS: {
    ORGANIZATION_MEMBER: {
      LIST: (organizationId: string) => `/context/organizations/${organizationId}/members`,
    },
  },
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

const transport = vi.fn()

beforeEach(() => {
  transport.mockReset()
  configureAppShell({
    apiBaseUrl: 'http://localhost:6060/api',
    transport,
    auth: { getToken: async () => 'token', getCurrentUserId: () => 'viewer-user' },
    bridge: { setActiveSpace: () => {}, resetChatClient: () => {} },
  })
})

describe('MemberApiService.getIdentitySnapshots', () => {
  it('读取独立历史身份端点，不混入当前成员列表', async () => {
    transport.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          identities: [
            {
              user_id: 'departed-user',
              display_name: '离开时姓名',
              left_at: '2026-08-08T12:00:00+08:00',
            },
          ],
          total: 1,
        },
      },
    })

    const result = await MemberApiService.getIdentitySnapshots('organization-1')

    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      url: 'http://localhost:6060/api/context/organizations/organization-1/members/identity-snapshots',
      method: 'GET',
    }))
    expect(result.identities[0]?.display_name).toBe('离开时姓名')
  })
})
