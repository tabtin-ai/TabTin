import React from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Lightbulb,
  Loader2,
} from 'lucide-react'
import type { RollbackPreviewResult } from '../../../../services/chatExtraApi'
import { shouldShowDecisionSummary } from './rewindPreviewFullPanelLogic'

interface RewindDecisionSummaryProps {
  checkpointRecord: NonNullable<RollbackPreviewResult['effective_checkpoint']>
  t: (key: string, opts?: Record<string, unknown>) => string
}

const DecisionSummaryStatusBadge: React.FC<{
  status: 'pending' | 'failed' | undefined
  t: RewindDecisionSummaryProps['t']
}> = ({ status, t }) => {
  if (status === 'pending') {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground/60 italic">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" />
        {t('rewind.decisionSummaryPending', { defaultValue: '决策摘要生成中…' })}
      </span>
    )
  }
  if (status !== 'failed') return null
  return (
    <span
      className="ml-auto inline-flex items-center gap-1 text-muted-foreground/60"
      title={t('rewind.decisionSummaryFailed', { defaultValue: '摘要增强失败，仅展示基础信息' })}
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
      <span className="text-caption">{t('rewind.decisionSummaryFailed', { defaultValue: '摘要增强失败，仅展示基础信息' })}</span>
    </span>
  )
}

export const RewindDecisionSummary: React.FC<RewindDecisionSummaryProps> = ({ checkpointRecord, t }) => {
  if (!shouldShowDecisionSummary(checkpointRecord)) return null

  const ctx = checkpointRecord.context_summary
  const ds = ctx?.decision_summary
  const userPrompt = ctx?.user_prompt?.trim() || ''
  const intent = ds?.intent?.trim() || userPrompt
  const outcome = ds?.outcome?.trim() || ''
  const status = ds?.status

  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground/80">
        <Lightbulb className="h-3 w-3 shrink-0 text-accent/80" aria-hidden />
        {t('rewind.decisionContextTitle', { defaultValue: '当时在做什么' })}
        <DecisionSummaryStatusBadge
          status={status === 'pending' || status === 'failed' ? status : undefined}
          t={t}
        />
      </div>

      {intent && (
        <div className="flex items-start gap-1.5">
          <span className="text-caption font-medium text-muted-foreground/60 shrink-0">
            {t('rewind.decisionIntentLabel', { defaultValue: '意图' })}:
          </span>
          <p className="text-caption text-foreground/90 break-words line-clamp-2 min-w-0">
            {intent}
          </p>
        </div>
      )}

      {outcome && (
        <div className="flex items-start gap-1.5">
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success/80" aria-hidden />
          <span className="text-caption font-medium text-muted-foreground/60 shrink-0">
            {t('rewind.decisionOutcomeLabel', { defaultValue: '结果' })}:
          </span>
          <p className="text-caption text-foreground/80 break-words line-clamp-2 min-w-0">
            {outcome}
          </p>
        </div>
      )}
    </div>
  )
}

export const RewindNoImpactNotice: React.FC<{ t: RewindDecisionSummaryProps['t'] }> = ({ t }) => (
  <div className="rounded-lg border border-info/20 bg-info/5 p-3">
    <div className="flex items-start gap-2">
      <Info className="h-4 w-4 text-info mt-0.5 shrink-0" />
      <p className="text-body text-info">
        {t('rewind.noImpact', { defaultValue: '当前已在目标状态，本次不会移除消息、恢复文件或资源，也不会改变当前回退状态。' })}
      </p>
    </div>
  </div>
)
