import { describe, expect, it } from 'vitest'
import { payloadHasUserInterventionWall } from '../wallSignal'

describe('wallSignal', () => {
  it('detects login_required and captcha_required on data and error.detail', () => {
    expect(payloadHasUserInterventionWall({ login_required: { reason: 'login' } })).toBe(true)
    expect(payloadHasUserInterventionWall({ captcha_required: { type: 'recaptcha-v2' } })).toBe(true)
    expect(payloadHasUserInterventionWall({
      ok: false,
      error: { detail: { captcha_required: { type: 'turnstile' } } },
    })).toBe(true)
    expect(payloadHasUserInterventionWall({ ok: true, data: { title: 'ok' } })).toBe(false)
  })

  it('checks payload.data for wall signals', () => {
    expect(payloadHasUserInterventionWall({
      ok: true,
      data: { login_required: { reason: 'auth' } },
    })).toBe(true)
    expect(payloadHasUserInterventionWall({
      ok: true,
      data: { title: 'ok' },
    })).toBe(false)
  })

  it('checks payload.detail for wall signals', () => {
    expect(payloadHasUserInterventionWall({
      detail: { captcha_required: { type: 'hcaptcha' } },
    })).toBe(true)
  })

  it('detects wall signals on Error.info.detail', () => {
    const err = new Error('captcha') as Error & {
      info?: { detail?: Record<string, unknown> }
    }
    err.info = { detail: { captcha_required: { type: 'recaptcha-v2' } } }
    expect(payloadHasUserInterventionWall(err)).toBe(true)
  })

  it('does not treat empty wall objects as signals', () => {
    expect(payloadHasUserInterventionWall({ login_required: {} })).toBe(false)
    expect(payloadHasUserInterventionWall({ captcha_required: null })).toBe(false)
    expect(payloadHasUserInterventionWall({ login_required: '' })).toBe(false)
  })

  it('does not match wall keywords in string values', () => {
    expect(payloadHasUserInterventionWall('login_required')).toBe(false)
    expect(payloadHasUserInterventionWall({ message: 'captcha_required detected' })).toBe(false)
  })
})
