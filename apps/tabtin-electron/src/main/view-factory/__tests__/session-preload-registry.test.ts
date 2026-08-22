import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRegisteredSessionPreloads,
  createSessionPreloadRegistry,
  ensureFramePreloadRegistered,
} from '../session-preload-registry'

type MockPreloadScript = {
  id?: string
  type?: string
  filePath?: string
}

type MockSession = {
  registerPreloadScript?: ReturnType<typeof vi.fn>
  unregisterPreloadScript?: ReturnType<typeof vi.fn>
  getPreloadScripts?: ReturnType<typeof vi.fn>
  getPreloads?: ReturnType<typeof vi.fn>
  setPreloads?: ReturnType<typeof vi.fn>
}

const { partitionSessions, electronSessionApi } = vi.hoisted(() => {
  const partitionSessions = new Map<string, MockSession>()
  const electronSessionApi = {
    fromPartition: vi.fn((partition: string) => partitionSessions.get(partition)),
    defaultSession: undefined as MockSession | undefined,
  }

  return { partitionSessions, electronSessionApi }
})

vi.mock('electron', () => ({
  session: electronSessionApi,
}))

function createModernSession(existingScripts: MockPreloadScript[] = []): MockSession {
  const scripts = [...existingScripts]

  return {
    registerPreloadScript: vi.fn(({ type, filePath }: { type: string; filePath: string }) => {
      const id = `script-${scripts.length + 1}`
      scripts.push({ id, type, filePath })
      return id
    }),
    unregisterPreloadScript: vi.fn((id: string) => {
      const index = scripts.findIndex((item) => item.id === id)
      if (index >= 0) scripts.splice(index, 1)
    }),
    getPreloadScripts: vi.fn(() => scripts.map((item) => ({ ...item }))),
  }
}

function createLegacySession(initialPreloads: string[] = []): MockSession & { readPreloads: () => string[] } {
  let preloads = [...initialPreloads]

  return {
    getPreloads: vi.fn(() => [...preloads]),
    setPreloads: vi.fn((nextPreloads: string[]) => {
      preloads = [...nextPreloads]
    }),
    readPreloads: () => [...preloads],
  }
}

describe('session-preload-registry', () => {
  const log = vi.fn()

  beforeEach(() => {
    partitionSessions.clear()
    electronSessionApi.defaultSession = undefined
    electronSessionApi.fromPartition.mockClear()
    log.mockClear()
  })

  it('应通过 registerPreloadScript 为隔离 session 注册 frame preload，且避免重复注册', () => {
    const mockSession = createModernSession()
    partitionSessions.set('persist:account-1', mockSession)

    const registry = createSessionPreloadRegistry()
    ensureFramePreloadRegistered('persist:account-1', '/tmp/fingerprint-preload.js', registry, log)
    ensureFramePreloadRegistered('persist:account-1', '/tmp/fingerprint-preload.js', registry, log)

    expect(mockSession.registerPreloadScript).toHaveBeenCalledTimes(1)
    expect(registry.get('persist:account-1')?.get('/tmp/fingerprint-preload.js')).toEqual({
      id: 'script-1',
      filePath: '/tmp/fingerprint-preload.js',
    })
  })

  it('应复用已存在的 preload script，避免重复注册', () => {
    const mockSession = createModernSession([
      {
        id: 'existing-script',
        type: 'frame',
        filePath: '/tmp/fingerprint-preload.js',
      },
    ])
    partitionSessions.set('persist:account-2', mockSession)

    const registry = createSessionPreloadRegistry()
    ensureFramePreloadRegistered('persist:account-2', '/tmp/fingerprint-preload.js', registry, log)

    expect(mockSession.registerPreloadScript).not.toHaveBeenCalled()
    expect(registry.get('persist:account-2')?.get('/tmp/fingerprint-preload.js')).toEqual({
      id: 'existing-script',
      filePath: '/tmp/fingerprint-preload.js',
    })
  })

  it('清理时应注销新版 session API 注册的 preload', async () => {
    const mockSession = createModernSession()
    partitionSessions.set('persist:account-3', mockSession)

    const registry = createSessionPreloadRegistry()
    ensureFramePreloadRegistered('persist:account-3', '/tmp/fingerprint-preload.js', registry, log)

    await cleanupRegisteredSessionPreloads(registry, log)

    expect(mockSession.unregisterPreloadScript).toHaveBeenCalledWith('script-1')
    expect(registry.size).toBe(0)
  })

  it('清理时应能根据 filePath 回查 preload id', async () => {
    const mockSession = createModernSession([
      {
        id: 'existing-script',
        type: 'frame',
        filePath: '/tmp/fingerprint-preload.js',
      },
    ])
    partitionSessions.set('persist:account-4', mockSession)

    const registry = createSessionPreloadRegistry()
    registry.set('persist:account-4', new Map([
      [
        '/tmp/fingerprint-preload.js',
        { id: null, filePath: '/tmp/fingerprint-preload.js' },
      ],
    ]))

    await cleanupRegisteredSessionPreloads(registry, log)

    expect(mockSession.unregisterPreloadScript).toHaveBeenCalledWith('existing-script')
    expect(registry.size).toBe(0)
  })

  it('应兼容旧版 getPreloads/setPreloads，并在清理时保留非托管 preload', async () => {
    const mockSession = createLegacySession(['/tmp/keep.js'])
    partitionSessions.set('temp-task-1', mockSession)

    const registry = createSessionPreloadRegistry()
    ensureFramePreloadRegistered('temp-task-1', '/tmp/fingerprint-preload.js', registry, log)
    ensureFramePreloadRegistered('temp-task-1', '/tmp/fingerprint-preload.js', registry, log)

    expect(mockSession.setPreloads).toHaveBeenCalledTimes(1)
    expect(mockSession.readPreloads()).toEqual(['/tmp/keep.js', '/tmp/fingerprint-preload.js'])

    await cleanupRegisteredSessionPreloads(registry, log)

    expect(mockSession.readPreloads()).toEqual(['/tmp/keep.js'])
    expect(registry.size).toBe(0)
  })
})
