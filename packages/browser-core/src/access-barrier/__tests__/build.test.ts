import { describe, expect, it } from 'vitest'
import { buildAccessBarrierFromObserveRaw } from '../build.js'

describe('buildAccessBarrierFromObserveRaw', () => {
  it('auth_wall → kind=login', () => {
    const b = buildAccessBarrierFromObserveRaw(
      { block: { blocked: true, type: 'auth_wall', loginRequired: true, reason: '需要登录', confidence: 0.9 } },
      { pageUrl: 'https://www.xiaohongshu.com/explore', tabId: 't1', sourceTool: 'observe' },
    )
    expect(b).toMatchObject({
      kind: 'login',
      domain: 'xiaohongshu.com',
      tabId: 't1',
      actions: expect.arrayContaining(['resume_same_tab', 'alternate_source', 'abort_this_target']),
    })
  })

  it('captcha.detected geetest → kind=geetest', () => {
    const b = buildAccessBarrierFromObserveRaw(
      { captcha: { detected: true, type: 'geetest', reason: '极验' } },
      { pageUrl: 'https://example.com', sourceTool: 'act' },
    )
    expect(b?.kind).toBe('geetest')
  })

  it('无墙 → null', () => {
    expect(buildAccessBarrierFromObserveRaw({ ok: true }, {})).toBeNull()
  })

  it('captcha 非 geetest → kind=captcha，透传 captchaType', () => {
    const b = buildAccessBarrierFromObserveRaw(
      { captcha: { detected: true, type: 'recaptcha-v2' } },
      { pageUrl: 'https://example.com', tabId: 't2', sourceTool: 'act' },
    )
    expect(b).toMatchObject({
      kind: 'captcha',
      captchaType: 'recaptcha-v2',
      domain: 'example.com',
      tabId: 't2',
    })
  })

  it('loginRequired=true（无 type）也命中登录墙', () => {
    const b = buildAccessBarrierFromObserveRaw(
      { block: { loginRequired: true, reason: '请登录后继续' } },
      { pageUrl: 'https://a.b.com/x', sourceTool: 'observe' },
    )
    expect(b?.kind).toBe('login')
    expect(b?.reason).toBe('请登录后继续')
  })

  it('mfa 不含 alternate_source（defaultActionsForKind 直查）', async () => {
    const { defaultActionsForKind } = await import('../build.js')
    expect(defaultActionsForKind('mfa')).toEqual(['resume_same_tab', 'abort_this_target'])
  })

  it('无效 pageUrl → domain=unknown', () => {
    const b = buildAccessBarrierFromObserveRaw(
      { block: { type: 'auth_wall' } },
      { pageUrl: 'not-a-url', sourceTool: 'observe' },
    )
    expect(b?.domain).toBe('unknown')
  })
})
