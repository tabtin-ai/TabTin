/**
 * 目录 runtime_controls 的思考强度（reasoning_effort 等）。
 * 放在模型选择右栏；有 runtime_profile.thinking 时不渲染，避免与 ThinkingModeSelector 双写。
 * 样式与 ContextSelector / ThinkingModeSelector 横向芯片一致。
 */

import React from 'react'
import { cn } from '@utils/cn'
import type {
  Model,
  ModelParamOverrides,
  ModelParamValue,
  ModelRuntimeControl,
  ModelRuntimeControlOption,
} from '@tabtin/chat-client'
import {
  getCatalogThinkingCapability,
  isThinkingRelatedRuntimeControl,
} from '../composer/thinkingModeCapability'

function getControlParamPath(control: ModelRuntimeControl): string {
  return control.param_path?.trim() || control.key
}

function getActiveControlValue(
  control: ModelRuntimeControl,
  overrides: ModelParamOverrides | null | undefined,
): ModelParamValue {
  const paramPath = getControlParamPath(control)
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, paramPath)) {
    return overrides[paramPath]
  }
  return control.default_value ?? null
}

/** 应出现在右栏的思考强度旧控件（无 runtime_profile.thinking 时）。 */
export function resolveReasoningEffortControl(
  model: Model | null | undefined,
): ModelRuntimeControl | null {
  if (!model || getCatalogThinkingCapability(model) != null) return null
  const control = (model.runtime_controls ?? []).find((item) => (
    item
    && item.kind === 'select'
    && item.visibility !== 'hidden'
    && item.visibility !== 'advanced'
    && isThinkingRelatedRuntimeControl(item)
    && (item.options?.length ?? 0) > 0
  ))
  return control ?? null
}

export function shouldShowReasoningEffortSelector(
  model: Model | null | undefined,
): boolean {
  return resolveReasoningEffortControl(model) != null
}

export function ReasoningEffortSelector({
  model,
  currentModelParamOverrides,
  disabled,
  onReasoningEffortChange,
}: {
  model: Model
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onReasoningEffortChange: (change: { key: string; value: ModelParamValue }) => void
}) {
  const control = resolveReasoningEffortControl(model)
  if (!control) return null

  const options = (control.options ?? []) as ModelRuntimeControlOption[]
  const activeValue = getActiveControlValue(control, currentModelParamOverrides)
  const sectionLabel = control.label || '思考强度'

  return (
    <div data-testid="reasoning-effort-selector">
      <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
        {sectionLabel}
      </div>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={sectionLabel}
      >
        {options.map((option) => {
          const isActive = Object.is(activeValue, option.value)
          const optionKey = `${control.key}:${String(option.value)}`
          return (
            <button
              key={optionKey}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={disabled}
              title={option.description || undefined}
              data-testid={`reasoning-effort-option-${String(option.value ?? 'default')}`}
              data-reasoning-effort={String(option.value ?? 'default')}
              onClick={() => {
                onReasoningEffortChange({
                  key: getControlParamPath(control),
                  value: option.value,
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
              {option.label}
            </button>
          )
        })}
      </div>
      {control.description ? (
        <div className="mt-1.5 text-caption text-muted-foreground/60">
          {control.description}
        </div>
      ) : null}
    </div>
  )
}
