import { describe, expect, it } from 'vitest'
import { resolveComposerSendRoute } from '../send/resolveComposerSendRoute'

describe('resolveComposerSendRoute', () => {
  const base = {
    hasContent: true,
    disabled: false,
    messageTooLong: false,
    wsDisconnected: false,
    onCooldown: false,
  }

  it('does not reject IPC sends just because gateway status is disconnected', () => {
    expect(resolveComposerSendRoute({ ...base, wsDisconnected: true })).toBe('direct')
  })

  it('routes direct when online (busy still sends)', () => {
    expect(resolveComposerSendRoute(base)).toBe('direct')
  })

  it('rejects on cooldown', () => {
    expect(resolveComposerSendRoute({ ...base, onCooldown: true })).toBe('reject')
  })
})
