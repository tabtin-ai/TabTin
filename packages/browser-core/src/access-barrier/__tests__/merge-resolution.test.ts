import { describe, expect, it } from 'vitest'
import {
  ACCESS_BARRIER_HITL_ENDED_HINT,
  ACCESS_BARRIER_RESUME_CLEARED_HINT,
  ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT,
  mergeBarrierIntoPayload,
} from '../merge-resolution.js'
import type { AccessBarrier } from '../types.js'

function makeBarrier(overrides: Partial<AccessBarrier> = {}): AccessBarrier {
  return {
    kind: 'login',
    reason: '需要登录',
    domain: 'example.com',
    detectedAt: new Date().toISOString(),
    actions: ['resume_same_tab', 'alternate_source', 'abort_this_target'],
    ...overrides,
  }
}

describe('mergeBarrierIntoPayload', () => {
  it('login 双写保留 barrier.tabId 到 login_required.tab_id', () => {
    const data = mergeBarrierIntoPayload(
      { observed_elements: [] },
      makeBarrier({ tabId: 'tab-xhs' }),
      { action: 'host_unavailable' },
    )
    expect(data.login_required).toMatchObject({
      reason: '需要登录',
      tab_id: 'tab-xhs',
    })
  })

  it('timeout 决议写入 access_barrier_resolution，且 hint 不再教开卡 ask_user', () => {
    const data = mergeBarrierIntoPayload(
      { observed_elements: [] },
      makeBarrier(),
      { action: 'timeout' },
    )
    expect(data.access_barrier_resolution).toEqual({ action: 'timeout' })
    expect(data.login_required).toEqual({
      reason: '需要登录',
      hint: ACCESS_BARRIER_HITL_ENDED_HINT,
    })
    expect(String((data.login_required as { hint: string }).hint)).toMatch(/不要再次用 ask_user/)
  })

  it('resume + 复检 cleared：无 login_required 双写，带 cleared hint', () => {
    const data = mergeBarrierIntoPayload(
      { observed_elements: [{ ref: 'e1' }], page_url: 'https://example.com/hot' },
      makeBarrier(),
      { action: 'resume_same_tab', tabId: 't1' },
      { postResumeRecheck: 'cleared' },
    )
    expect(data.access_barrier_resolution).toEqual({ action: 'resume_same_tab', tabId: 't1' })
    expect(data.login_required).toBeUndefined()
    expect(data.access_barrier_hint).toBe(ACCESS_BARRIER_RESUME_CLEARED_HINT)
    expect(String(data.access_barrier_hint)).not.toMatch(/用 ask_user 卡片/)
  })

  it('resume + 复检 still_blocked：双写用 still_blocked hint', () => {
    const data = mergeBarrierIntoPayload(
      {},
      makeBarrier(),
      { action: 'resume_same_tab', tabId: 't1' },
      { postResumeRecheck: 'still_blocked' },
    )
    expect(data.login_required).toEqual({
      reason: '需要登录',
      hint: ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT,
    })
    expect(String((data.login_required as { hint: string }).hint)).toMatch(/不要再次用 ask_user/)
  })

  it('alternate_source 仍保留开卡类 ask_user 教学 hint（过渡双写）', () => {
    const data = mergeBarrierIntoPayload(
      {},
      makeBarrier(),
      { action: 'alternate_source' },
    )
    expect(data.access_barrier_resolution).toEqual({ action: 'alternate_source' })
    expect(String((data.login_required as { hint: string }).hint)).toMatch(/ask_user/)
  })

  it('host_unavailable 与 timeout 同用 ended hint', () => {
    const data = mergeBarrierIntoPayload(
      {},
      makeBarrier({ kind: 'captcha', captchaType: 'recaptcha-v2' }),
      { action: 'host_unavailable' },
    )
    expect(data.captcha_required).toMatchObject({
      hint: ACCESS_BARRIER_HITL_ENDED_HINT,
      type: 'recaptcha-v2',
    })
  })
})
