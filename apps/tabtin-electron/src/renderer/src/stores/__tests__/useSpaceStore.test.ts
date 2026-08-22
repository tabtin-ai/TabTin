import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLoadSpaces, mockAppShellUseSpaceStore } = vi.hoisted(() => {
  const state = {
    spaces: [] as Array<{ id: string; name: string; organization_id: string }>,
    selectedSpace: null as { id: string } | null,
    isLoading: false,
    error: null as string | null,
    loadSpaces: vi.fn(async (_organizationId: string) => {
      state.spaces = [{ id: 'space-1', name: 'Space 1', organization_id: 'ws-1' }]
    }),
  }

  return {
    mockLoadSpaces: state.loadSpaces,
    mockAppShellUseSpaceStore: {
      getState: () => state,
      setState: (partial: Partial<typeof state>) => {
        Object.assign(state, partial)
      },
    },
  }
})

vi.mock('@tabtin/app-shell', () => ({
  useSpaceStore: mockAppShellUseSpaceStore,
}))

let useSpaceStore: typeof import('../useSpaceStore').useSpaceStore

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  mockAppShellUseSpaceStore.setState({
    spaces: [],
    selectedSpace: null,
    isLoading: false,
    error: null,
  })
  const mod = await import('../useSpaceStore')
  useSpaceStore = mod.useSpaceStore
})

describe('useSpaceStore', () => {
  it('renderer 侧继续重导出 @tabtin/app-shell 的 space store', async () => {
    expect(useSpaceStore).toBe(mockAppShellUseSpaceStore)

    await useSpaceStore.getState().loadSpaces('ws-1')

    expect(mockLoadSpaces).toHaveBeenCalledWith('ws-1')
    expect(useSpaceStore.getState().spaces).toEqual([
      { id: 'space-1', name: 'Space 1', organization_id: 'ws-1' },
    ])
  })
})
