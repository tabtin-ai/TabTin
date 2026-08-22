import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  lock,
  unlock,
  unlockBySession,
  isLocked,
  getLockedViewIds,
  setBrowserTabLockListener,
  setOnViewsUnlocked,
  resetBrowserTabInputLockForTests,
} from '../browserTabInputLock'
import { payloadHasUserInterventionWall } from '../wallSignal'

describe('browserTabInputLock', () => {
  let listener = vi.fn<(ids: string[]) => void>()

  beforeEach(() => {
    resetBrowserTabInputLockForTests()
    listener = vi.fn<(ids: string[]) => void>()
    setBrowserTabLockListener(listener)
  })

  it('locks on any use and stays locked until wall unlock', () => {
    lock('view-a')
    expect(isLocked('view-a')).toBe(true)
    expect(getLockedViewIds()).toEqual(['view-a'])
    expect(listener).toHaveBeenLastCalledWith(['view-a'])
    lock('view-a')
    expect(listener).toHaveBeenCalledTimes(1)
    unlock('view-a')
    expect(isLocked('view-a')).toBe(false)
    expect(listener).toHaveBeenLastCalledWith([])
  })

  it('does not unlock other tabs', () => {
    lock('a')
    lock('b')
    unlock('a')
    expect(isLocked('b')).toBe(true)
    expect(getLockedViewIds()).toEqual(['b'])
  })

  it('unlockBySession only releases tabs held by that session', () => {
    lock('tab-a', 'chat-session-one')
    lock('tab-b', 'two')

    unlockBySession('one')

    expect(isLocked('tab-a')).toBe(false)
    expect(isLocked('tab-b')).toBe(true)
  })

  it('keeps a tab locked while another session still holds it', () => {
    lock('shared', 'one')
    lock('shared', 'two')

    unlockBySession('one')
    expect(isLocked('shared')).toBe(true)

    unlockBySession('two')
    expect(isLocked('shared')).toBe(false)
  })

  it('wall unlock clears the tab even if a session still holds it', () => {
    lock('tab-a', 'one')

    unlock('tab-a')

    expect(isLocked('tab-a')).toBe(false)
  })

  it('lock without sessionId stays locked after unlockBySession', () => {
    lock('orphan')

    unlockBySession('one')

    expect(isLocked('orphan')).toBe(true)
  })

  it('unlock notifies onViewsUnlocked with the released view', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('view-a')
    unlock('view-a')
    expect(unlocked).toHaveBeenCalledWith(['view-a'])
  })

  it('unlockBySession notifies only fully released views', () => {
    const unlocked = vi.fn<(ids: string[]) => void>()
    setOnViewsUnlocked(unlocked)
    lock('tab-a', 'one')
    lock('shared', 'one')
    lock('shared', 'two')

    unlockBySession('one')

    expect(unlocked).toHaveBeenCalledWith(['tab-a'])
    unlockBySession('two')
    expect(unlocked).toHaveBeenLastCalledWith(['shared'])
  })
})

describe('payloadHasUserInterventionWall', () => {
  it('detects login_required and captcha_required on data and error.detail', () => {
    expect(payloadHasUserInterventionWall({ login_required: { reason: 'login' } })).toBe(true)
    expect(payloadHasUserInterventionWall({ captcha_required: { type: 'recaptcha-v2' } })).toBe(true)
    expect(payloadHasUserInterventionWall({
      ok: false,
      error: { detail: { captcha_required: { type: 'turnstile' } } },
    })).toBe(true)
    expect(payloadHasUserInterventionWall({ ok: true, data: { title: 'ok' } })).toBe(false)
  })
})
