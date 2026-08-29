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

  it('HITL park blocks waitIfPaused until releaseHitlPark（主修：有卡就停）', async () => {
    const gate = new SessionPauseController()
    expect(gate.acquireHitlPark()).toBe(1)
    expect(gate.isHitlParked).toBe(true)
    expect(gate.shouldBlock).toBe(true)

    let released = false
    const waiting = gate.waitIfPaused().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)

    expect(gate.releaseHitlPark()).toBe(0)
    expect(gate.isHitlParked).toBe(false)
    await waiting
    expect(released).toBe(true)
  })

  it('HITL park 与手动 pause 正交：只 release 卡不清用户 pause', async () => {
    const gate = new SessionPauseController()
    gate.pause()
    gate.acquireHitlPark()

    let released = false
    const waiting = gate.waitIfPaused().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)

    gate.releaseHitlPark()
    await Promise.resolve()
    expect(released).toBe(false)
    expect(gate.shouldBlock).toBe(true)

    gate.resume()
    await waiting
    expect(released).toBe(true)
  })

  it('HITL park 引用计数：多卡未全部清完时仍挡住', async () => {
    const gate = new SessionPauseController()
    gate.acquireHitlPark()
    gate.acquireHitlPark()
    expect(gate.releaseHitlPark()).toBe(1)
    expect(gate.shouldBlock).toBe(true)

    let released = false
    const waiting = gate.waitIfPaused().then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)

    expect(gate.releaseHitlPark()).toBe(0)
    await waiting
    expect(released).toBe(true)
  })

  it('releaseHitlPark 在计数已为 0 时保持幂等', () => {
    const gate = new SessionPauseController()
    expect(gate.releaseHitlPark()).toBe(0)
    expect(gate.shouldBlock).toBe(false)
  })
})
