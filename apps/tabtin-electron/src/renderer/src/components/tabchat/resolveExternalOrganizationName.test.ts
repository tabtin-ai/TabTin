import { describe, expect, it } from 'vitest'
import { resolveExternalOrganizationName } from './resolveExternalOrganizationName'

describe('resolveExternalOrganizationName', () => {
  it('内部会话不显示组织名', () => {
    expect(resolveExternalOrganizationName({
      isExternal: false,
      isGroup: false,
      localOrganizationName: '合作组织',
    })).toBe('')
  })

  it('外部私聊优先用对端成员的组织名', () => {
    expect(resolveExternalOrganizationName({
      isExternal: true,
      isGroup: false,
      peerUserId: 'user-2',
      peerOrganizationId: 'org-2',
      localOrganizationName: '本机缓存组织',
      members: [
        {
          user_id: 'user-1',
          is_external: false,
          organization_name: '当前组织',
          participant_organization_id: 'org-1',
        },
        {
          user_id: 'user-2',
          is_external: true,
          organization_name: '合作组织',
          participant_organization_id: 'org-2',
        },
      ],
    })).toBe('合作组织')
  })

  it('成员名单尚未带组织名时回退本机已有组织', () => {
    expect(resolveExternalOrganizationName({
      isExternal: true,
      isGroup: false,
      peerOrganizationId: 'org-2',
      localOrganizationName: '本机缓存组织',
      members: [
        { user_id: 'user-2', is_external: true, participant_organization_id: 'org-2' },
      ],
    })).toBe('本机缓存组织')
  })

  it('外部群只有一个对端组织时显示该组织', () => {
    expect(resolveExternalOrganizationName({
      isExternal: true,
      isGroup: true,
      members: [
        { user_id: 'user-2', is_external: true, organization_name: '合作组织' },
        { user_id: 'user-3', is_external: true, organization_name: '合作组织' },
      ],
    })).toBe('合作组织')
  })

  it('外部群有多个对端组织时不猜一个', () => {
    expect(resolveExternalOrganizationName({
      isExternal: true,
      isGroup: true,
      members: [
        { user_id: 'user-2', is_external: true, organization_name: '合作组织' },
        { user_id: 'user-3', is_external: true, organization_name: '另一组织' },
      ],
    })).toBe('')
  })
})
