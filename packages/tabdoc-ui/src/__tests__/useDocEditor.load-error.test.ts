import { describe, expect, it, vi } from 'vitest'
import { getDocumentLoadErrorKind, normalizeDocumentLoadError } from '../useDocEditor'

const t = vi.fn((key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key))

describe('normalizeDocumentLoadError', () => {
  it('maps 403 / PERMISSION_DENIED to document permission copy', () => {
    expect(normalizeDocumentLoadError({ status: 403, code: 'PERMISSION_DENIED' }, t))
      .toBe('无权访问该文档，请联系文档所有者申请权限')
    expect(getDocumentLoadErrorKind({ status: 403, code: 'PERMISSION_DENIED' }))
      .toBe('permission_denied')
  })

  it('keeps 401 as an auth/session problem', () => {
    expect(normalizeDocumentLoadError({ statusCode: 401, code: 'UNAUTHORIZED' }, t))
      .toBe('登录已过期，请重新登录后再打开文档')
  })

  it('maps unavailable responses to document missing copy', () => {
    expect(normalizeDocumentLoadError({ status: 404 }, t))
      .toBe('文档不存在或已被删除')
    expect(getDocumentLoadErrorKind({ status: 404 })).toBe('not_found')
    expect(getDocumentLoadErrorKind({ status: 410 })).toBe('not_found')
    expect(getDocumentLoadErrorKind({ code: 'RESOURCE_NOT_FOUND' })).toBe('not_found')
  })

  it('falls back to the original error message for unknown failures', () => {
    expect(normalizeDocumentLoadError(new Error('network down'), t)).toBe('network down')
  })
})
