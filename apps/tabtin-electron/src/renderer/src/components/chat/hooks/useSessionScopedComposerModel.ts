/**
 * useSessionScopedComposerModel — ChatSplitPane / 会话访问 Composer
 * 共用的「单会话 Composer 模型接线」。
 *
 * ChatPanel 主路径靠 useChatPanelLifecycle 预热 catalog；独立 Composer 宿主
 * （IM 画布 SharedSession / 分屏）不保证 ChatPanel 已 active，必须自行
 * ensure loadModels，并把 models / loading / switch 完整传给 ChatInput。
 */

import { useCallback, useLayoutEffect, useMemo } from 'react'
import type {
  ChatSession,
  ContextTier,
  Model,
  ModelParamOverrides,
  ModelParamValue,
} from '@tabtin/chat-client'
import { useChatModelStore } from '@/stores/useChatModelStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import {
  filterSendableChatModels,
  findSendableChatModel,
  isSendableChatModelId,
  pickDefaultSendableChatModel,
} from '@/utils/chatModelGuards'
import { toRuntimeProfileV2ForTransport } from '@/stores/chat/runtimeProfileIntent'
import { createLogger } from '@/utils/logger'
import { isCommunityDistribution, noChatModelDisabledReason } from '@/config/distribution'

const log = createLogger('SessionScopedComposerModel')

export interface UseSessionScopedComposerModelInput {
  sessionId: string | null
  session: ChatSession | null
  organizationId: string | null | undefined
  /** false 时不触发 loadModels（如分屏非激活 pane 可省请求） */
  enabled?: boolean
}

export interface SessionScopedComposerModel {
  sendableModels: Model[]
  currentModel: Model | null
  currentContextTier: ContextTier | null
  currentModelParamOverrides: ModelParamOverrides
  isLoadingModels: boolean
  modelLoadError: string | null
  hasSendableChatModel: boolean
  /** 仅模型相关的 disabledReason；加载中为 null，避免闪「无模型」 */
  modelDisabledReason: string | null
  onModelChange: (
    modelId: string,
    tierId?: string,
    controlChange?: { key: string; value: ModelParamValue },
  ) => Promise<void>
  onRetryLoadModels: () => void
}

export function useSessionScopedComposerModel({
  sessionId,
  session,
  organizationId,
  enabled = true,
}: UseSessionScopedComposerModelInput): SessionScopedComposerModel {
  const availableModels = useChatModelStore((s) => s.availableModels)
  const defaultModelName = useChatModelStore((s) => s.defaultModelName)
  const loadedOrganizationId = useChatModelStore((s) => s.loadedOrganizationId)
  const isLoadingModels = useChatModelStore((s) => s.isLoadingModels)
  const modelLoadError = useChatModelStore((s) => s.modelLoadError)
  const loadModels = useChatModelStore((s) => s.loadModels)
  const switchModel = useChatModelStore((s) => s.switchModel)
  const switchContextTier = useChatModelStore((s) => s.switchContextTier)
  const setModelParamOverride = useChatModelStore((s) => s.setModelParamOverride)
  const agentPreferredModelId = useSpaceStore((s) => s.selectedAgent?.preferred_model_id)

  const orgId = typeof organizationId === 'string' && organizationId.trim()
    ? organizationId.trim()
    : null

  useLayoutEffect(() => {
    if (!enabled || !orgId) return
    // 与 useChatPanelLifecycle 一致：同 org 已加载或加载中则跳过；失败靠 onRetryLoadModels。
    if (loadedOrganizationId === orgId) return
    void loadModels(orgId).catch((error) => {
      log.error('加载模型列表失败', { organizationId: orgId, error })
    })
  }, [enabled, orgId, loadedOrganizationId, loadModels])

  const sendableModels = useMemo(
    () => filterSendableChatModels(availableModels),
    [availableModels],
  )
  const hasSendableChatModel = sendableModels.length > 0

  const currentModel = useMemo(() => {
    const fallbackModel = () => pickDefaultSendableChatModel(availableModels, {
      preferredModelId: agentPreferredModelId,
      defaultModelName,
    })
    const currentModelId = session?.current_model_id
      || (session as ChatSession & { current_model?: string } | null)?.current_model
    if (!session || !currentModelId) return fallbackModel()
    return findSendableChatModel(availableModels, currentModelId) ?? fallbackModel()
  }, [availableModels, session, defaultModelName, agentPreferredModelId])

  const currentContextTier = useMemo((): ContextTier | null => {
    const tiers = currentModel?.context_tiers ?? []
    if (!tiers.length) return null
    const explicitId = (session?.context_tier_id || '').trim()
    if (explicitId) {
      const found = tiers.find((tier) => tier.id === explicitId)
      if (found) return found
    }
    return tiers.find((tier) => tier.is_default) ?? tiers[0] ?? null
  }, [currentModel, session?.context_tier_id])

  const modelDisabledReason = useMemo(() => {
    if (isLoadingModels) return null
    if (!hasSendableChatModel) {
      return isCommunityDistribution ? noChatModelDisabledReason : 'no_chat_model'
    }
    return null
  }, [isLoadingModels, hasSendableChatModel])

  const currentModelParamOverrides = useMemo(
    () => toRuntimeProfileV2ForTransport(session?.model_param_overrides),
    [session?.model_param_overrides],
  )

  const onModelChange = useCallback(async (
    modelId: string,
    tierId?: string,
    controlChange?: { key: string; value: ModelParamValue },
  ) => {
    if (!sessionId || !isSendableChatModelId(modelId)) return
    if (controlChange && currentModel?.id === modelId) {
      await setModelParamOverride(sessionId, controlChange.key, controlChange.value)
      return
    }
    if (tierId !== undefined && currentModel?.id === modelId) {
      await switchContextTier(sessionId, tierId)
      return
    }
    await switchModel(sessionId, modelId, tierId)
  }, [
    sessionId,
    currentModel?.id,
    switchModel,
    switchContextTier,
    setModelParamOverride,
  ])

  const onRetryLoadModels = useCallback(() => {
    if (!orgId) return
    void loadModels(orgId).catch((error) => {
      log.error('重试加载模型列表失败', { organizationId: orgId, error })
    })
  }, [orgId, loadModels])

  return {
    sendableModels,
    currentModel,
    currentContextTier,
    currentModelParamOverrides,
    isLoadingModels,
    modelLoadError,
    hasSendableChatModel,
    modelDisabledReason,
    onModelChange,
    onRetryLoadModels,
  }
}
