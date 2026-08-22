import React from 'react'
import { useTranslation } from 'react-i18next'
import type { RollbackApplyLayerStatus } from '@tabtin/chat-client'
import { cn } from '@utils/cn'
import type { RevertBannerLayerChip } from './deriveRevertBannerViewModel'
import { StatusChip } from './RevertBannerStatusChip'

function resolveHeadlineToneClass(currentStatus: RollbackApplyLayerStatus): string {
  if (currentStatus === 'failed') return 'text-destructive/80'
  if (currentStatus === 'partial_success') return 'text-warning/80'
  return 'text-foreground'
}

export const RevertBannerComplexBody: React.FC<{
  currentStatus: RollbackApplyLayerStatus
  headline: string
  guidance: string
  layerChips: RevertBannerLayerChip[]
  rollbackReason?: string
  hasRetryableRestores: boolean
  retryableCount: number
  retryPreview: string
  collabWarningCount: number
}> = ({
  currentStatus,
  headline,
  guidance,
  layerChips,
  rollbackReason,
  hasRetryableRestores,
  retryableCount,
  retryPreview,
  collabWarningCount,
}) => {
  const { t } = useTranslation('chat')
  return (
    <div className="min-w-0 flex-1">
      <p className={`text-body font-medium ${resolveHeadlineToneClass(currentStatus)}`}>{headline}</p>
      {rollbackReason && (
        <p className="mt-1 text-caption text-muted-foreground/80">
          {t('checkpoint.rollbackReasonLabel', { defaultValue: '回退原因' })}: {rollbackReason}
        </p>
      )}
      <p className="mt-1 text-body text-muted-foreground">{guidance}</p>
      {layerChips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {layerChips.map(chip => (
            <StatusChip
              key={chip.key}
              label={chip.label}
              detail={chip.detail}
              status={chip.status}
            />
          ))}
        </div>
      )}
      {hasRetryableRestores && (
        <p className="mt-2 text-caption text-muted-foreground/80">
          {t('checkpoint.retryTargets', { count: retryableCount, defaultValue: '待重试资源 {{count}} 个' })}
          {retryPreview ? `: ${retryPreview}${retryableCount > 2 ? '...' : ''}` : ''}
        </p>
      )}
      {collabWarningCount > 0 && (
        <p className="mt-1 text-caption text-warning/80">
          {t('checkpoint.collabWarningPersistent', { count: collabWarningCount, defaultValue: '另有 {{count}} 项协作同步警告，建议通知在线协作者刷新。' })}
        </p>
      )}
    </div>
  )
}
