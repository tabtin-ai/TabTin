import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  countPendingProjectInvitations,
  usePendingProjectInvitationStore,
} from '../usePendingProjectInvitationStore'

const listMyPendingInvitations = vi.fn()

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listMyPendingInvitations: (...args: unknown[]) => listMyPendingInvitations(...args),
  },
}))

describe('usePendingProjectInvitationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePendingProjectInvitationStore.setState({ invitations: [], isLoading: false })
    listMyPendingInvitations.mockResolvedValue([])
  })

  it('refresh 写入待加入列表', async () => {
    listMyPendingInvitations.mockResolvedValue([
      {
        project_id: 'p-1',
        project_name: '上山',
        organization_id: 'org-1',
        inviter_name: '师傅',
        role: 'editor',
        invited_at: '2026-07-21T00:00:00Z',
      },
    ])

    const items = await usePendingProjectInvitationStore.getState().refresh()
    expect(items).toHaveLength(1)
    expect(usePendingProjectInvitationStore.getState().invitations[0]?.project_name).toBe('上山')
  })

  it('慢请求不会覆盖更新的结果', async () => {
    let resolveOld: ((value: unknown[]) => void) | undefined
    const oldRequest = new Promise<unknown[]>((resolve) => {
      resolveOld = resolve
    })
    listMyPendingInvitations
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce([
        {
          project_id: 'p-new',
          project_name: '新邀请',
          organization_id: 'org-2',
          inviter_name: '同事',
          role: 'editor',
          invited_at: '2026-07-21T00:00:00Z',
        },
      ])

    const first = usePendingProjectInvitationStore.getState().refresh()
    const second = await usePendingProjectInvitationStore.getState().refresh()
    expect(second[0]?.project_id).toBe('p-new')

    resolveOld?.([
      {
        project_id: 'p-old',
        project_name: '旧邀请',
        organization_id: 'org-1',
        inviter_name: '旧同事',
        role: 'editor',
        invited_at: '2026-07-21T00:00:00Z',
      },
    ])
    await first

    expect(usePendingProjectInvitationStore.getState().invitations[0]?.project_id).toBe('p-new')
  })

  it('countPendingProjectInvitations 按组织统计', () => {
    expect(countPendingProjectInvitations([
      {
        project_id: 'p-1',
        project_name: '上山',
        organization_id: 'org-1',
        inviter_name: '师傅',
        role: 'editor',
        invited_at: '2026-07-21T00:00:00Z',
      },
      {
        project_id: 'p-2',
        project_name: '下山',
        organization_id: 'org-2',
        inviter_name: '别人',
        role: 'editor',
        invited_at: '2026-07-21T00:00:00Z',
      },
    ], 'org-1')).toBe(1)
    expect(countPendingProjectInvitations([], null)).toBe(0)
  })
})
