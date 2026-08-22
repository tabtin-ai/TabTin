import { describe, expect, it } from 'vitest'
import { isCommentThreadsCapabilityMissingError } from './commentThreadCapability'

function httpError(message: string, status?: number, code?: string): Error {
  return Object.assign(new Error(message), { status, code })
}

describe('comment thread capability error classification', () => {
  it('只对明确 route/capability 缺失降级', () => {
    expect(
      isCommentThreadsCapabilityMissingError(httpError('HTTP 404', 404)),
    ).toBe(true)
    expect(
      isCommentThreadsCapabilityMissingError(
        httpError('Method Not Allowed', 405),
      ),
    ).toBe(true)
    expect(
      isCommentThreadsCapabilityMissingError(httpError('Not Implemented', 501)),
    ).toBe(true)
    expect(
      isCommentThreadsCapabilityMissingError(
        httpError('unsupported', 400, 'COMMENT_THREADS_NOT_SUPPORTED'),
      ),
    ).toBe(true)
  })

  it.each([
    httpError('请求频率过高，请稍后再试', 429),
    httpError('Network error: Request timeout'),
    httpError('服务暂时不可用，请稍后重试', 500),
    httpError('Service Unavailable', 503),
    httpError('文档不存在', 404, 'DOCUMENT_NOT_FOUND'),
  ])('瞬时或业务错误不降级：$message', (error) => {
    expect(isCommentThreadsCapabilityMissingError(error)).toBe(false)
  })
})
