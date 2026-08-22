/**
 * 模型运行设置右栏：上下文 / 速度 / 思考强度 / 思考深度 / 响应策略。
 */

import React from 'react'
import type {
  ContextTier,
  Model,
  ModelParamOverrides,
  ModelParamValue,
} from '@tabtin/chat-client'
import { ContextSelector, shouldShowContextSelector } from './ContextSelector'
import { ModelFastToggle, shouldShowModelFastToggle } from './ModelFastToggle'
import {
  ReasoningEffortSelector,
  shouldShowReasoningEffortSelector,
} from './ReasoningEffortSelector'
import { ThinkingModeSelector } from './ThinkingModeSelector'
import { PerformanceProfileSelector } from './PerformanceProfileSelector'
import { isPerformanceCapabilitySupported } from './performanceProfileCapability'
import { getCatalogThinkingCapability } from '../composer/thinkingModeCapability'

export function ModelRuntimeOptionsPanel({
  model,
  currentTier,
  currentModelParamOverrides,
  disabled,
  onSelectTier,
  onFastChange,
  onReasoningEffortChange,
  onThinkingModeChange,
  onPerformanceProfileChange,
}: {
  model: Model
  currentTier?: ContextTier | null
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onSelectTier: (tierId: string) => void
  onFastChange: (change: { key: string; value: ModelParamValue }) => void
  onReasoningEffortChange: (change: { key: string; value: ModelParamValue }) => void
  onThinkingModeChange: (change: { key: string; value: ModelParamValue }) => void
  onPerformanceProfileChange: (change: { key: string; value: ModelParamValue }) => void
}) {
  const showContext = shouldShowContextSelector(model)
  const showFast = shouldShowModelFastToggle(model)
  const showReasoningEffort = shouldShowReasoningEffortSelector(model)
  const showThinking = getCatalogThinkingCapability(model) != null
  const showPerformance = isPerformanceCapabilitySupported(model)

  return (
    <div
      data-testid="model-runtime-options-panel"
      className="flex h-full min-h-0 flex-col px-3 py-2.5"
    >
      <div className="mb-3 truncate text-body font-medium text-foreground">
        {model.display_name}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {showContext ? (
          <ContextSelector
            model={model}
            currentTier={currentTier}
            disabled={disabled}
            onSelectTier={onSelectTier}
          />
        ) : null}

        {showReasoningEffort ? (
          <ReasoningEffortSelector
            model={model}
            currentModelParamOverrides={currentModelParamOverrides}
            disabled={disabled}
            onReasoningEffortChange={onReasoningEffortChange}
          />
        ) : null}

        {showFast ? (
          <ModelFastToggle
            model={model}
            currentModelParamOverrides={currentModelParamOverrides}
            disabled={disabled}
            onFastChange={onFastChange}
          />
        ) : null}

        {showThinking ? (
          <ThinkingModeSelector
            model={model}
            currentModelParamOverrides={currentModelParamOverrides}
            disabled={disabled}
            onThinkingModeChange={onThinkingModeChange}
          />
        ) : null}

        {showPerformance ? (
          <PerformanceProfileSelector
            currentModelParamOverrides={currentModelParamOverrides}
            disabled={disabled}
            onPerformanceProfileChange={onPerformanceProfileChange}
          />
        ) : null}
      </div>
    </div>
  )
}
