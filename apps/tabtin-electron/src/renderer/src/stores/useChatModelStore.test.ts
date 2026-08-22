import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSessionById = vi.hoisted(() => vi.fn())
const mockGetCurrentSessionId = vi.hoisted(() => vi.fn())
const mockSetSessionContextTier = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }))
const mockSetSessionModelParamOverrides = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }))
const mockSetSessionFields = vi.hoisted(() => vi.fn())
const mockListModels = vi.hoisted(() => vi.fn())
const mockSwitchModel = vi.hoisted(() => vi.fn())
const mockUpdateModelParams = vi.hoisted(() => vi.fn())
const mockEffectiveOrganizationId = vi.hoisted(() => ({ value: 'org-a' as string | null }))

vi.mock('./chat/shared/storeAccessRegistry', () => ({
  getChatSessionAccess: () => ({
    getSessionById: mockGetSessionById,
    getCurrentSessionId: mockGetCurrentSessionId,
    setSessionFields: mockSetSessionFields,
  }),
  registerChatSessionAccess: vi.fn(),
  registerChatStoreCallbacks: vi.fn(),
  getChatStoreCallbacks: vi.fn(() => null),
  registerHitlStoreAccess: vi.fn(),
  getHitlStoreAccess: vi.fn(() => null),
}))

vi.mock('../services/chatApi', () => ({
  getChatClient: () => ({
    models: {
      list: mockListModels,
      switchModel: mockSwitchModel,
      updateModelParams: mockUpdateModelParams,
    },
  }),
}))

vi.mock('@/i18n', () => ({ default: { t: (k: string) => k } }))

vi.mock('@/utils/provider-registry', () => ({ updateProviderMetas: vi.fn() }))

vi.mock('./useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      getEffectiveOrganizationId: () => mockEffectiveOrganizationId.value,
    }),
    subscribe: vi.fn(() => vi.fn()),
  },
}))

import { useChatModelStore } from './useChatModelStore'

function setSessionTier(sessionId: string, tierId: string | null): void {
  mockGetSessionById.mockImplementation((id: string) =>
    id === sessionId ? { id, context_tier_id: tierId } : undefined,
  )
}

function setSessionModelParams(
  sessionId: string,
  modelParamOverrides: Record<string, string | number | boolean> | null,
  currentModelId = 'model-current',
): void {
  mockGetSessionById.mockImplementation((id: string) =>
    id === sessionId
      ? {
          id,
          current_model_id: currentModelId,
          model_param_overrides: modelParamOverrides,
        }
      : undefined,
  )
}

describe('syncTierForActiveSession 去重', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetSessionContextTier.mockResolvedValue({ success: true })
    // 每个用例前清空模块级 lastSyncedTierBySession，保证隔离。
    useChatModelStore.getState().reset()
    Object.defineProperty(globalThis, 'window', {
      value: {
        tabtin: {
          agentEngine: {
            setSessionContextTier: mockSetSessionContextTier,
          },
        },
      },
      configurable: true,
    })
  })

  it('首次同步会推给 main 进程', async () => {
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(1)
    expect(mockSetSessionContextTier).toHaveBeenCalledWith('sess-1', 'tier-1m')
  })

  it('值未变的重复同步会被跳过（不再重复 IPC）', async () => {
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(1)
  })

  it('档位变化后会再次同步', async () => {
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    setSessionTier('sess-1', 'tier-256k')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(2)
    expect(mockSetSessionContextTier).toHaveBeenNthCalledWith(1, 'sess-1', 'tier-1m')
    expect(mockSetSessionContextTier).toHaveBeenNthCalledWith(2, 'sess-1', 'tier-256k')
  })

  it('不同 session 互不影响去重', async () => {
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    setSessionTier('sess-2', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-2')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(2)
  })

  it('首次为 null（无档位）也会推一次，随后 null 去重', async () => {
    setSessionTier('sess-1', null)
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(1)
    expect(mockSetSessionContextTier).toHaveBeenCalledWith('sess-1', null)
  })

  it('推送失败不记录，下次会重试', async () => {
    setSessionTier('sess-1', 'tier-1m')
    mockSetSessionContextTier.mockRejectedValueOnce(new Error('bridge down'))
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(2)
  })

  it('reset() 清空去重记录，之后同一值会重新推送', async () => {
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    useChatModelStore.getState().reset()
    setSessionTier('sess-1', 'tier-1m')
    await useChatModelStore.getState().syncTierForActiveSession('sess-1')
    expect(mockSetSessionContextTier).toHaveBeenCalledTimes(2)
  })
})

