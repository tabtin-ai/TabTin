import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithTabLock } from '../runWithTabLock'
import {
  isLocked,
  resetBrowserTabInputLockForTests,
  setBrowserTabLockListener,
  unlockBySession,
} from '../browserTabInputLock'

describe('runWithTabLock', () => {
  beforeEach(() => {
    resetBrowserTabInputLockForTests()
    setBrowserTabLockListener(vi.fn())
  })

  it('locks before run and unlocks when result has login_required', async () => {
    const result = await runWithTabLock('view-1', async () => {
      expect(isLocked('view-1')).toBe(true)
      return { login_required: { reason: 'auth_wall' } }
    })

    expect(result).toEqual({ login_required: { reason: 'auth_wall' } })
    expect(isLocked('view-1')).toBe(false)
  })

  it('stays locked when result has no wall', async () => {
    await runWithTabLock('view-1', async () => ({ title: 'ok' }))

    expect(isLocked('view-1')).toBe(true)
  })

  it('releases the lock when its session becomes idle', async () => {
    await runWithTabLock('view-1', async () => ({ title: 'ok' }), 'chat-session-one')

    unlockBySession('one')

    expect(isLocked('view-1')).toBe(false)
  })

  it('unlocks when thrown error.info.detail has captcha_required', async () => {
    await expect(
      runWithTabLock('view-1', async () => {
        const error = new Error('captcha') as Error & {
          info?: { detail?: Record<string, unknown> }
        }
        error.info = { detail: { captcha_required: { type: 'recaptcha-v2' } } }
        throw error
      }),
    ).rejects.toThrow('captcha')

    expect(isLocked('view-1')).toBe(false)
  })
})
