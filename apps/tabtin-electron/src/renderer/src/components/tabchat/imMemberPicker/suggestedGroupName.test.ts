import { describe, expect, it } from 'vitest'
import { suggestedGroupNameFromMembers } from './suggestedGroupName'

describe('suggestedGroupNameFromMembers', () => {
  it('joins selected member display names with顿号', () => {
    const name = suggestedGroupNameFromMembers(
      [
        { user_id: 'u1', user: { nickname: 'Alice' } },
        { user_id: 'u2', user: { username: 'bob' } },
        { user_id: 'u3', user: { nickname: 'Carol' } },
      ],
      new Set(['u1', 'u2']),
    )

    expect(name).toBe('Alice、bob')
  })

  it('uses at most the first five selected member names', () => {
    const name = suggestedGroupNameFromMembers(
      Array.from({ length: 6 }, (_, index) => ({
        user_id: `u${index + 1}`,
        user: { nickname: `成员${index + 1}` },
      })),
      new Set(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']),
    )

    expect(name).toBe('成员1、成员2、成员3、成员4、成员5')
  })
})