describe('模型运行参数同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetSessionModelParamOverrides.mockResolvedValue({ success: true })
    mockUpdateModelParams.mockImplementation(
      (_sessionId: string, overrides: Record<string, unknown>) =>
        Promise.resolve({ model_param_overrides: overrides }),
    )
    useChatModelStore.getState().reset()
    Object.defineProperty(globalThis, 'window', {
      value: {
        tabtin: {
          agentEngine: {
            setSessionModelParamOverrides: mockSetSessionModelParamOverrides,
          },
        },
      },
      configurable: true,
    })
  })

  it('恢复会话时把 Runtime Profile v2 同步给 main，并对重复值去重', async () => {
    setSessionModelParams('sess-params', {
      v: 2,
      thinking_mode: 'deep',
      reasoning_effort: 'max',
    })

    await useChatModelStore.getState().syncModelParamsForActiveSession('sess-params')
    await useChatModelStore.getState().syncModelParamsForActiveSession('sess-params')

    expect(mockSetSessionModelParamOverrides).toHaveBeenCalledTimes(1)
    expect(mockSetSessionModelParamOverrides).toHaveBeenCalledWith(
      'sess-params',
      {
        v: 2,
        thinking_mode: 'deep',
        reasoning_effort: 'max',
      },
    )
  })

  it('切换模型时不串 thinking_mode：新模型无记录则清除，旧模型进 map', async () => {
    setSessionModelParams('sess-switch', {
      v: 2,
      thinking_mode: 'deep',
    }, 'old-model')
    useChatModelStore.setState({
      modelParamSelectionsBySessionId: {
        'sess-switch': {
          modelId: 'old-model',
          overrides: { v: 2, thinking_mode: 'deep' },
        },
      },
    })
    const nextModelId = '22222222-2222-4222-8222-222222222222'
    mockSwitchModel.mockResolvedValue({
      current_model_id: nextModelId,
      current_model: 'new-model',
      context_tier_id: null,
    })
    mockUpdateModelParams.mockResolvedValue({
      model_param_overrides: { v: 2 },
    })

    await useChatModelStore.getState().switchModel('sess-switch', nextModelId)

    const overrides = mockSetSessionFields.mock.calls.at(-1)?.[1]
      ?.model_param_overrides as Record<string, unknown>
    expect(overrides.thinking_mode).toBeUndefined()
    expect(JSON.parse(String(overrides.thinking_by_model))).toEqual({
      'old-model': 'deep',
    })
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-switch'].modelId,
    ).toBe(nextModelId)
  })

  it('切换模型时不串 performance_profile：新模型无记录则清除', async () => {
    setSessionModelParams('sess-switch', {
      v: 2,
      thinking_mode: 'deep',
      performance_profile: 'fast',
    }, 'old-model')
    useChatModelStore.setState({
      modelParamSelectionsBySessionId: {
        'sess-switch': {
          modelId: 'old-model',
          overrides: {
            v: 2,
            thinking_mode: 'deep',
            performance_profile: 'fast',
          },
        },
      },
    })
    const nextModelId = '22222222-2222-4222-8222-222222222223'
    mockSwitchModel.mockResolvedValue({
      current_model_id: nextModelId,
      current_model: 'new-model',
      context_tier_id: null,
    })
    mockUpdateModelParams.mockResolvedValue({
      model_param_overrides: { v: 2 },
    })

    await useChatModelStore.getState().switchModel('sess-switch', nextModelId)

    const overrides = mockSetSessionFields.mock.calls.at(-1)?.[1]
      ?.model_param_overrides as Record<string, unknown>
    expect(overrides.thinking_mode).toBeUndefined()
    expect(overrides.performance_profile).toBeUndefined()
    expect(JSON.parse(String(overrides.thinking_by_model))).toEqual({
      'old-model': 'deep',
    })
    expect(JSON.parse(String(overrides.performance_by_model))).toEqual({
      'old-model': 'fast',
    })
  })

  it('切到 unsupported 模型时清除生效 thinking，不因旧意图刷 banner', async () => {
    const { useChatRuntimeStore } = await import('./useChatRuntimeStore')
    useChatRuntimeStore.getState().reset()

    setSessionModelParams('sess-switch', {
      v: 2,
      thinking_mode: 'deep',
    }, 'old-model')
    const nextModelId = '33333333-3333-4333-8333-333333333333'
    useChatModelStore.setState({
      availableModels: [
        {
          id: nextModelId,
          name: 'plain-model',
          display_name: 'Plain',
          provider: 'test',
          provider_display_name: 'Test',
          description: '',
          max_tokens: 1,
          supports_streaming: true,
          supports_vision: false,
          cost_per_1k_tokens: 0,
          is_default: false,
          runtime_profile: {
            thinking: {
              supported: false,
              modes: [],
              default_mode: 'standard',
            },
          },
        },
      ] as never,
      modelParamSelectionsBySessionId: {
        'sess-switch': {
          modelId: 'old-model',
          overrides: { v: 2, thinking_mode: 'deep' },
        },
      },
    })
    mockSwitchModel.mockResolvedValue({
      current_model_id: nextModelId,
      current_model: 'plain-model',
      context_tier_id: null,
    })
    mockUpdateModelParams.mockResolvedValue({
      model_param_overrides: { v: 2 },
    })

    await useChatModelStore.getState().switchModel('sess-switch', nextModelId)

    const overrides = mockSetSessionFields.mock.calls.at(-1)?.[1]
      ?.model_param_overrides as Record<string, unknown>
    expect(overrides.thinking_mode).toBeUndefined()
    const banners = useChatRuntimeStore.getState().capabilityBannersBySessionId['sess-switch']
    expect(banners ?? []).toHaveLength(0)
  })

  it('切到本机 Codex：按模型隔离，不调用 Django updateModelParams', async () => {
    setSessionModelParams('sess-switch', {
      v: 2,
      thinking_mode: 'standard',
    }, 'old-model')
    Object.assign(window.tabtin!, {
      openaiCodex: {
        getStatus: vi.fn().mockResolvedValue({ connected: true }),
      },
    })

    await useChatModelStore.getState().switchModel('sess-switch', 'gpt-5.4')

    expect(mockUpdateModelParams).not.toHaveBeenCalled()
    expect(mockSwitchModel).not.toHaveBeenCalled()
    const overrides = mockSetSessionFields.mock.calls.at(-1)?.[1]
      ?.model_param_overrides as Record<string, unknown>
    expect(overrides.thinking_mode).toBeUndefined()
    expect(JSON.parse(String(overrides.thinking_by_model))).toEqual({
      'old-model': 'standard',
    })
  })

  it('Codex Fast 按模型独立：Sol 开 Fast 后切到 Luna 不应带着 service_tier', async () => {
    setSessionModelParams(
      'sess-switch',
      {
        v: 2,
        thinking_mode: 'standard',
        service_tier: 'fast',
        codex_fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
      },
      'gpt-5.6-sol',
    )
    Object.assign(window.tabtin!, {
      openaiCodex: {
        getStatus: vi.fn().mockResolvedValue({ connected: true }),
      },
    })

    await useChatModelStore.getState().switchModel('sess-switch', 'gpt-5.6-luna')

    const lunaOverrides = mockSetSessionFields.mock.calls.at(-1)?.[1]
      ?.model_param_overrides as Record<string, unknown>
    expect(lunaOverrides.thinking_mode).toBeUndefined()
    expect(JSON.parse(String(lunaOverrides.thinking_by_model))).toEqual({
      'gpt-5.6-sol': 'standard',
    })
    expect(lunaOverrides).not.toHaveProperty('service_tier')
    expect(
      lunaOverrides.fast_by_model || lunaOverrides.codex_fast_by_model,
    ).toBe(JSON.stringify({ 'gpt-5.6-sol': true }))
  })

  it('本机 Codex 写 service_tier 时同步 map，且不打 Django updateModelParams', async () => {
    setSessionModelParams('sess-params', { v: 2, thinking_mode: 'standard' }, 'gpt-5.6-sol')
    Object.assign(window.tabtin!, {
      openaiCodex: {
        getStatus: vi.fn().mockResolvedValue({ connected: true }),
      },
    })

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'service_tier',
      'fast',
    )

    expect(mockUpdateModelParams).not.toHaveBeenCalled()
    expect(mockSetSessionFields).toHaveBeenCalledWith(
      'sess-params',
      {
        model_param_overrides: expect.objectContaining({
          v: 2,
          thinking_mode: 'standard',
          service_tier: 'fast',
          fast_by_model: JSON.stringify({ 'gpt-5.6-sol': true }),
        }),
      },
    )
  })

  it('本机 Codex 写 reasoning_effort 时保留 effort 供右栏高亮，不升级成 thinking_mode', async () => {
    setSessionModelParams('sess-params', { v: 2, thinking_mode: 'standard' }, 'gpt-5.6-sol')
    Object.assign(window.tabtin!, {
      openaiCodex: {
        getStatus: vi.fn().mockResolvedValue({ connected: true }),
      },
    })

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'reasoning_effort',
      'high',
    )

    expect(mockUpdateModelParams).not.toHaveBeenCalled()
    expect(mockSetSessionFields).toHaveBeenCalledWith(
      'sess-params',
      {
        model_param_overrides: {
          v: 2,
          reasoning_effort: 'high',
        },
      },
    )
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-params'],
    ).toEqual({
      modelId: 'gpt-5.6-sol',
      overrides: {
        v: 2,
        reasoning_effort: 'high',
      },
    })

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'reasoning_effort',
      null,
    )
    expect(mockSetSessionFields).toHaveBeenLastCalledWith(
      'sess-params',
      { model_param_overrides: null },
    )
  })

  it('切换思考强度时以 v2 意图持久化，不回写可推导的 reasoning_effort', async () => {
    setSessionModelParams('sess-params', null)
    mockUpdateModelParams.mockResolvedValue({
      model_param_overrides: {
        v: 2,
        thinking_mode: 'deep',
        thinking_by_model: JSON.stringify({ 'model-current': 'deep' }),
      },
    })

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'reasoning_effort',
      'high',
    )

    const expected = {
      v: 2,
      thinking_mode: 'deep',
      thinking_by_model: JSON.stringify({ 'model-current': 'deep' }),
    }
    expect(mockUpdateModelParams).toHaveBeenCalledWith('sess-params', expected)
    expect(mockSetSessionFields).toHaveBeenCalledWith(
      'sess-params',
      { model_param_overrides: expected },
    )
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-params'],
    ).toEqual({
      modelId: 'model-current',
      overrides: expected,
    })
  })

  it('旧后端 v1 响应可升级为 v2，客户端不异常', async () => {
    mockUpdateModelParams.mockResolvedValueOnce({
      model_param_overrides: { reasoning_effort: 'medium' },
    })
    setSessionModelParams('sess-params', null)

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'thinking_mode',
      'standard',
    )

    expect(mockSetSessionFields).toHaveBeenLastCalledWith(
      'sess-params',
      {
        model_param_overrides: {
          v: 2,
          thinking_mode: 'standard',
          thinking_by_model: JSON.stringify({ 'model-current': 'standard' }),
        },
      },
    )
  })

  it('首发前再次切到参数所属模型时保留 Runtime Profile', async () => {
    const modelId = '22222222-2222-4222-8222-222222222222'
    setSessionModelParams('sess-params', null, modelId)
    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'thinking_mode',
      'deep',
    )
    mockSwitchModel.mockClear()

    await useChatModelStore.getState().switchModel('sess-params', modelId)

    expect(mockSwitchModel).not.toHaveBeenCalled()
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-params'],
    ).toEqual({
      modelId,
      overrides: {
        v: 2,
        thinking_mode: 'deep',
        thinking_by_model: JSON.stringify({ [modelId]: 'deep' }),
      },
    })
  })

  it('会话列表尚未回填时，连续调整参数会合并 thinking 与 performance_profile', async () => {
    setSessionModelParams('sess-params', null)

    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'thinking_mode',
      'deep',
    )
    await useChatModelStore.getState().setModelParamOverride(
      'sess-params',
      'performance_profile',
      'fast',
    )

    const expected = {
      v: 2,
      thinking_mode: 'deep',
      performance_profile: 'fast',
      thinking_by_model: JSON.stringify({ 'model-current': 'deep' }),
      performance_by_model: JSON.stringify({ 'model-current': 'fast' }),
    }
    expect(mockUpdateModelParams).toHaveBeenLastCalledWith(
      'sess-params',
      expected,
    )
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-params'],
    ).toEqual({
      modelId: 'model-current',
      overrides: expected,
    })
  })

  it('切回曾配置过的模型时恢复其 thinking_mode', async () => {
    setSessionModelParams('sess-switch', null, 'evolving')
    mockUpdateModelParams.mockImplementation(
      (_sessionId: string, overrides: Record<string, unknown>) =>
        Promise.resolve({ model_param_overrides: overrides }),
    )
    await useChatModelStore.getState().setModelParamOverride(
      'sess-switch',
      'thinking_mode',
      'deep',
    )
    const liteId = '22222222-2222-4222-8222-222222222224'
    mockSwitchModel.mockResolvedValue({
      current_model_id: liteId,
      current_model: 'lite',
      context_tier_id: null,
    })
    await useChatModelStore.getState().switchModel('sess-switch', liteId)
    const afterLite = useChatModelStore.getState()
      .modelParamSelectionsBySessionId['sess-switch'].overrides
    expect(afterLite.thinking_mode).toBeUndefined()

    mockSwitchModel.mockResolvedValue({
      current_model_id: 'evolving',
      current_model: 'evolving',
      context_tier_id: null,
    })
    // session mock 需跟上当前模型，便于 seed / apply
    setSessionModelParams('sess-switch', afterLite as never, liteId)
    useChatModelStore.setState({
      modelParamSelectionsBySessionId: {
        'sess-switch': {
          modelId: liteId,
          overrides: afterLite,
        },
      },
    })
    await useChatModelStore.getState().switchModel('sess-switch', 'evolving')
    expect(
      useChatModelStore.getState()
        .modelParamSelectionsBySessionId['sess-switch'].overrides.thinking_mode,
    ).toBe('deep')
  })

  it('发送前同步失败时向上抛出，避免继续使用 main 中的旧强度', async () => {
    setSessionModelParams('sess-params', { v: 2, thinking_mode: 'deep' })
    mockSetSessionModelParamOverrides.mockRejectedValueOnce(
      new Error('bridge down'),
    )

    await expect(
      useChatModelStore.getState().syncModelParamsForActiveSession('sess-params'),
    ).rejects.toThrow('bridge down')
  })
})

