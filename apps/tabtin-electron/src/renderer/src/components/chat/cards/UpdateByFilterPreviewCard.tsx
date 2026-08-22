/**
 * UpdateByFilterPreviewCard — A3 update-by-filter 预检 + 结果展示
 *
 * L35: 预检 Modal（匹配行数 + sample 表 + 风险等级 + 确认）
 * L36: drift toast（橙色 banner，显示漂移比例）
 * L37: batch errors 展示（可折叠错误列表）
 *
 * Self-registers as 'UpdateByFilterPreviewCard'.
 */

import React, { useState, useMemo, useCallback } from 'react'
import {
  AlertTriangle, AlertCircle, CheckCircle2,
  ChevronDown, ChevronRight, Info, Shield, Loader2, X, Ban,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import type { CardRendererProps } from '../registry/types'
import type { UpdateByFilterPreviewData } from '@tabtin/chat-client'
import { ErrorBanner, LoadingPlaceholder } from './primitives'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  CARD_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  ICON_SIZE,
  ANIMATION,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'

const HARD_LIMIT = 10_000

/* ── Risk level helpers ── */

type RiskLevel = 'low' | 'medium' | 'high' | 'rejected'

function getRiskLevel(matchedTotal: number): RiskLevel {
  if (matchedTotal > HARD_LIMIT) return 'rejected'
  if (matchedTotal >= 1000) return 'high'
  if (matchedTotal >= 200) return 'medium'
  return 'low'
}

const RISK_CONFIG = {
  low: {
    icon: Info,
    labelKey: 'bulk.updateByFilter.riskLow',
    descKey: 'bulk.updateByFilter.riskLowDesc',
    borderClass: BORDER.default,
    bgClass: BG.card,
    iconColor: TEXT_COLOR.accent,
    textColor: TEXT_COLOR.secondary,
  },
  medium: {
    icon: AlertTriangle,
    labelKey: 'bulk.updateByFilter.riskMedium',
    descKey: 'bulk.updateByFilter.riskMediumDesc',
    borderClass: BORDER.warning,
    bgClass: BG.warning,
    iconColor: TEXT_COLOR.errorSoft,
    textColor: TEXT_COLOR.primary,
  },
  high: {
    icon: AlertCircle,
    labelKey: 'bulk.updateByFilter.riskHigh',
    descKey: 'bulk.updateByFilter.riskHighDesc',
    borderClass: BORDER.error,
    bgClass: BG.error,
    iconColor: TEXT_COLOR.error,
    textColor: TEXT_COLOR.primary,
  },
  rejected: {
    icon: Ban,
    labelKey: 'bulk.updateByFilter.rejected',
    descKey: 'bulk.updateByFilter.rejectedDesc',
    borderClass: BORDER.error,
    bgClass: BG.error,
    iconColor: TEXT_COLOR.error,
    textColor: TEXT_COLOR.error,
  },
} as const

/* ── Duration formatting ── */

function formatEstimatedDuration(
  ms: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds >= 30) {
    return t('bulk.updateByFilter.estimatedDurationLong', { seconds })
  }
  return t('bulk.updateByFilter.estimatedDuration', { seconds })
}

/* ── Sample table ── */

