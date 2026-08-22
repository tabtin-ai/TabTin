import { describe, it, expect } from 'vitest'
import { scrubSentryEvent } from '../sentry-scrub.js'

describe('scrubSentryEvent（契约：docs/agent/error-context-schema.md 脱敏红线）', () => {
  it('message / exception values 里的敏感值被脱敏', () => {
    const event = scrubSentryEvent({
      message: 'login failed for 13812345678',
      exception: {
        values: [{ value: 'Bearer abcdef1234567890 rejected at /Users/alice/app' }],
      },
    })
    expect(event.message).not.toContain('13812345678')
    expect(event.exception!.values![0].value).not.toContain('abcdef1234567890')
    expect(event.exception!.values![0].value).toContain('/Users/<user>')
  })

  it('面包屑 message 与 data 字符串值都被脱敏', () => {
    const event = scrubSentryEvent({
      breadcrumbs: [
        {
          message: 'GET /api?access_token=verysecret123 → 200',
          data: { url: '/api?access_token=verysecret123', status_code: 200 },
        },
      ],
    })
    expect(event.breadcrumbs![0].message).not.toContain('verysecret123')
    expect(event.breadcrumbs![0].data!.url).not.toContain('verysecret123')
    expect(event.breadcrumbs![0].data!.status_code).toBe(200)
  })

  it('请求体整体丢弃（内容性现场不出境），query/url 脱敏', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'http://x/api?email=someone@example.com',
        query_string: 'phone=13812345678',
        data: { password: 'hunter22' },
      },
    })
    expect(event.request).not.toHaveProperty('data')
    expect(event.request!.query_string).not.toContain('13812345678')
    expect(event.request!.url).not.toContain('someone@example.com')
  })

  it('请求头、Cookie 和用户展示身份整体丢弃', () => {
    const event = scrubSentryEvent({
      user: { id: 'user-1', username: '张三', email: 'someone@example.com' },
      request: {
        headers: { Authorization: 'Bearer abcdef1234567890', Cookie: 'sid=secret' },
        cookies: { sid: 'secret' },
      },
    })

    expect(event.user).toEqual({ id: 'user-1' })
    expect(event.request).not.toHaveProperty('headers')
    expect(event.request).not.toHaveProperty('cookies')
  })

  it('空事件原样通过', () => {
    expect(scrubSentryEvent({})).toEqual({})
  })

  it('server_name（用户设备主机名，常含真名）整体丢弃', () => {
    const event = scrubSentryEvent({
      message: 'boom',
      server_name: 'zhangsandeMac-mini.local',
    } as Record<string, unknown>)
    expect(event).not.toHaveProperty('server_name')
    expect(event.message).toBe('boom')
  })
  it('redacts user names from stack frame paths and nested breadcrumb data', () => {
    const event = scrubSentryEvent({
      exception: {
        values: [{
          stacktrace: {
            frames: [
              { abs_path: 'C:\\Users\\Alice\\TabTin\\main.js', filename: 'C:\\Users\\Alice\\main.js' },
              { abs_path: '/Users/Alice/TabTin/main.js', filename: '/home/alice/main.js' },
            ],
          },
        }],
      },
      breadcrumbs: [{ data: { request: { url: '/api?email=alice@example.com' } } }],
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('Alice')
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).toContain('<user>')
  })
})
