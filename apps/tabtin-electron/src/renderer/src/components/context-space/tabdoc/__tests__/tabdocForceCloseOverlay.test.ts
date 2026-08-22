import { describe, expect, it, vi } from 'vitest'
import {
  reloadTabDocAfterForceClose,
  shouldShowTabDocForceCloseOverlay,
} from '../tabdocForceCloseOverlay'

describe('shouldShowTabDocForceCloseOverlay', () => {
  it('does not show force-close overlay when document load error is already visible', () => {
    expect(shouldShowTabDocForceCloseOverlay({ reason: 'auth_failed' }, '无权访问该文档'))
      .toBe(false)
  })

  it('does not show blocking overlay for authentication failures', () => {
    expect(shouldShowTabDocForceCloseOverlay({
      type: 'force_close',
      reason: 'auth_failed',
      code: 4001,
      message: 'Authentication failed, please sign in again',
      timestamp: '2026-07-04T00:00:00.000Z',
    }, null)).toBe(false)
  })

  it('does not show blocking overlay for auth failure close code without reason', () => {
    expect(shouldShowTabDocForceCloseOverlay({ code: 4001 }, null)).toBe(false)
  })

  it('shows force-close overlay for real force-close messages when there is no load error', () => {
    expect(shouldShowTabDocForceCloseOverlay({ reason: 'document_restored' }, null))
      .toBe(true)
  })

  it('keeps blocking overlay for non-auth force-close messages', () => {
    expect(shouldShowTabDocForceCloseOverlay({ reason: 'permission_changed', code: 4004 }, null))
      .toBe(true)
    expect(shouldShowTabDocForceCloseOverlay({ reason: 'document_not_found', code: 4000 }, null))
      .toBe(true)
  })

  it('does not show overlay without a force-close message', () => {
    expect(shouldShowTabDocForceCloseOverlay(null, null)).toBe(false)
  })
})

describe('reloadTabDocAfterForceClose', () => {
  it('starts exactly one recovery path by reloading the document', () => {
    const retryLoad = vi.fn()

    reloadTabDocAfterForceClose(retryLoad)

    expect(retryLoad).toHaveBeenCalledOnce()
  })
})
