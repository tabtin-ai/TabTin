import { describe, it, expect } from 'vitest'
import { redact, redactJson } from '../redact'

describe('redact', () => {
  it('打码 Bearer token', () => {
    const out = redact('Authorization: Bearer abcdef1234567890TOKEN')
    expect(out).toContain('<redacted>')
    expect(out).not.toContain('abcdef1234567890TOKEN')
  })

  it('打码 JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1Ni00.eyJzdWIiOiIxMjM0In0.abcDEF_123'
    expect(redact(`看起来像 ${jwt} 结束`)).not.toContain(jwt)
  })

  it('打码 key=value 机密字段', () => {
    expect(redact('password=SuperSecret123')).toContain('<redacted>')
    expect(redact('"access_token":"xyz12345abc"')).toContain('<redacted>')
  })

  it('手机号保留前 3 后 4', () => {
    expect(redact('联系人 13812345678')).toBe('联系人 138****5678')
  })

  it('邮箱保留域名', () => {
    expect(redact('user@example.com')).toBe('u***@example.com')
  })

  it('家目录用户名打码（三平台）', () => {
    expect(redact('/Users/alice/project')).toBe('/Users/<user>/project')
    expect(redact('/home/bob/work')).toBe('/home/<user>/work')
    expect(redact('C:\\Users\\charlie\\app')).toBe('C:\\Users\\<user>\\app')
  })

  it('普通可诊断信息不动', () => {
    expect(redact('space=abc agent=xyz count=3')).toBe('space=abc agent=xyz count=3')
  })

  it('非字符串安全返回空串', () => {
    // @ts-expect-error 故意传非字符串验证不抛
    expect(redact(null)).toBe('')
  })
})

describe('redactJson', () => {
  it('序列化后脱敏，保留非敏感字段', () => {
    const out = redactJson({ phone: '13800001111', note: 'ok' })
    expect(out).toContain('138****1111')
    expect(out).toContain('"note"')
    expect(out).not.toContain('13800001111')
  })
})
