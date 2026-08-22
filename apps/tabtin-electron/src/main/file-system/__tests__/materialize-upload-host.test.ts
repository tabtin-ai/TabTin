import { describe, expect, it } from 'vitest'
import { isAllowedUploadHost } from '../materialize-file-ref'

describe('materialize upload host gate', () => {
  it('allows only listed host', () => {
    expect(
      isAllowedUploadHost('https://bucket.oss-cn-hangzhou.aliyuncs.com/k?sig=1', [
        'bucket.oss-cn-hangzhou.aliyuncs.com',
      ]),
    ).toBe(true)
  })

  it('denies empty allowlist and foreign host', () => {
    expect(isAllowedUploadHost('https://evil.example/upload', [])).toBe(false)
    expect(
      isAllowedUploadHost('https://evil.example/upload', ['bucket.example.com']),
    ).toBe(false)
  })
})
