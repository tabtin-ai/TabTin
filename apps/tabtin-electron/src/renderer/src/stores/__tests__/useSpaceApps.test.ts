import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const {
  mockApiRequest,
  mockGetAuthToken,
  mockUseSpaceStore,
} = vi.hoisted(() => {
  const mockSpaces: Array<{ id: string; organization_id: string }> = []
  const mockUseSpaceStore = {
    getState: vi.fn(() => ({ spaces: mockSpaces })),
    _spaces: mockSpaces,
  }
  return {
    mockApiRequest: vi.fn(),
    mockGetAuthToken: vi.fn().mockResolvedValue('token'),
    mockUseSpaceStore,
  }
})

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: mockApiRequest,
  getAuthToken: mockGetAuthToken,
}))

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    useSpaceStore: mockUseSpaceStore,
    registerResetAction: vi.fn(),
    runAllResetActions: vi.fn(),
  }
})

import { useSpaceApps } from '../useSpaceApps'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'tabtin', {
    configurable: true,
    value: {
      ...window.tabtin,
      appDiscovery: { updatePatterns: vi.fn() },
      marketplace: { listInstalled: vi.fn().mockResolvedValue(null) },
    },
  })
  mockUseSpaceStore._spaces.length = 0
  mockUseSpaceStore.getState.mockImplementation(() => ({ spaces: mockUseSpaceStore._spaces }))
  useSpaceApps.getState().reset()
})

describe('useSpaceApps', () => {
  it('对同一个 space 的并发加载只发起一次请求', async () => {
    const deferred = createDeferred<{ data: { apps: Array<{ id: string; enabled: boolean; can_create: boolean }>; disabled_apps: string[] } }>()
    mockApiRequest.mockReturnValueOnce(deferred.promise)

    const first = useSpaceApps.getState().loadSpaceApps('space-1')
    const second = useSpaceApps.getState().loadSpaceApps('space-1')

    await Promise.resolve()

    expect(mockGetAuthToken).toHaveBeenCalledTimes(1)
    expect(mockApiRequest).toHaveBeenCalledTimes(1)

    deferred.resolve({
      data: {
        apps: [{ id: 'tabdata', enabled: true, can_create: true }],
        disabled_apps: ['tabdoc'],
      },
    })

    await Promise.all([first, second])

    const state = useSpaceApps.getState()
    expect(state.appsBySpace['space-1']).toEqual([{ id: 'tabdata', enabled: true, can_create: true }])
    expect(state.disabledBySpace['space-1']).toEqual(['tabdoc'])
    expect(state.loadingSpaces.size).toBe(0)
  })

  it('能正确解包 Django success envelope 响应', async () => {
    mockApiRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        data: {
          apps: [{ id: 'tabdesktop', enabled: true, can_create: false }],
          disabled_apps: ['tabdoc'],
        },
      },
    })

    await useSpaceApps.getState().loadSpaceApps('space-envelope')

    const state = useSpaceApps.getState()
    expect(state.appsBySpace['space-envelope']).toEqual([
      { id: 'tabdesktop', enabled: true, can_create: false },
    ])
    expect(state.disabledBySpace['space-envelope']).toEqual(['tabdoc'])
  })

  describe('invalidateByOrganization', () => {
    it('清除属于指定 organization 的 space 缓存', async () => {
      mockUseSpaceStore._spaces.push(
        { id: 'space-A', organization_id: 'wt-1' },
        { id: 'space-B', organization_id: 'wt-1' },
        { id: 'space-C', organization_id: 'wt-2' },
      )

      useSpaceApps.setState({
        appsBySpace: {
          'space-A': [{ id: 'tabdata', name: 'TabData', icon: 'table', can_create: true, searchable: true, enabled: true, order: 1 }],
          'space-B': [{ id: 'tabdoc', name: 'TabDoc', icon: 'file', can_create: true, searchable: true, enabled: true, order: 2 }],
          'space-C': [{ id: 'tabslide', name: 'TabSlide', icon: 'presentation', can_create: true, searchable: true, enabled: true, order: 3 }],
        },
        disabledBySpace: {
          'space-A': ['tabdoc'],
          'space-B': [],
          'space-C': ['tabdata'],
        },
      })

      useSpaceApps.getState().invalidateByOrganization('wt-1')

      const state = useSpaceApps.getState()
      expect(state.appsBySpace['space-A']).toBeUndefined()
      expect(state.disabledBySpace['space-A']).toBeUndefined()
      expect(state.appsBySpace['space-B']).toBeUndefined()
      expect(state.disabledBySpace['space-B']).toBeUndefined()

      // wt-2 的 space 不受影响
      expect(state.appsBySpace['space-C']).toBeDefined()
      expect(state.disabledBySpace['space-C']).toBeDefined()
    })

    it('organization 无匹配 space 时不修改状态', () => {
      mockUseSpaceStore._spaces.push({ id: 'space-A', organization_id: 'wt-1' })

      useSpaceApps.setState({
        appsBySpace: {
          'space-A': [{ id: 'tabdata', name: 'TabData', icon: 'table', can_create: true, searchable: true, enabled: true, order: 1 }],
        },
        disabledBySpace: { 'space-A': [] },
      })

      const stateBefore = useSpaceApps.getState().appsBySpace

      useSpaceApps.getState().invalidateByOrganization('wt-nonexistent')

      expect(useSpaceApps.getState().appsBySpace).toEqual(stateBefore)
    })

    it('清除 loadingSpaces 中属于该 organization 的条目', () => {
      mockUseSpaceStore._spaces.push({ id: 'space-A', organization_id: 'wt-1' })

      useSpaceApps.setState({
        appsBySpace: {},
        disabledBySpace: {},
        loadingSpaces: new Set(['space-A', 'space-other']),
      })

      useSpaceApps.getState().invalidateByOrganization('wt-1')

      const { loadingSpaces } = useSpaceApps.getState()
      expect(loadingSpaces.has('space-A')).toBe(false)
      expect(loadingSpaces.has('space-other')).toBe(true)
    })
  })
})