describe('Organization 模型列表隔离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEffectiveOrganizationId.value = 'org-a'
    useChatModelStore.getState().reset()
  })

  it('切换 Organization 时新列表不会被旧请求覆盖', async () => {
    let resolveOrganizationA!: (value: unknown) => void
    const organizationAResponse = new Promise(resolve => {
      resolveOrganizationA = resolve
    })
    mockListModels.mockImplementation((organizationId: string) => {
      if (organizationId === 'org-a') return organizationAResponse
      return Promise.resolve({
        models: [{ id: '22222222-2222-4222-8222-222222222222', name: 'model-b' }],
        default_model_name: 'model-b',
      })
    })

    const organizationARequest = useChatModelStore.getState().loadModels('org-a')
    mockEffectiveOrganizationId.value = 'org-b'
    const organizationBRequest = useChatModelStore.getState().loadModels('org-b')
    await organizationBRequest

    resolveOrganizationA({
      models: [{ id: '11111111-1111-4111-8111-111111111111', name: 'model-a' }],
      default_model_name: 'model-a',
    })
    await organizationARequest

    expect(mockListModels).toHaveBeenCalledTimes(2)
    expect(mockListModels).toHaveBeenNthCalledWith(1, 'org-a')
    expect(mockListModels).toHaveBeenNthCalledWith(2, 'org-b')
    expect(useChatModelStore.getState().loadedOrganizationId).toBe('org-b')
    expect(useChatModelStore.getState().availableModels.map(model => model.name)).toEqual(['model-b'])
  })
})

