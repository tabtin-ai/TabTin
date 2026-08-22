import { describe, expect, it } from 'vitest'
import { SessionPauseController } from '../src/delivery/session-pause-controller.js'

describe('SessionPauseController', () => {
  it('waits while paused and releases on resume', async () => {
    const gate = new SessionPauseController()
    gate.pause()
    let released = false
    const waiting = gate.waitIfPaused().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(gate.resume()).toBe(true)
    await waiting
    expect(released).toBe(true)
  })

  it('releases on abort so the engine can classify cancellation', async () => {
    const gate = new SessionPauseController()
    const abort = new AbortController()
    gate.pause()
    const waiting = gate.waitIfPaused(abort.signal)
    abort.abort()
    await expect(waiting).resolves.toBeUndefined()
  })
})
