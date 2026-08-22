import { describe, expect, it } from 'vitest'
import { isImportPreviewNetworkError, mapImportPreviewError } from './mapImportPreviewError'

const t = (key: string) => key

describe('mapImportPreviewError', () => {
  it('识别 TLS / ECONNRESET 等网络错误并映射稳定提示', () => {
    const tlsError = Object.assign(
      new Error('Network error: Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET', reason: 'Client network socket disconnected before secure TLS connection was established' },
    )

    expect(isImportPreviewNetworkError(tlsError)).toBe(true)
    expect(mapImportPreviewError(tlsError, t)).toBe('errors.previewNetworkUnstable')
  })

  it('普通业务错误保留原 message', () => {
    expect(mapImportPreviewError(new Error('缺少 field_mapping'), t)).toBe('缺少 field_mapping')
    expect(isImportPreviewNetworkError(new Error('缺少 field_mapping'))).toBe(false)
  })

  it('无 message 时回退到通用预览失败文案', () => {
    expect(mapImportPreviewError({}, t)).toBe('errors.previewFailed')
  })
})
