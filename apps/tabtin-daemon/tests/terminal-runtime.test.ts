import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setPtyManagerAPI, setPtyManagerBridge } = vi.hoisted(() => ({
  setPtyManagerAPI: vi.fn(),
  setPtyManagerBridge: vi.fn(),
}))

vi.mock('@tabtin/action-tools/headless', async (importOriginal) => ({
  ...await importOriginal<any>(),
  setPtyManagerAPI,
  setPtyManagerBridge,
}))

import { TerminalRuntime } from '../src/platform/terminal/terminal-runtime.js'

function createRuntime(initializes = true) {
  const events: string[] = []
  const manager = {
    initialize: vi.fn(async () => initializes),
    isAvailable: vi.fn(() => initializes),
    cleanup: vi.fn(() => events.push('manager.cleanup')),
    getSessionOutput: vi.fn(),
    getAllSessionsWithStatus: vi.fn(),
    executeCommand: vi.fn(),
    spawnAgentSession: vi.fn(),
    getOrSpawnAgentSession: vi.fn(),
    resolveThreadSession: vi.fn(),
    write: vi.fn(),
  }
  const bridge = {
    dispose: vi.fn(async () => { events.push('bridge.dispose') }),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const runtime = new TerminalRuntime(
    { workspace_root: '/workspace' } as any,
    logger as any,
    () => ({}),
    {
      createManager: () => manager as any,
      createAgentBridge: () => bridge as any,
    },
  )
  return { runtime, manager, bridge, events }
}

describe('TerminalRuntime lifecycle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setPtyManagerAPI.mockImplementation(() => undefined)
    setPtyManagerBridge.mockImplementation(() => undefined)
  })

  it('publishes both compatibility adapters only after PTY initialization succeeds', async () => {
    const { runtime, bridge } = createRuntime(true)

    await expect(runtime.start()).resolves.toBe(true)

    expect(runtime.isAvailable()).toBe(true)
    expect(runtime.getAgentBridge()).toBe(bridge)
    expect(setPtyManagerAPI).toHaveBeenCalledOnce()
    expect(setPtyManagerBridge).toHaveBeenCalledWith(bridge)
    await runtime.dispose()
  })

  it('does not publish a partially initialized terminal runtime', async () => {
    const { runtime, manager } = createRuntime(false)

    await expect(runtime.start()).resolves.toBe(false)

    expect(runtime.isAvailable()).toBe(false)
    expect(runtime.getAgentBridge()).toBeNull()
    expect(setPtyManagerAPI).not.toHaveBeenCalled()
    expect(setPtyManagerBridge).not.toHaveBeenCalled()
    expect(manager.cleanup).toHaveBeenCalledOnce()
  })

  it('rolls back the initialized manager and bridge when publication fails', async () => {
    const { runtime, manager, bridge, events } = createRuntime(true)
    setPtyManagerBridge.mockImplementationOnce(() => { throw new Error('publish failed') })

    await expect(runtime.start()).rejects.toThrow('publish failed')

    expect(runtime.isAvailable()).toBe(false)
    expect(runtime.getAgentBridge()).toBeNull()
    expect(events).toEqual(['bridge.dispose', 'manager.cleanup'])
    expect(bridge.dispose).toHaveBeenCalledOnce()
    expect(manager.cleanup).toHaveBeenCalledOnce()
    expect(setPtyManagerBridge).toHaveBeenLastCalledWith(null)
    expect(setPtyManagerAPI).toHaveBeenLastCalledWith(null)
  })

  it('withdraws adapters before disposing bridge and manager in ownership order', async () => {
    const { runtime, events } = createRuntime(true)
    await runtime.start()

    await runtime.dispose()

    expect(setPtyManagerBridge).toHaveBeenLastCalledWith(null)
    expect(setPtyManagerAPI).toHaveBeenLastCalledWith(null)
    expect(events).toEqual(['bridge.dispose', 'manager.cleanup'])
    expect(runtime.isAvailable()).toBe(false)
    expect(runtime.getAgentBridge()).toBeNull()
  })

  it('rejects a second terminal runtime and keeps the published owner intact', async () => {
    const older = createRuntime(true)
    const newer = createRuntime(true)
    await older.runtime.start()

    await expect(newer.runtime.start()).rejects.toThrow('already published')

    expect(newer.bridge.dispose).toHaveBeenCalledOnce()
    expect(newer.manager.cleanup).toHaveBeenCalledOnce()
    expect(setPtyManagerBridge).toHaveBeenLastCalledWith(older.bridge)
    await older.runtime.dispose()
    expect(setPtyManagerBridge).toHaveBeenLastCalledWith(null)
  })
})
