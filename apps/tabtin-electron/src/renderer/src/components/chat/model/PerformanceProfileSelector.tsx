/**
 * 响应策略选择：写入 Session performance_profile（P1 无执行映射）。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'
import {
  PERFORMANCE_PROFILE_VALUES,
  performanceProfileControlChange,
  resolveActivePerformanceProfile,
  type PerformanceProfileValue,
} from './performanceProfileCapability'

const PROFILE_LABELS: Record<
  PerformanceProfileValue,
  { key: string; defaultLabel: string }
> = {
  fast: { key: 'model.performanceProfile.fast', defaultLabel: '快速' },
  balanced: { key: 'model.performanceProfile.balanced', defaultLabel: '平衡' },
  quality: { key: 'model.performanceProfile.quality', defaultLabel: '质量优先' },
}

export function PerformanceProfileSelector({
  currentModelParamOverrides,
  disabled,
  onPerformanceProfileChange,
}: {
  currentModelParamOverrides?: ModelParamOverrides | null
  disabled?: boolean
  onPerformanceProfileChange: (change: { key: string; value: ModelParamValue }) => void
}) {
  const { t } = useTranslation('chat')
  const active = resolveActivePerformanceProfile(currentModelParamOverrides)

  return (
    <div data-testid="performance-profile-selector">
      <div className="mb-1.5 text-caption font-medium tracking-wide text-muted-foreground/70">
        {t('model.performanceProfile.section', { defaultValue: '响应策略' })}
      </div>
      <div
        className="flex flex-wrap gap-1.5"
        role="group"
        aria-label={t('model.performanceProfile.section', { defaultValue: '响应策略' })}
        title={t('model.performanceProfile.tooltip', {
          defaultValue: '影响整体响应偏好；与思考深度相互独立',
        })}
      >
        {PERFORMANCE_PROFILE_VALUES.map(profile => {
          const meta = PROFILE_LABELS[profile]
          const isActive = profile === active
          return (
            <button
              key={profile}
              type="button"
              disabled={disabled}
              data-performance-profile={profile}
              onClick={() => {
                onPerformanceProfileChange(performanceProfileControlChange(profile))
              }}
              className={cn(
                'inline-flex select-none items-center rounded-md px-2 py-1 text-caption transition-colors',
                isActive
                  ? 'border border-primary/30 bg-primary/15 text-primary'
                  : 'border border-transparent bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              {t(meta.key, { defaultValue: meta.defaultLabel })}
            </button>
          )
        })}
      </div>
    </div>
  )
}
