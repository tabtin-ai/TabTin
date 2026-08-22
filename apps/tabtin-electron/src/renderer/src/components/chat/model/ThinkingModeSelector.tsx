/**
 * 思考开关 / 深度选择：复用 thinkingModeCapability（与 ThinkingModeChip 同源）。
 * 只写 thinking_mode，不写 reasoning_effort。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type {
  Model,
  ModelParamOverrides,
  ModelParamValue,
  RuntimeProfileThinkingMode,
} from '@tabtin/chat-client'
import {
  getCatalogThinkingCapability,
  resolveActiveThinkingMode,
  thinkingModeControlChange,
} from '../composer/thinkingModeCapability'

const THINKING_LABELS: Record<
  RuntimeProfileThinkingMode,
  { key: string; defaultLabel: string; binaryDefaultLabel?: string }
> = {
  off: { key: 'model.thinkingMode.off', defaultLabel: '关闭' },
  standard: {
    key: 'model.thinkingMode.standard',
    defaultLabel: '标准',
    binaryDefaultLabel: '开启',
  },
  deep: { key: 'model.thinkingMode.deep', defaultLabel: '深度' },
}

export function ThinkingModeSelector({
  model,
  currentModelParamOverrides,
  disabled,
  onThinkingModeChange,
}: {
  model: Model
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onThinkingModeChange: (change: { key: string; value: ModelParamValue }) => void
}) {
  const { t } = useTranslation('chat')
  const thinking = getCatalogThinkingCapability(model)
  if (!thinking) return null

  if (thinking.alwaysOn) {
    return (
      <div data-testid="thinking-mode-selector">
        <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
          {t('model.thinkingMode.sectionBinary', { defaultValue: '思考' })}
        </div>
        <div
          data-testid="thinking-always-on"
          className="rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-caption text-muted-foreground"
        >
          {t('model.thinkingMode.alwaysOn', { defaultValue: '思考始终开启' })}
        </div>
      </div>
    )
  }

  const activeMode = resolveActiveThinkingMode(
    currentModelParamOverrides,
    thinking.defaultMode,
    thinking.modes,
  )

  const sectionLabel = thinking.binaryToggle
    ? t('model.thinkingMode.sectionBinary', { defaultValue: '思考' })
    : t('model.thinkingMode.section', { defaultValue: '思考深度' })

  return (
    <div data-testid="thinking-mode-selector">
      <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
        {sectionLabel}
      </div>
      <div
        data-testid="model-settings-thinking"
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={sectionLabel}
      >
        {thinking.modes.map(mode => {
          const meta = THINKING_LABELS[mode]
          const isActive = mode === activeMode
          const defaultLabel = (
            thinking.binaryToggle && meta.binaryDefaultLabel
          )
            ? meta.binaryDefaultLabel
            : meta.defaultLabel
          const labelKey = (
            thinking.binaryToggle && mode === 'standard'
          )
            ? 'model.thinkingMode.on'
            : meta.key
          return (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              data-thinking-mode={mode}
              onClick={() => {
                const change = thinkingModeControlChange(mode)
                onThinkingModeChange(change)
              }}
              className={cn(
                'inline-flex select-none items-center rounded-md px-2 py-1 text-caption transition-colors',
                isActive
                  ? 'border border-primary/30 bg-primary/15 text-primary'
                  : 'border border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {t(labelKey, { defaultValue: defaultLabel })}
            </button>
          )
        })}
      </div>
    </div>
  )
}
