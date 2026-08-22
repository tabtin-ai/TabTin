import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeAdapters = vi.hoisted(() => ({
  setCrawlToolRunnerFactory: vi.fn(),
}))

vi.mock('@tabtin/action-tools/headless', async (importOriginal) => ({
  ...await importOriginal<any>(),
  setCrawlToolRunnerFactory: runtimeAdapters.setCrawlToolRunnerFactory,
}))

import { BrowserRuntime } from '../src/platform/browser/browser-runtime.js'

function createRuntime(available = true) {
  const listeners = new Map<string, (payload: Record<string, unknown>) => void>()
  const service = {
    isAvailable: vi.fn(() => available),
    setWorkspaceRoot: vi.fn(),
    injectRuntimeAPIs: vi.fn(async () => {}),
    initBrowserCore: vi.fn(async () => {}),
    getChromePath: vi.fn(() => '/chrome'),
    getBrowserMemoryUsage: vi.fn(async () => null),
    on: vi.fn((event, handler) => { listeners.set(event, handler) }),
    dispose: vi.fn(async () => {}),
    openTab: vi.fn(),
    getPageContent: vi.fn(),
    closeTab: vi.fn(),
  }
  const active = new Map<string, any>()
  const recordingManager = {
    marker: 'recording-owner',
    active,
    start: vi.fn(async (runId: string, metadata?: object) => {
      const recording = { runId, startedAt: 'now', actions: [], metadata }
      active.set(runId, recording)
      return recording
    }),
    stop: vi.fn(async (runId: string) => active.get(runId) ?? null),
    stopCurrent: vi.fn(async () => active.values().next().value ?? null),
    getStatus: vi.fn((runId: string) => active.has(runId) ? { recording: true, runId } : null),
    load: vi.fn(async (runId: string) => active.get(runId) ?? null),
    list: vi.fn(async () => [...active.values()]),
    dispose: vi.fn(async () => {}),
  }
  const ports = {
    setMemoryProvider: vi.fn(),
    sendEvent: vi.fn(async () => {}),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const runtime = new BrowserRuntime(
    logger as any,
    '/workspace',
    ports,
    () => service as any,
    () => recordingManager as any,
  )
  return { runtime, service, recordingManager, ports, listeners }
}

describe('BrowserRuntime lifecycle contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeAdapters.setCrawlToolRunnerFactory.mockImplementation(() => undefined)
  })

  it('publishes browser and recording adapters only after core initialization', async () => {
    const { runtime, service, recordingManager } = createRuntime()

    await expect(runtime.start()).resolves.toBe(true)

    expect(service.injectRuntimeAPIs).toHaveBeenCalledBefore(service.initBrowserCore)
    expect(runtimeAdapters.setCrawlToolRunnerFactory).toHaveBeenCalledOnce()
    expect(runtime.isAvailable()).toBe(true)
    await runtime.dispose()
  })

  it('serves browser and recording operations through the explicit runtime seam', async () => {
    const { runtime, service, recordingManager } = createRuntime()
    await runtime.start()

    expect(runtime.useBrowser((browser) => browser)).toBe(service)
    const recording = await runtime.startRecording('run-1', 'tab-1')
    expect(recording.metadata).toEqual({ tabId: 'tab-1' })
    expect(runtime.getRecordingStatus('run-1')).toMatchObject({ recording: true, runId: 'run-1' })
    expect(await runtime.loadRecording('run-1')).toBe(recording)
    expect(await runtime.listRecordings()).toEqual([recording])
    expect(await runtime.stopRecording()).toBe(recording)
    expect(recordingManager.stopCurrent).toHaveBeenCalledOnce()
    await runtime.dispose()
  })

  it('does not expose partial state when browser is unavailable', async () => {
    const { runtime } = createRuntime(false)
    await expect(runtime.start()).resolves.toBe(false)
    expect(runtime.isAvailable()).toBe(false)
  })

  it('disposes partial browser state when core initialization fails', async () => {
    const { runtime, service } = createRuntime()
    service.initBrowserCore.mockRejectedValueOnce(new Error('core failed'))

    await expect(runtime.start()).rejects.toThrow('core failed')

    expect(service.dispose).toHaveBeenCalledOnce()
    expect(runtime.isAvailable()).toBe(false)
  })

  it('rolls back browser and recording state when adapter publication fails', async () => {
    const { runtime, service, recordingManager } = createRuntime()
    runtimeAdapters.setCrawlToolRunnerFactory.mockImplementationOnce(() => { throw new Error('publish failed') })

    await expect(runtime.start()).rejects.toThrow('publish failed')

    expect(recordingManager.dispose).toHaveBeenCalledOnce()
    expect(service.dispose).toHaveBeenCalledOnce()
    expect(runtime.isAvailable()).toBe(false)
  })

  it('withdraws every compatibility adapter before disposal completes', async () => {
    const { runtime, service, recordingManager } = createRuntime()
    await runtime.start()

    await runtime.dispose()

    expect(runtimeAdapters.setCrawlToolRunnerFactory).toHaveBeenLastCalledWith(null)
    expect(recordingManager.dispose).toHaveBeenCalledOnce()
    expect(service.dispose).toHaveBeenCalledOnce()
    expect(runtime.isAvailable()).toBe(false)
  })

  it('rejects a second browser runtime and keeps the published owner intact', async () => {
    const older = createRuntime()
    const newer = createRuntime()
    await older.runtime.start()

    await expect(newer.runtime.start()).rejects.toThrow('already published')

    expect(newer.recordingManager.dispose).toHaveBeenCalledOnce()
    expect(newer.service.dispose).toHaveBeenCalledOnce()
    await older.runtime.dispose()
  })
})
