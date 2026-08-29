import { describe, expect, it, beforeEach } from 'vitest'
import {
  __resetAccessBarrierTabTimedOutForTest,
  consumeAccessBarrierTabTimedOut,
  looksLikeAuthWallUrl,
  markAccessBarrierTabTimedOut,
} from '../access-barrier-tab-reuse'

describe('access-barrier-tab-reuse', () => {
  beforeEach(() => {
    __resetAccessBarrierTabTimedOutForTest()
  })

  it('timeout 登记的 tab 消费一次后不再命中', () => {
    markAccessBarrierTabTimedOut('view-1')
    expect(consumeAccessBarrierTabTimedOut('view-1')).toBe(true)
    expect(consumeAccessBarrierTabTimedOut('view-1')).toBe(false)
  })

  it('looksLikeAuthWallUrl 识别常见登录墙路径', () => {
    expect(looksLikeAuthWallUrl('https://www.zhihu.com/signin?next=%2Fhot')).toBe(true)
    expect(looksLikeAuthWallUrl('https://www.xiaohongshu.com/login')).toBe(true)
    expect(looksLikeAuthWallUrl('https://www.zhihu.com/hot')).toBe(false)
    expect(looksLikeAuthWallUrl(undefined)).toBe(false)
  })
})
