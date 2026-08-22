import { beforeEach, describe, expect, it, vi } from 'vitest'

const gatewayState = vi.hoisted(() => {
  const gateway = {
    listener: null as ((envelope: any) => void) | null,
    reconnectHandler: null as (() => void) | null,
    addListener: vi.fn((listener: (envelope: any) => void) => {
      gateway.listener = listener
    }),
    removeListener: vi.fn(),
    onReconnectedEvent: vi.fn((handler: () => void) => {
      gateway.reconnectHandler = handler
    }),
    offReconnectedEvent: vi.fn(),
    request: vi.fn(),
  }

  return gateway
})

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: () => gatewayState,
  }),
}))

let useGitStatusStore: typeof import('../useGitStatusStore').useGitStatusStore

beforeEach(async () => {
  vi.resetModules()
  gatewayState.listener = null
  gatewayState.reconnectHandler = null
  gatewayState.addListener.mockClear()
  gatewayState.removeListener.mockClear()
  gatewayState.onReconnectedEvent.mockClear()
  gatewayState.offReconnectedEvent.mockClear()
  gatewayState.request.mockReset().mockResolvedValue({
    ok: true,
    payload: { diff: 'diff --git a/file.ts b/file.ts' },
  })

  const mod = await import('../useGitStatusStore')
  useGitStatusStore = mod.useGitStatusStore
  useGitStatusStore.setState({
    statusBySpaceId: {},
    diffCache: {},
    diffLoading: new Set(),
  })
  useGitStatusStore.getState().teardownWsListener()
})

describe('useGitStatusStore', () => {
  it('仅接受 space_id 形式的 git.status payload', () => {
    useGitStatusStore.getState().setupWsListener()

    gatewayState.listener?.({
      type: 'git.status',
      payload: {
        space_id: 'space-1',
        git_status: {
          is_repo: true,
          branch: 'main',
          is_dirty: false,
          files: [],
        },
      },
    })

    expect(useGitStatusStore.getState().statusBySpaceId['space-1']).toMatchObject({
      is_repo: true,
      branch: 'main',
    })
  })

  it('requestFileDiff 只发送 space_id', async () => {
    const diff = await useGitStatusStore.getState().requestFileDiff('space-1', 'src/file.ts', true)

    expect(diff).toContain('diff --git')
    expect(gatewayState.request).toHaveBeenCalledWith(
      'git.diff.request',
      expect.objectContaining({
        space_id: 'space-1',
        file_path: 'src/file.ts',
        staged: true,
      }),
      { timeoutMs: 20_000 },
    )
  })
})
