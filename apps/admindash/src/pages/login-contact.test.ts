import { describe, expect, it } from 'vitest'
import { splitRegisterContact } from '@tabtin/shared/auth-forms'

describe('admin login contact', () => {
  it('admin register payload uses email field', () => {
    expect(splitRegisterContact('Admin@Tabtin.local')).toEqual({
      email: 'admin@tabtin.local',
    })
  })

  it('admin register payload uses phone field', () => {
    expect(splitRegisterContact('13800138000')).toEqual({
      phone: '13800138000',
    })
  })
})