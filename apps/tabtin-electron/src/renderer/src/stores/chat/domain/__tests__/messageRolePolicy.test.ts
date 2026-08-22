import { describe, expect, it } from 'vitest'
import { isSystemAuthoredMessage } from '../messageRolePolicy'

describe('isSystemAuthoredMessage', () => {
  it('将工具注入的图片消息识别为系统作者', () => {
    expect(isSystemAuthoredMessage({ source: 'tool_injected' })).toBe(true)
  })

  it('不把真实用户消息识别为系统作者', () => {
    expect(isSystemAuthoredMessage({ source: 'user_input' })).toBe(false)
  })
})
