/**
 * useSessionScopedComposerModel：独立 Composer 宿主须自包含 loadModels。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@tabtin/chat-client'

const loadModels = vi.fn(async () => {})
const switchModel = vi.fn(async () => {})
const switchContextTier = vi.fn(async () => {})
const setModelParamOverride = vi.fn(async () => {})

const modelState = {
  availableModels: [] as Array<{ id: string; name: string; is_default?: boolean }>,
  defaultModelName: null as string | null,
  loadedOrganizationId: null as string | null,
  isLoadingModels: false,
  modelLoadError: null as string | null,
  loadModels,
  switchModel,
  switchContextTier,
  setModelParamOverride,
}

vi.mock('@/stores/useChatModelStore', () => ({
  useChatModelStore: (sel: (s: typeof modelState) => unknown) => sel(modelState),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: { selectedAgent: null }) => unknown) => sel({ selectedAgent: null }),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { useSessionScopedComposerModel } from '../useSessionScopedComposerModel'

const SESSION = {
  id: 'session-1',
  title: '共享任务',
  status: 'active',
  organization_id: 'org-1',
  space_id: 'space-1',
  current_model_id: '00000000-0000-0000-0000-000000000001',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as ChatSession

describe('useSessionScopedComposerModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    modelState.availableModels = []
    modelState.defaultModelName = null
    modelState.loadedOrganizationId = null
    modelState.isLoadingModels = false
    modelState.modelLoadError = null
  })

  it('organization 未加载时触发 loadModels', () => {
    renderHook(() =>
      useSessionScopedComposerModel({
        sessionId: SESSION.id,
        session: SESSION,
        organizationId: 'org-1',
      }),
    )
    expect(loadModels).toHaveBeenCalledWith('org-1')
  })

  it('同 org 已加载则不重复 loadModels', () => {
    modelState.loadedOrganizationId = 'org-1'
    modelState.availableModels = [{
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Doubao',
      is_default: true,
    }]
    renderHook(() =>
      useSessionScopedComposerModel({
        sessionId: SESSION.id,
        session: SESSION,
        organizationId: 'org-1',
      }),
    )
    expect(loadModels).not.toHaveBeenCalled()
  })

  it('catalog 就绪后解析 currentModel，加载中不报 no_chat_model', () => {
    modelState.loadedOrganizationId = 'org-1'
    modelState.availableModels = [{
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Doubao',
      is_default: true,
    }]
    modelState.defaultModelName = 'Doubao'

    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => {
        modelState.isLoadingModels = loading
        return useSessionScopedComposerModel({
          sessionId: SESSION.id,
          session: SESSION,
          organizationId: 'org-1',
        })
      },
      { initialProps: { loading: true } },
    )

    expect(result.current.modelDisabledReason).toBeNull()
    expect(result.current.hasSendableChatModel).toBe(true)
    expect(result.current.currentModel?.id).toBe('00000000-0000-0000-0000-000000000001')

    rerender({ loading: false })
    expect(result.current.modelDisabledReason).toBeNull()
  })

  it('catalog 空且未加载中 → no_chat_model', () => {
    modelState.loadedOrganizationId = 'org-1'
    modelState.availableModels = []
    modelState.isLoadingModels = false

    const { result } = renderHook(() =>
      useSessionScopedComposerModel({
        sessionId: SESSION.id,
        session: SESSION,
        organizationId: 'org-1',
      }),
    )
    expect(result.current.hasSendableChatModel).toBe(false)
    expect(result.current.modelDisabledReason).toBe('no_chat_model')
  })

  it('onModelChange 走 switchModel', async () => {
    modelState.loadedOrganizationId = 'org-1'
    modelState.availableModels = [{
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Doubao',
    }]

    const { result } = renderHook(() =>
      useSessionScopedComposerModel({
        sessionId: SESSION.id,
        session: SESSION,
        organizationId: 'org-1',
      }),
    )

    await act(async () => {
      await result.current.onModelChange('00000000-0000-0000-0000-000000000002')
    })
    expect(switchModel).toHaveBeenCalledWith(
      'session-1',
      '00000000-0000-0000-0000-000000000002',
      undefined,
    )
  })
})
