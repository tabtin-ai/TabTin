import { describe, expect, it } from 'vitest'
import {
  collapseActiveSharesByGrantee,
  collapseLatestSharesByGrantee,
  shouldShowSessionShareManager,
} from './sessionShareCollaborators'

describe('collapseActiveSharesByGrantee', () => {
  it('keeps one avatar slot per grantee and ignores pending', () => {
    const collapsed = collapseActiveSharesByGrantee([
      {
        id: 'p1',
        grantee_user_id: 'u1',
        status: 'pending',
        created_at: '2026-08-07T10:00:00Z',
      },
      {
        id: 'a1',
        grantee_user_id: 'u1',
        status: 'active',
        created_at: '2026-08-07T09:00:00Z',
      },
      {
        id: 'a2',
        grantee_user_id: 'u1',
        status: 'active',
        created_at: '2026-08-07T11:00:00Z',
      },
      {
        id: 'a3',
        grantee_user_id: 'u2',
        status: 'active',
        created_at: '2026-08-07T08:00:00Z',
      },
    ])
    expect(collapsed.map((share) => share.id)).toEqual(['a2', 'a3'])
  })

  it('keeps the manager visible when only pending or revoked rows remain', () => {
    const shares = [
      { id: 'p1', grantee_user_id: 'u1', status: 'pending' },
      { id: 'r1', grantee_user_id: 'u2', status: 'revoked' },
    ]
    expect(shouldShowSessionShareManager(shares)).toBe(true)
    expect(collapseActiveSharesByGrantee(shares)).toEqual([])
  })

  it('uses the latest row for management while pending does not replace an active avatar', () => {
    const shares = [
      { id: 'active', grantee_user_id: 'u1', status: 'active', created_at: '2026-08-07T09:00:00Z' },
      { id: 'pending', grantee_user_id: 'u1', status: 'pending', created_at: '2026-08-07T10:00:00Z' },
    ]
    expect(collapseLatestSharesByGrantee(shares).map(share => share.id)).toEqual(['pending'])
    expect(collapseActiveSharesByGrantee(shares).map(share => share.id)).toEqual(['active'])
  })
})