const SampleRecordsTable: React.FC<{
  records: Array<Record<string, unknown>>
}> = React.memo(({ records }) => {
  const columns = useMemo(() => {
    const colSet = new Set<string>()
    for (const r of records) {
      for (const k of Object.keys(r)) colSet.add(k)
    }
    return Array.from(colSet).slice(0, 8)
  }, [records])

  if (!records.length) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-caption">
        <thead>
          <tr className={cn('border-b', BORDER.subtle)}>
            {columns.map((col) => (
              <th
                key={col}
                className={cn(
                  'px-2 py-1 text-left font-medium truncate max-w-[120px]',
                  TEXT_COLOR.muted,
                )}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.slice(0, 20).map((record, idx) => (
            <tr
              key={idx}
              className={cn(
                'border-b last:border-b-0',
                BORDER.subtle,
                idx % 2 === 0 ? '' : BG.card,
              )}
            >
              {columns.map((col) => (
                <td
                  key={col}
                  className={cn('px-2 py-1 truncate max-w-[120px]', TEXT_COLOR.secondary)}
                >
                  {formatCellValue(record[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
})

SampleRecordsTable.displayName = 'SampleRecordsTable'

function formatCellValue(val: unknown): string {
  if (val == null) return '—'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

/* ── Drift Warning Banner (L36) ── */

export const DriftWarningBanner: React.FC<{
  driftRatio: number
  expected: number
  actual: number
  onDismiss?: () => void
}> = React.memo(({ driftRatio, expected, actual, onDismiss }) => {
  const { t } = useTranslation('tabdata')
  const ratioPercent = Math.round(driftRatio * 100)

  return (
    <div
      className={cn(
        CARD_RADIUS,
        'border overflow-hidden',
        BORDER.warning,
        BG.warning,
        'flex items-start gap-2',
        CARD_PADDING.x,
        CARD_PADDING.y,
      )}
      role="alert"
    >
      <AlertTriangle className={cn(ICON_SIZE.status, TEXT_COLOR.errorSoft, 'flex-shrink-0 mt-0.5')} />
      <div className="flex-1 min-w-0">
        <p className={cn(TEXT.body, TEXT_COLOR.primary)}>
          {t('bulk.updateByFilter.driftWarning', {
            ratio: ratioPercent,
            expected,
            actual,
          })}
        </p>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            'flex-shrink-0 p-0.5 rounded',
            ANIMATION.fadeIn,
          )}
          aria-label={t('bulk.updateByFilter.driftDismiss')}
        >
          <X className={cn(ICON_SIZE.md, TEXT_COLOR.errorSoft)} />
        </button>
      )}
    </div>
  )
})

DriftWarningBanner.displayName = 'DriftWarningBanner'

/* ── Error List (L37) ── */

export const BatchErrorList: React.FC<{
  errors: Array<{ record_id: string; reason: string }>
  failedRecordIds?: string[]
}> = React.memo(({ errors, failedRecordIds }) => {
  const { t } = useTranslation('tabdata')
  const [expanded, setExpanded] = useState(false)
  const COLLAPSED_LIMIT = 5

  const allErrors = useMemo(() => {
    const errMap = new Map<string, string>()
    for (const e of errors) errMap.set(e.record_id, e.reason)
    if (failedRecordIds) {
      for (const rid of failedRecordIds) {
        if (!errMap.has(rid)) errMap.set(rid, '—')
      }
    }
    return Array.from(errMap.entries()).map(([record_id, reason]) => ({
      record_id,
      reason,
    }))
  }, [errors, failedRecordIds])

  if (allErrors.length === 0) return null

  const visibleErrors = expanded ? allErrors : allErrors.slice(0, COLLAPSED_LIMIT)
  const hiddenCount = allErrors.length - COLLAPSED_LIMIT

  return (
    <div className={cn(CARD_RADIUS, 'border overflow-hidden', BORDER.error, BG.error)}>
      <div
        className={cn(
          'flex items-center gap-1.5',
          CARD_HEADER_PADDING.x,
          CARD_HEADER_PADDING.y,
          'border-b',
          BORDER.subtle,
        )}
      >
        <AlertCircle className={cn(ICON_SIZE.md, TEXT_COLOR.error)} />
        <span className={cn(TEXT.header, TEXT_COLOR.error)}>
          {t('bulk.updateByFilter.errorListTitle', { count: allErrors.length })}
        </span>
      </div>
      <div className={cn(CARD_PADDING.x, 'py-1')}>
        {visibleErrors.map((err) => (
          <div
            key={err.record_id}
            className={cn(
              'py-1 border-b last:border-b-0',
              BORDER.subtle,
              TEXT.meta,
              TEXT_COLOR.secondary,
            )}
          >
            <span className="font-mono text-caption">{err.record_id.slice(0, 8)}…</span>
            <span className="mx-1">—</span>
            <span>{err.reason}</span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'w-full flex items-center justify-center gap-1 py-1.5',
            TEXT.meta,
            TEXT_COLOR.accent,
            ANIMATION.fadeIn,
          )}
        >
          {expanded ? (
            <>
              <ChevronDown className={ICON_SIZE.sm} />
              {t('bulk.updateByFilter.showLess')}
            </>
          ) : (
            <>
              <ChevronRight className={ICON_SIZE.sm} />
              {t('bulk.updateByFilter.showMore', { count: hiddenCount })}
            </>
          )}
        </button>
      )}
    </div>
  )
})

BatchErrorList.displayName = 'BatchErrorList'

/* ── Main preview card (L35) ── */

interface PreviewCardInnerProps {
  data: UpdateByFilterPreviewData
  onConfirm?: (token: string) => void
  onCancel?: () => void
}

const PreviewCardInner: React.FC<PreviewCardInnerProps> = React.memo(({ data, onConfirm, onCancel }) => {
  const { t } = useTranslation('tabdata')
  const [confirmInput, setConfirmInput] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [driftDismissed, setDriftDismissed] = useState(false)

  const risk = getRiskLevel(data.matched_total)
  const config = RISK_CONFIG[risk]
  const Icon = config.icon

  const showDrift =
    data.phase === 'committed' &&
    data.drift_warning &&
    data.drift_ratio != null &&
    !driftDismissed

  const hasErrors =
    data.phase === 'committed' &&
    ((data.errors && data.errors.length > 0) ||
      (data.failed_record_ids && data.failed_record_ids.length > 0))

  const expectedConfirmText = t('bulk.updateByFilter.highRiskConfirmText')
  const canConfirm =
    risk !== 'rejected' &&
    (risk !== 'high' || confirmInput.trim() === expectedConfirmText)

  const handleConfirm = useCallback(async () => {
    if (!data.confirm_token || !canConfirm || isCommitting) return
    setIsCommitting(true)
    try {
      onConfirm?.(data.confirm_token)
    } catch {
      setIsCommitting(false)
    }
  }, [data.confirm_token, canConfirm, isCommitting, onConfirm])

  /* ── Rejected (> 10000) ── */
  if (risk === 'rejected') {
    return (
      <div className={cn(CARD_RADIUS, 'border overflow-hidden', BORDER.error, BG.error)}>
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            BG.error,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Ban className={cn(ICON_SIZE.md, TEXT_COLOR.error)} />
          <span className={cn(TEXT.header, TEXT_COLOR.error)}>
            {t('bulk.updateByFilter.previewTitle')}
          </span>
        </div>
        <div className={cn(CARD_PADDING.x, CARD_PADDING.y)}>
          <p className={cn(TEXT.body, TEXT_COLOR.error, 'font-medium')}>
            {t('bulk.updateByFilter.rejected')}
          </p>
          <p className={cn(TEXT.meta, TEXT_COLOR.secondary, 'mt-1')}>
            {t('bulk.updateByFilter.rejectedDesc', { count: data.matched_total })}
          </p>
        </div>
      </div>
    )
  }

  /* ── Error phase ── */
  if (data.phase === 'error') {
    return (
      <ErrorBanner
        error={t('bulk.updateByFilter.commitFailed')}
      />
    )
  }

  return (
    <div className="space-y-2">
      {/* Preflight preview section */}
      <div
        className={cn(
          CARD_RADIUS,
          'border overflow-hidden',
          config.borderClass,
          risk === 'high' ? '' : BG.card,
        )}
      >
        {/* Header */}
        <div
          className={cn(
            'flex items-center gap-1.5',
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            config.bgClass,
            'border-b',
            BORDER.subtle,
          )}
        >
          <Icon className={cn(ICON_SIZE.md, config.iconColor)} />
          <span className={cn(TEXT.header, config.textColor)}>
            {t('bulk.updateByFilter.previewTitle')}
          </span>
          <span className={cn(TEXT.meta, TEXT_COLOR.muted, 'ml-auto')}>
            {t('bulk.updateByFilter.matchedRows', { count: data.matched_total })}
          </span>
        </div>

        {/* Risk description */}
        <div className={cn(CARD_PADDING.x, CARD_PADDING.y)}>
          <div className="flex items-start gap-2 mb-2">
            <Shield className={cn(ICON_SIZE.status, config.iconColor, 'flex-shrink-0 mt-0.5')} />
            <div>
              <p className={cn(TEXT.body, 'font-medium', config.textColor)}>
                {t(config.labelKey)}
              </p>
              <p className={cn(TEXT.meta, TEXT_COLOR.secondary)}>
                {t(config.descKey, { count: data.matched_total })}
              </p>
            </div>
          </div>

          {/* Estimated duration + checkpoint hint */}
          {(data.estimated_duration_ms != null || data.requires_checkpoint) && (
            <div className={cn('flex flex-wrap gap-3 mt-2', TEXT.meta, TEXT_COLOR.muted)}>
              {data.estimated_duration_ms != null && (
                <span>{formatEstimatedDuration(data.estimated_duration_ms, t)}</span>
              )}
              {data.requires_checkpoint && (
                <span className="flex items-center gap-1">
                  <Shield className={ICON_SIZE.sm} />
                  {t('bulk.updateByFilter.checkpointHint')}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Sample records table */}
        {data.sample_records && data.sample_records.length > 0 && (
          <div className={cn('border-t', BORDER.subtle)}>
            <div
              className={cn(
                CARD_HEADER_PADDING.x,
                'py-1',
                TEXT.meta,
                TEXT_COLOR.muted,
              )}
            >
              {t('bulk.updateByFilter.samplePreview')}
            </div>
            <SampleRecordsTable records={data.sample_records} />
          </div>
        )}

        {/* High-risk confirmation input */}
        {risk === 'high' && data.phase === 'preflight' && (
          <div className={cn('border-t', BORDER.subtle, CARD_PADDING.x, CARD_PADDING.y)}>
            <input
              type="text"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={t('bulk.updateByFilter.highRiskInputPlaceholder')}
              className={cn(
                'w-full px-2 py-1 rounded border',
                TEXT.body,
                BORDER.error,
                'bg-transparent',
                'focus:outline-none focus:ring-1 focus:ring-destructive/30',
              )}
            />
          </div>
        )}

        {/* Action buttons (preflight phase only) */}
        {data.phase === 'preflight' && (
          <div
            className={cn(
              'flex items-center justify-end gap-2 border-t',
              BORDER.subtle,
              CARD_PADDING.x,
              CARD_PADDING.y,
            )}
          >
            {isCommitting && (
              <span className={cn(TEXT.meta, TEXT_COLOR.muted, 'mr-auto flex items-center gap-1')}>
                <Loader2 className={cn(ICON_SIZE.sm, ANIMATION.spin)} />
                {t('bulk.updateByFilter.committing')}
              </span>
            )}
            <button
              type="button"
              onClick={onCancel}
              className={cn(
                'px-3 py-1 rounded',
                TEXT.body,
                TEXT_COLOR.secondary,
                'hover:bg-muted/20',
                ANIMATION.fadeIn,
              )}
            >
              {t('bulk.updateByFilter.cancel')}
            </button>
            <button
              type="button"
              disabled={!canConfirm || isCommitting}
              onClick={handleConfirm}
              className={cn(
                'px-3 py-1 rounded font-medium',
                TEXT.body,
                canConfirm && !isCommitting
                  ? 'bg-accent text-accent-foreground hover:bg-accent/90'
                  : 'bg-muted/30 text-muted-foreground cursor-not-allowed',
                ANIMATION.fadeIn,
              )}
            >
              {isCommitting && <Loader2 className={cn(ICON_SIZE.sm, ANIMATION.spin, 'inline mr-1')} />}
              {t('bulk.updateByFilter.confirm')}
            </button>
          </div>
        )}

        {/* Committed success */}
        {data.phase === 'committed' && data.updated_count != null && (
          <div
            className={cn(
              'flex items-center gap-1.5 border-t',
              BORDER.subtle,
              BG.success,
              CARD_PADDING.x,
              CARD_PADDING.y,
            )}
          >
            <CheckCircle2 className={cn(ICON_SIZE.md, TEXT_COLOR.success)} />
            <span className={cn(TEXT.body, TEXT_COLOR.success)}>
              {t('bulk.updateByFilter.commitSuccess', { count: data.updated_count })}
            </span>
          </div>
        )}
      </div>

      {/* L36: Drift warning banner */}
      {showDrift && (
        <DriftWarningBanner
          driftRatio={data.drift_ratio!}
          expected={data.matched_total}
          actual={data.updated_count ?? 0}
          onDismiss={() => setDriftDismissed(true)}
        />
      )}

      {/* L37: Batch error list */}
      {hasErrors && (
        <BatchErrorList
          errors={data.errors ?? []}
          failedRecordIds={data.failed_record_ids}
        />
      )}
    </div>
  )
})

PreviewCardInner.displayName = 'PreviewCardInner'

/* ── Renderer adapter ── */

const UpdateByFilterPreviewCardRenderer: React.FC<CardRendererProps> = ({
  data,
  input,
  output,
  error,
  phase,
}) => {
  if (error) return <ErrorBanner error={error} />
  if ((phase === 'start' || phase === 'running') && !data && !output && !input) return <LoadingPlaceholder />

  const previewData = data as UpdateByFilterPreviewData | undefined
  if (previewData?.kind === 'update_by_filter_preview') {
    return <PreviewCardInner data={previewData} />
  }

  const raw = (output ?? input) as Record<string, unknown> | undefined
  if (!raw) return <LoadingPlaceholder />

  const synthesized = extractUpdateByFilterData(raw)
  if (synthesized) return <PreviewCardInner data={synthesized} />

  return <LoadingPlaceholder />
}

UpdateByFilterPreviewCardRenderer.displayName = 'UpdateByFilterPreviewCardRenderer'

/* ── Extract structured data from raw tool output ── */

export function extractUpdateByFilterOutput(
  output: unknown,
): UpdateByFilterPreviewData | null {
  if (!output || typeof output !== 'object') return null
  return extractUpdateByFilterData(output as Record<string, unknown>)
}

function extractUpdateByFilterData(
  obj: Record<string, unknown>,
): UpdateByFilterPreviewData | null {
  const d = (obj.data ?? obj) as Record<string, unknown>

  if ('confirm_token' in d && 'matched_total' in d) {
    return {
      kind: 'update_by_filter_preview',
      phase: 'preflight',
      matched_total: Number(d.matched_total),
      sample_records: Array.isArray(d.sample_records) ? d.sample_records : undefined,
      confirm_token: String(d.confirm_token),
      estimated_duration_ms: d.estimated_duration_ms != null
        ? Number(d.estimated_duration_ms) : undefined,
      requires_checkpoint: Boolean(d.requires_checkpoint),
    }
  }

  if ('updated_count' in d) {
    return {
      kind: 'update_by_filter_preview',
      phase: 'committed',
      matched_total: Number(d.matched_total ?? 0),
      updated_count: Number(d.updated_count),
      operation_group_id: d.operation_group_id as string | undefined,
      drift_warning: Boolean(d.drift_warning),
      drift_ratio: d.drift_ratio != null ? Number(d.drift_ratio) : undefined,
      drift_message_i18n_key: d.drift_message_i18n_key as string | undefined,
      errors: Array.isArray(d.errors) ? d.errors : undefined,
      failed_record_ids: Array.isArray(d.failed_record_ids) ? d.failed_record_ids : undefined,
      duration_ms: d.duration_ms != null ? Number(d.duration_ms) : undefined,
    }
  }

  return null
}

/* ── Register ── */

registerCardRenderer('UpdateByFilterPreviewCard', UpdateByFilterPreviewCardRenderer)

export {
  PreviewCardInner as UpdateByFilterPreviewCard,
  UpdateByFilterPreviewCardRenderer,
}
export default UpdateByFilterPreviewCardRenderer
