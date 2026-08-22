import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSyncTier = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSyncModelParams = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockResolvePersonalRules = vi.hoisted(() => vi.fn().mockResolvedValue('rule-a'))
const mockNotifyWorkspacePaths = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockGetWorkspaceSnapshot = vi.hoisted(() => vi.fn().mockResolvedValue({ snapshot: { allowedPaths: ['/tmp'] } }))

vi.mock('../../../useChatModelStore', () => ({
  useChatModelStore: {
    getState: () => ({
      syncTierForActiveSession: mockSyncTier,
      syncModelParamsForActiveSession: mockSyncModelParams,
    }),
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'user-1' } }),
  },
}))

vi.mock('@/services/personalRulesRuntimeCache', () => ({
  resolvePersonalRulesForRuntime: (...args: unknown[]) => mockResolvePersonalRules(...args),
}))

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: (...args: unknown[]) => mockNotifyWorkspacePaths(...args),
}))

vi.mock('../sendTimingTrace', () => ({
  trackSendTimingTelemetry: vi.fn(),
}))

import { prepareRuntimeDispatchContext } from '../runtimeDispatchPrep'

describe('prepareRuntimeDispatchContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'window', {
      value: {
        tabtin: {
          agentSecurity: {
            getWorkspaceSnapshot: mockGetWorkspaceSnapshot,
          },
        },
      },
      configurable: true,
    })
  })

  it('并行执行模型设置 / personal rules / workspace', async () => {
    const startedAt: Record<string, number> = {}
    const release: Record<string, () => void> = {}
    const gate = (key: string) => new Promise<void>((resolve) => {
      startedAt[key] = performance.now()
      release[key] = resolve
    })

    mockSyncTier.mockImplementationOnce(() => gate('tier'))
    mockSyncModelParams.mockImplementationOnce(() => gate('model_params'))
    mockResolvePersonalRules.mockImplementationOnce(() => gate('rules').then(() => 'rule-a'))
    mockNotifyWorkspacePaths.mockImplementationOnce(() => gate('workspace'))

    const pending = prepareRuntimeDispatchContext({
      sessionId: 'sess-1',
      spaceId: 'space-1',
      currentAgent: { personal_rules: 'from-agent' },
    })

    for (let attempt = 0; attempt < 20 && !startedAt.workspace; attempt += 1) {
      await new Promise(r => setTimeout(r, 5))
    }
    expect(Object.keys(startedAt).sort()).toEqual(['model_params', 'rules', 'tier', 'workspace'])

    release.tier?.()
    release.model_params?.()
    release.rules?.()
    release.workspace?.()

    const result = await pending

    expect(result.personalRules).toBe('rule-a')
    expect(result.workspaceSnapshot).toEqual({ allowedPaths: ['/tmp'] })
    expect(mockSyncTier).toHaveBeenCalledWith('sess-1')
    expect(mockSyncModelParams).toHaveBeenCalledWith('sess-1')
    expect(mockNotifyWorkspacePaths).toHaveBeenCalledWith('space-1')
    expect(mockGetWorkspaceSnapshot).toHaveBeenCalledWith('space-1')
  })

  it('remote 路径可跳过 personal rules 与 workspace', async () => {
    const result = await prepareRuntimeDispatchContext({
      sessionId: 'sess-2',
      includePersonalRules: false,
      includeWorkspace: false,
    })

    expect(result).toEqual({})
    expect(mockSyncTier).toHaveBeenCalledWith('sess-2')
    expect(mockSyncModelParams).toHaveBeenCalledWith('sess-2')
    expect(mockResolvePersonalRules).not.toHaveBeenCalled()
    expect(mockNotifyWorkspacePaths).not.toHaveBeenCalled()
  })

  it('模型参数同步失败时阻止 dispatch 使用旧强度', async () => {
    mockSyncModelParams.mockRejectedValueOnce(new Error('bridge down'))

    await expect(prepareRuntimeDispatchContext({
      sessionId: 'sess-3',
      includePersonalRules: false,
      includeWorkspace: false,
    })).rejects.toThrow('bridge down')
  })
})
