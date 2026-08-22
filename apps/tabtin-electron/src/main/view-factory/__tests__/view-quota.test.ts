/**
 * view-quota 纯函数单元测试
 */

import { describe, it, expect } from 'vitest'
import { isGlobalViewQuotaReject } from '../view-quota'

describe('isGlobalViewQuotaReject', () => {
  it('matches global maxTotalViews reject reason', () => {
    expect(isGlobalViewQuotaReject('达到全局最大 View 数限制 (50)')).toBe(true)
  })

  it('does not match run-level quota reject', () => {
    expect(isGlobalViewQuotaReject('配额不足: Run 超限')).toBe(false)
  })

  it('does not match unrelated errors', () => {
    expect(isGlobalViewQuotaReject('View 数量已达上限: 50')).toBe(false)
  })
})
