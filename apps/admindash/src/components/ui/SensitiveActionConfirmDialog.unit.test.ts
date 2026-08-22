import { describe, expect, it } from 'vitest'
import { getSensitiveActionConfirmState } from './SensitiveActionConfirmDialog'

describe('getSensitiveActionConfirmState', () => {
  it('明确提示删除模型渠道还缺少哪些确认条件', () => {
    expect(getSensitiveActionConfirmState('', '', '删除模型渠道')).toEqual({
      disabled: true,
      hint: '请填写操作原因，并在二次确认框输入“删除模型渠道”',
    })

    expect(getSensitiveActionConfirmState('重复渠道', '', '删除模型渠道')).toEqual({
      disabled: true,
      hint: '请在二次确认框输入“删除模型渠道”',
    })

    expect(getSensitiveActionConfirmState('重复渠道', '删除模型渠道', '删除模型渠道')).toEqual({
      disabled: false,
      hint: '',
    })
  })

  it('业务条件阻断时保持禁用并展示阻断原因', () => {
    expect(
      getSensitiveActionConfirmState(
        '下线旧渠道',
        '删除模型渠道',
        '删除模型渠道',
        '模型仍被业务场景引用，请先改绑'
      )
    ).toEqual({
      disabled: true,
      hint: '模型仍被业务场景引用，请先改绑',
    })
  })
})