describe('专项点券余额静默刷新', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEffectiveOrganizationId.value = 'org-a'
    useChatModelStore.getState().reset()
  })

  it('发送完成后用目录最新值更新现有模型，不清空模型列表', async () => {
    const model = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'doubao-seed-evolving',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }
    useChatModelStore.setState({
      availableModels: [model],
      loadedOrganizationId: 'org-a',
    } as never)
    mockListModels.mockResolvedValue({
      models: [{
        ...model,
        promotion_credit: {
          ...model.promotion_credit,
          remaining_credits: 9.25,
        },
      }],
      default_model_name: 'doubao-seed-evolving',
    })

    const refresh = useChatModelStore.getState().refreshPromotionCredits('org-a')

    expect(useChatModelStore.getState().availableModels).toHaveLength(1)
    await refresh
    expect(
      useChatModelStore.getState().availableModels[0].promotion_credit?.remaining_credits,
    ).toBe(9.25)
  })

  it('专项额度投影暂时不可用时保留上次余额', async () => {
    const model = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'doubao-seed-evolving',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }
    useChatModelStore.setState({
      availableModels: [model],
      loadedOrganizationId: 'org-a',
    } as never)
    mockListModels.mockResolvedValue({
      models: [{ id: model.id, name: model.name }],
      default_model_name: model.name,
    })

    await useChatModelStore.getState().refreshPromotionCredits('org-a')

    expect(
      useChatModelStore.getState().availableModels[0].promotion_credit?.remaining_credits,
    ).toBe(10)
  })

  it('专项额度真正耗尽时接受服务端显式 null', async () => {
    const model = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'doubao-seed-evolving',
      promotion_credit: {
        eligible: true,
        remaining_credits: 1,
        total_credits: 10,
      },
    }
    useChatModelStore.setState({
      availableModels: [model],
      loadedOrganizationId: 'org-a',
    } as never)
    mockListModels.mockResolvedValue({
      models: [{ ...model, promotion_credit: null }],
      default_model_name: model.name,
    })

    await useChatModelStore.getState().refreshPromotionCredits('org-a')

    expect(useChatModelStore.getState().availableModels[0].promotion_credit).toBeNull()
  })

  it('目录请求失败时保留上次余额', async () => {
    const model = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'doubao-seed-evolving',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }
    useChatModelStore.setState({
      availableModels: [model],
      loadedOrganizationId: 'org-a',
    } as never)
    mockListModels.mockRejectedValue(new Error('catalog unavailable'))

    await useChatModelStore.getState().refreshPromotionCredits('org-a')

    expect(
      useChatModelStore.getState().availableModels[0].promotion_credit?.remaining_credits,
    ).toBe(10)
  })

  it('完整目录加载后忽略更早发起的余额刷新响应', async () => {
    let resolveOldRefresh!: (value: unknown) => void
    const oldRefresh = new Promise(resolve => {
      resolveOldRefresh = resolve
    })
    const model = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'doubao-seed-evolving',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }
    useChatModelStore.setState({
      availableModels: [model],
      loadedOrganizationId: 'org-a',
    } as never)
    mockListModels
      .mockImplementationOnce(() => oldRefresh)
      .mockResolvedValueOnce({
        models: [{
          ...model,
          promotion_credit: {
            ...model.promotion_credit,
            remaining_credits: 8,
          },
        }],
        default_model_name: model.name,
      })

    const refreshRequest = useChatModelStore.getState().refreshPromotionCredits('org-a')
    await useChatModelStore.getState().loadModels('org-a')
    resolveOldRefresh({
      models: [{
        ...model,
        promotion_credit: {
          ...model.promotion_credit,
          remaining_credits: 9,
        },
      }],
      default_model_name: model.name,
    })
    await refreshRequest

    expect(
      useChatModelStore.getState().availableModels[0].promotion_credit?.remaining_credits,
    ).toBe(8)
  })
})
