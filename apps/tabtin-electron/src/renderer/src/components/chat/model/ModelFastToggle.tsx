/**
 * 模型速度（标准 / 快速）：右栏横向芯片，与上下文 / 思考强度样式一致。
 * Codex 写 service_tier=fast；目录声明 speed/service_tier 的模型同理。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { Model, ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'
import {
  isFastEnabledForModel,
  resolveModelFastToggle,
} from '@/utils/modelFastToggle'

export function shouldShowModelFastToggle(model: Model | null | undefined): boolean {
  return resolveModelFastToggle(model) != null
}

const SPEED_OPTIONS = [
  {
    id: 'standard' as const,
    labelKey: 'model.speed.standard',
    defaultLabel: '标准',
    hintKey: 'model.speed.standardHint',
    defaultHint: '默认速度',
  },
  {
    id: 'fast' as const,
    labelKey: 'model.speed.fast',
    defaultLabel: '快速',
    hintKey: 'model.speed.fastHint',
    defaultHint: '1.5 倍速度，用量更多',
  },
]

export function ModelFastToggle({
  model,
  currentModelParamOverrides,
  disabled,
  onFastChange,
}: {
  model: Model
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onFastChange: (change: { key: string; value: ModelParamValue }) => void
}) {
  const { t } = useTranslation('chat')
  const toggle = resolveModelFastToggle(model)
  if (!toggle) return null

  const fastActive = isFastEnabledForModel(
    currentModelParamOverrides,
    model.id,
    model.id,
    toggle,
  )
  const sectionLabel = t('model.speed.section', { defaultValue: '速度' })

  return (
    <div data-testid="model-fast-selector">
      <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
        {sectionLabel}
      </div>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={sectionLabel}
      >
        {SPEED_OPTIONS.map((option) => {
          const isActive = option.id === 'fast' ? fastActive : !fastActive
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={disabled}
              title={t(option.hintKey, { defaultValue: option.defaultHint })}
              data-testid={`model-fast-option-${option.id}`}
              data-speed-option={option.id}
              onClick={() => {
                onFastChange({
                  key: toggle.key,
                  value: option.id === 'fast' ? toggle.onValue : null,
                })
              }}
              className={cn(
                'inline-flex select-none items-center rounded-md px-2 py-1 text-caption transition-colors',
                isActive
                  ? 'border border-primary/30 bg-primary/15 text-primary'
                  : 'border border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {t(option.labelKey, { defaultValue: option.defaultLabel })}
            </button>
          )
        })}
      </div>
    </div>
  )
}
