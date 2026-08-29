import { describe, expect, it } from 'vitest'
import { canUseOrganizationByokScope } from '../byok-organization-scope'

describe('canUseOrganizationByokScope', () => {
  it('团队组织管理员可选组织范围', () => {
    expect(canUseOrganizationByokScope(true, false)).toBe(true)
  })

  it('个人账户即使能管理组织也不能选组织范围', () => {
    expect(canUseOrganizationByokScope(true, true)).toBe(false)
  })

  it('团队组织普通成员不能选组织范围', () => {
    expect(canUseOrganizationByokScope(false, false)).toBe(false)
  })
})
