import { describe, expect, it } from 'vitest'
import { resolveReadReceiptMemberPresentation } from './readReceiptMemberPresentation'

describe('resolveReadReceiptMemberPresentation', () => {
  it('prefers the TabTin nickname over the Tencent account-style nickname', () => {
    expect(resolveReadReceiptMemberPresentation({
      user_id: 'user-id-5318',
      name: 'user_5318',
      username: 'user_5318',
      avatar: 'tencent-avatar',
    }, {
      nickname: '郑十',
      username: 'user_5318',
      avatar: 'tabtin-avatar',
    })).toEqual({
      name: '郑十',
      avatar: 'tabtin-avatar',
    })
  })
})
