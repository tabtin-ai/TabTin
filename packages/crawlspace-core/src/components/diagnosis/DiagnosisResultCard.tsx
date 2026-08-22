import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Info, XCircle, AlertTriangle, CheckCircle2, ThumbsUp, ThumbsDown, type LucideIcon } from 'lucide-react'
import { t } from '../../i18n'

export type DiagnosisCaseType =
  | 'page_changed'
  | 'auth_required'
  | 'captcha_blocked'
  | 'interaction_required'
  | 'empty_content'
  | 'task_misconfigured'
  | 'network_or_block'

export type FeedbackType = 'accurate' | 'inaccurate'

export interface DiagnosisResultCardProps {
  caseType: DiagnosisCaseType
  diagnosisHint: string
  evidence?: string[]
  suggestedActions?: string[]
  confidence?: number
  fromCache?: boolean
  processingTime?: number
  onActionClick?: (action: string) => void
  onFeedback?: (feedback: FeedbackType) => void
  showFeedback?: boolean
  className?: string
}

const CASE_TYPE_CONFIG: Record<
  DiagnosisCaseType,
  {
    labelKey: string
    icon: LucideIcon
    bgColor: string
    borderColor: string
    iconColor: string
    titleColor: string
    textColor: string
  }
> = {
  page_changed: {
    labelKey: 'diagnosis.case.pageChanged',
    icon: AlertCircle,
    bgColor: 'bg-warning',
    borderColor: 'border-warning',
    iconColor: 'text-warning',
    titleColor: 'text-warning',
    textColor: 'text-warning',
  },
  auth_required: {
    labelKey: 'diagnosis.case.authRequired',
    icon: Info,
    bgColor: 'bg-info',
    borderColor: 'border-info',
    iconColor: 'text-info',
    titleColor: 'text-info',
    textColor: 'text-info',
  },
  captcha_blocked: {
    labelKey: 'diagnosis.case.captchaBlocked',
    icon: XCircle,
    bgColor: 'bg-destructive',
    borderColor: 'border-destructive',
    iconColor: 'text-destructive',
    titleColor: 'text-destructive',
    textColor: 'text-destructive',
  },
  interaction_required: {
    labelKey: 'diagnosis.case.interactionRequired',
    icon: Info,
    bgColor: 'bg-type-agent/10',
    borderColor: 'border-type-agent/20',
    iconColor: 'text-type-agent',
    titleColor: 'text-type-agent',
    textColor: 'text-type-agent',
  },
  empty_content: {
    labelKey: 'diagnosis.case.emptyContent',
    icon: AlertTriangle,
    bgColor: 'bg-muted/30',
    borderColor: 'border-border',
    iconColor: 'text-muted-foreground',
    titleColor: 'text-foreground',
    textColor: 'text-muted-foreground',
  },
  task_misconfigured: {
    labelKey: 'diagnosis.case.taskMisconfigured',
    icon: AlertTriangle,
    bgColor: 'bg-warning/10',
    borderColor: 'border-warning/20',
    iconColor: 'text-warning',
    titleColor: 'text-warning',
    textColor: 'text-warning',
  },
  network_or_block: {
    labelKey: 'diagnosis.case.networkOrBlock',
    icon: XCircle,
    bgColor: 'bg-destructive',
    borderColor: 'border-destructive',
    iconColor: 'text-destructive',
    titleColor: 'text-destructive',
    textColor: 'text-destructive',
  },
}

export const DiagnosisResultCard: React.FC<DiagnosisResultCardProps> = ({
  caseType,
  diagnosisHint,
  evidence = [],
  suggestedActions = [],
  confidence,
  fromCache = false,
  processingTime,
  onActionClick,
  onFeedback,
  showFeedback = true,
  className = '',
}) => {
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)
  const config = CASE_TYPE_CONFIG[caseType]
  const IconComponent = config.icon
  const formattedProcessingTime =
    processingTime !== undefined
      ? (processingTime >= 1000
          ? t('duration.seconds', { value: (processingTime / 1000).toFixed(1) })
          : t('duration.milliseconds', { value: Math.round(processingTime) }))
      : ''

  const handleFeedback = (feedback: FeedbackType) => {
    if (onFeedback) {
      onFeedback(feedback)
      setFeedbackSubmitted(true)
      setTimeout(() => setFeedbackSubmitted(false), 3000)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`rounded-lg border ${config.bgColor} ${config.borderColor} p-4 space-y-3 ${className}`}
    >
      <div className="flex items-start gap-3">
        <IconComponent className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.iconColor}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-body font-semibold ${config.titleColor}`}>
              {t(config.labelKey)}
            </span>
            {typeof confidence === 'number' && (
              <span className="text-body text-muted-foreground">
                {t('diagnosis.confidence', { value: (confidence * 100).toFixed(0) })}
              </span>
            )}
            {fromCache && (
              <span className="text-body text-success bg-success px-2 py-1 rounded">
                {t('diagnosis.cache')}
              </span>
            )}
            {processingTime !== undefined && (
              <span className="text-body text-muted-foreground">
                {t('diagnosis.processingTime', { time: formattedProcessingTime })}
              </span>
            )}
          </div>
          <p className={`mt-1 text-body ${config.textColor}`}>{diagnosisHint}</p>
        </div>
      </div>

      {evidence.length > 0 && (
        <div className="space-y-1">
          <p className="text-body font-semibold text-muted-foreground">{t('diagnosis.evidence')}</p>
          <ul className="text-body text-muted-foreground list-disc list-inside space-y-1">
            {evidence.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {suggestedActions.length > 0 && (
        <div className="space-y-2">
          <p className="text-body font-semibold text-muted-foreground">{t('diagnosis.suggestedActions')}</p>
          <div className="flex flex-wrap gap-2">
            {suggestedActions.map((action, idx) => (
              <button
                key={idx}
                onClick={() => onActionClick?.(action)}
                className="text-body px-3 py-1 rounded-full border border-border bg-background hover:border-border/80"
              >
                {action}
              </button>
            ))}
          </div>
        </div>
      )}

      {showFeedback && (
        <div className="flex items-center gap-3">
          <span className="text-body text-muted-foreground">{t('diagnosis.feedback.prompt')}</span>
          <button
            onClick={() => handleFeedback('accurate')}
            className="flex items-center gap-1 text-body text-success hover:text-success"
            disabled={feedbackSubmitted}
          >
            <ThumbsUp className="w-4 h-4" />
            {t('diagnosis.feedback.accurate')}
          </button>
          <button
            onClick={() => handleFeedback('inaccurate')}
            className="flex items-center gap-1 text-body text-destructive hover:text-destructive"
            disabled={feedbackSubmitted}
          >
            <ThumbsDown className="w-4 h-4" />
            {t('diagnosis.feedback.inaccurate')}
          </button>
          {feedbackSubmitted && (
            <span className="text-body text-muted-foreground">{t('diagnosis.feedback.thanks')}</span>
          )}
        </div>
      )}
    </motion.div>
  )
}
