import { describe, expect, it, vi } from 'vitest'

import { DaemonLifecycle } from '../src/application/lifecycle/daemon-lifecycle.js'

describe('DaemonLifecycle transition contract', () => {
  it('owns the boot to ready transition and rejects duplicate starts', () => {
    const lifecycle = new DaemonLifecycle()
    expect(lifecycle.beginStart()).toBe(true)
    expect(lifecycle.getState()).toBe('starting')
    expect(lifecycle.beginStart()).toBe(false)
    lifecycle.markReady()
    expect(lifecycle.getState()).toBe('running')
  })

  it('shares concurrent start and stop operations instead of returning before completion', async () => {
    const lifecycle = new DaemonLifecycle()
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const start = vi.fn(() => startGate)
    const firstStart = lifecycle.runStart(start, vi.fn())
    const secondStart = lifecycle.runStart(start, vi.fn())
    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
    releaseStart()
    await Promise.all([firstStart, secondStart])
    expect(lifecycle.getState()).toBe('running')

    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const stop = vi.fn(() => stopGate)
    const firstStop = lifecycle.runStop(stop)
    const secondStop = lifecycle.runStop(stop)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    releaseStop()
    await Promise.all([firstStop, secondStop])
    expect(lifecycle.getState()).toBe('stopped')
  })

  it('waits for an in-flight start before stopping resources', async () => {
    const lifecycle = new DaemonLifecycle()
    const events: string[] = []
    let releaseStart!: () => void
    const gate = new Promise<void>(resolve => { releaseStart = resolve })
    const starting = lifecycle.runStart(async () => {
      events.push('start:begin')
      await gate
      events.push('start:end')
    }, async () => { events.push('rollback') })
    await Promise.resolve()

    const stopping = lifecycle.runStop(async () => { events.push('stop') })
    await Promise.resolve()
    expect(events).toEqual(['start:begin'])
    releaseStart()
    await Promise.all([starting, stopping])

    expect(events).toEqual(['start:begin', 'start:end', 'stop'])
    expect(lifecycle.getState()).toBe('stopped')
  })

  it('runs startup rollback directly and reaches stopped without self-waiting', async () => {
    const lifecycle = new DaemonLifecycle()
    const rollback = vi.fn().mockResolvedValue(undefined)

    await expect(lifecycle.runStart(
      async () => { throw new Error('startup failed') },
      rollback,
    )).rejects.toThrow('startup failed')

    expect(rollback).toHaveBeenCalledTimes(1)
    expect(lifecycle.getState()).toBe('stopped')
  })

  it('accepts new tasks only after the complete runtime is ready', () => {
    const lifecycle = new DaemonLifecycle()
    lifecycle.beginStart()
    expect(lifecycle.acceptsNewTasks()).toBe(false)
    lifecycle.markReady()
    expect(lifecycle.acceptsNewTasks()).toBe(true)
    expect(lifecycle.beginDrain()).toBe(true)
    expect(lifecycle.acceptsNewTasks()).toBe(false)
  })

  it('allows startup rollback but does not advertise same-instance restartability', () => {
    const lifecycle = new DaemonLifecycle()
    lifecycle.beginStart()
    expect(lifecycle.beginStop()).toBe(true)
    expect(lifecycle.beginStop()).toBe(false)
    lifecycle.markStopped()
    expect(lifecycle.getState()).toBe('stopped')
    expect(lifecycle.beginStart()).toBe(false)
  })

  it('rejects invalid ready transitions', () => {
    const lifecycle = new DaemonLifecycle()
    expect(() => lifecycle.markReady()).toThrow("Cannot mark daemon ready from 'stopped'")
  })

  it('stops ingress before workloads and infrastructure, reversing order within each phase', async () => {
    const lifecycle = new DaemonLifecycle()
    const events: string[] = []
    const errors: string[] = []
    lifecycle.beginStart()
    lifecycle.own('container', 'infrastructure', () => { events.push('container') })
    lifecycle.own('terminal', 'infrastructure', () => { events.push('terminal') })
    lifecycle.own('agent', 'workload', async () => { events.push('agent') })
    lifecycle.own('mcp', 'ingress', () => { events.push('mcp'); throw new Error('close failed') })
    lifecycle.own('cli', 'ingress', () => { events.push('cli') })
    lifecycle.markReady()
    lifecycle.beginStop()

    await lifecycle.disposeOwned((name) => errors.push(name))

    expect(events).toEqual(['cli', 'mcp', 'agent', 'terminal', 'container'])
    expect(errors).toEqual(['mcp'])
  })

  it('prevents duplicate ownership names from hiding cleanup order', () => {
    const lifecycle = new DaemonLifecycle()
    lifecycle.beginStart()
    lifecycle.own('terminal', 'infrastructure', () => {})
    expect(() => lifecycle.own('terminal', 'infrastructure', () => {})).toThrow("already owned")
  })

  it('can close ingress at beginDrain while retaining workload and infrastructure ownership', async () => {
    const lifecycle = new DaemonLifecycle()
    const events: string[] = []
    lifecycle.beginStart()
    lifecycle.own('socket', 'infrastructure', () => { events.push('socket') })
    lifecycle.own('agent', 'workload', () => { events.push('agent') })
    lifecycle.own('cli', 'ingress', () => { events.push('cli') })
    lifecycle.markReady()
    lifecycle.beginDrain()

    await lifecycle.disposePhase('ingress', () => {})
    expect(events).toEqual(['cli'])

    lifecycle.beginStop()
    await lifecycle.disposeOwned(() => {})
    expect(events).toEqual(['cli', 'agent', 'socket'])
  })
})
