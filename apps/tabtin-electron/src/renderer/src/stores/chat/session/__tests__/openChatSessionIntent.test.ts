import { afterEach, describe, expect, it } from 'vitest'
import {
  beginOpenChatSessionIntent,
  clearOpenChatSessionIntent,
  getOpenChatSessionIntent,
  resetOpenChatSessionIntentForTests,
} from '../openChatSessionIntent'

describe('openChatSessionIntent', () => {
  afterEach(() => {
    resetOpenChatSessionIntentForTests()
  })

  it('begin 后可读到同 Workspace 的目标会话', () => {
    const token = beginOpenChatSessionIntent('space-1', 'session-b')
    expect(token).toBeGreaterThan(0)
    expect(getOpenChatSessionIntent()).toEqual({
      token,
      spaceId: 'space-1',
      sessionId: 'session-b',
    })
  })

  it('只有匹配 token 才清 intent，旧导航收尾不能抹掉新导航', () => {
    const first = beginOpenChatSessionIntent('space-1', 'session-a')
    const second = beginOpenChatSessionIntent('space-1', 'session-b')
    clearOpenChatSessionIntent(first)
    expect(getOpenChatSessionIntent()).toEqual({
      token: second,
      spaceId: 'space-1',
      sessionId: 'session-b',
    })
    clearOpenChatSessionIntent(second)
    expect(getOpenChatSessionIntent()).toBeNull()
  })
})
