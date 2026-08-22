import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import type { RecommendationOption, RecommendationStats, RecommendationCaseType } from '../../types'
import { t } from '../../i18n'

export interface RecommendationDialogProps {
  options: RecommendationOption[]
  stats?: RecommendationStats
  caseType?: RecommendationCaseType
  blockedReason?: string
  diagnosisHint?: string
  loading?: boolean
  disabled?: boolean
  error?: string
  onConfirm: (payload: { id: string; instruction: string }) => void
  onSkip?: () => void
  crawlTabId?: string
  executeScript?: (code: string, viewId: string) => Promise<any>
}

const CASE_TYPE_LABELS: Record<RecommendationCaseType, { labelKey: string; descKey: string; tone: string }> = {
  direct_extract: {
    labelKey: 'recommendationDialog.case.directExtract.label',
    descKey: 'recommendationDialog.case.directExtract.desc',
    tone: 'text-success'
  },
  auth_required: {
    labelKey: 'recommendationDialog.case.authRequired.label',
    descKey: 'recommendationDialog.case.authRequired.desc',
    tone: 'text-warning'
  },
  captcha: {
    labelKey: 'recommendationDialog.case.captcha.label',
    descKey: 'recommendationDialog.case.captcha.desc',
    tone: 'text-warning'
  },
  action_required: {
    labelKey: 'recommendationDialog.case.actionRequired.label',
    descKey: 'recommendationDialog.case.actionRequired.desc',
    tone: 'text-brand-600'
  },
  empty_content: {
    labelKey: 'recommendationDialog.case.emptyContent.label',
    descKey: 'recommendationDialog.case.emptyContent.desc',
    tone: 'text-destructive'
  },
  unsupported: {
    labelKey: 'recommendationDialog.case.unsupported.label',
    descKey: 'recommendationDialog.case.unsupported.desc',
    tone: 'text-destructive'
  }
}

const formatConfidence = (confidence: number): string => (Math.max(0, Math.min(1, confidence)) * 100).toFixed(0)
const formatDuration = (duration: number): string => {
  if (!Number.isFinite(duration)) return '-'
  if (duration < 1000) return t('duration.milliseconds', { value: Math.round(duration) })
  return t('duration.seconds', { value: (duration / 1000).toFixed(1) })
}

export const RecommendationDialog: React.FC<RecommendationDialogProps> = ({
  options,
  stats,
  caseType,
  blockedReason,
  diagnosisHint,
  loading = false,
  disabled = false,
  error,
  onConfirm,
  onSkip,
  crawlTabId,
  executeScript
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const caseMeta = caseType ? CASE_TYPE_LABELS[caseType] : null

  useEffect(() => {
    if (options.length === 0) {
      setSelectedId(null)
      setInstruction('')
      return
    }
    const next = options[0]
    setSelectedId(prev => prev ?? next.id)
    setInstruction(prev => (prev ? prev : next.title))
  }, [options])

  useEffect(() => {
    if (!selectedId) return
    const current = options.find(item => item.id === selectedId)
    if (current && instruction.trim().length === 0) {
      setInstruction(current.title)
    }
  }, [selectedId, options, instruction])

  const removeAllHighlights = async () => {
    if (!crawlTabId || !executeScript) return
    const code = `
      const highlightElements = document.querySelectorAll('[data-tabtin-highlight]');
      highlightElements.forEach(el => {
        el.classList.remove('tabtin-highlight-hover', 'tabtin-highlight-selected');
        el.removeAttribute('data-tabtin-highlight');
      });
      const styleElement = document.getElementById('tabtin-highlight-styles');
      if (styleElement) styleElement.remove();
    `
    try {
      await executeScript(code, crawlTabId)
    } catch (error) {
      console.error('[RecommendationDialog] remove highlight failed:', error)
    }
  }

  const highlightRegion = async (selector: string, type: 'hover' | 'selected') => {
    if (!crawlTabId || !executeScript) {
      return
    }
    const highlightFn = (sel: string, highlightType: string) => {
      const CSS_STYLES = `
        .tabtin-highlight-hover { outline: 2px dashed rgba(59, 130, 246, 0.6) !important; outline-offset: 2px !important; background-color: rgba(59, 130, 246, 0.05) !important; transition: all 0.2s ease !important; position: relative !important; z-index: 9999 !important; }
        .tabtin-highlight-selected { outline: 3px solid rgba(59, 130, 246, 0.9) !important; outline-offset: 3px !important; background-color: rgba(59, 130, 246, 0.12) !important; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3) !important; animation: tabtin-pulse 2s ease-in-out infinite !important; transition: all 0.3s ease !important; position: relative !important; z-index: 9999 !important; }
      `
      if (!document.getElementById('tabtin-highlight-styles')) {
        const styleEl = document.createElement('style')
        styleEl.id = 'tabtin-highlight-styles'
        styleEl.textContent = CSS_STYLES
        document.head.appendChild(styleEl)
      }
      document.querySelectorAll('[data-tabtin-highlight]').forEach(el => {
        el.classList.remove('tabtin-highlight-hover', 'tabtin-highlight-selected')
        el.removeAttribute('data-tabtin-highlight')
      })
      const target = document.querySelector(sel)
      if (target) {
        target.setAttribute('data-tabtin-highlight', highlightType)
        target.classList.add('tabtin-highlight-' + highlightType)
        const rect = target.getBoundingClientRect()
        const inView = rect.top >= 0 && rect.bottom <= window.innerHeight
        if (!inView) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
        }
      }
    }
    try {
      await executeScript(`(${highlightFn})(\`${selector}\`, '${type}')`, crawlTabId)
    } catch (error) {
      console.error('[RecommendationDialog] highlight failed:', error)
    }
  }

  const selectedOption = useMemo(
    () => options.find(item => item.id === selectedId),
    [options, selectedId]
  )

  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape to close + Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onSkip?.()
      return
    }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [onSkip])

  // Auto-focus dialog on mount
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="recommendation-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="max-w-3xl w-full mx-4 rounded-2xl bg-card shadow-2xl overflow-hidden border border-border focus:outline-none">
        <div className="px-6 py-5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-brand-100 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-brand-600" />
            </div>
            <div>
              <h2 id="recommendation-dialog-title" className="text-title font-semibold text-foreground">{t('recommendationDialog.title')}</h2>
              {stats && (
                <p className="text-body text-muted-foreground mt-1">
                  {t('recommendationDialog.stats', {
                    duration: formatDuration(stats.totalDuration),
                    status: stats.statusCode,
                    count: stats.retryCount ?? 0
                  })}
                </p>
              )}
            </div>
          </div>
          {caseType && (
            <div className="mt-3 flex items-center gap-2 text-body">
              <AlertCircle className="w-4 h-4" />
              {caseMeta && (
                <>
                  <span className={caseMeta.tone}>{t(caseMeta.labelKey)}</span>
                  <span className="text-muted-foreground">{t(caseMeta.descKey)}</span>
                </>
              )}
            </div>
          )}
          {blockedReason && (
            <div className="mt-2 text-body text-warning flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              <span>{blockedReason}</span>
            </div>
          )}
          {diagnosisHint && (
            <div className="mt-1 text-body text-muted-foreground flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-success" />
              <span>{diagnosisHint}</span>
            </div>
          )}
        </div>

        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {loading && (
            <div className="text-body text-muted-foreground">{t('recommendationDialog.loading')}</div>
          )}
          {error && (
            <div className="text-body text-destructive">{error}</div>
          )}
          {!loading && options.length === 0 && (
            <div className="text-body text-muted-foreground">{t('recommendationDialog.empty')}</div>
          )}
          {!loading && options.length > 0 && (
            <div className="grid gap-3">
              {options.map(option => (
                <div
                  key={option.id}
                  className={`border rounded-xl p-4 transition-all ${
                    option.id === selectedId ? 'border-brand-400 bg-brand-50' : 'border-border bg-card'
                  }`}
                  onMouseEnter={() => {
                    setHoveredId(option.id)
                    if (option.target_region?.selector) {
                      void highlightRegion(option.target_region.selector, 'hover')
                    }
                  }}
                  onMouseLeave={() => {
                    setHoveredId(null)
                    void removeAllHighlights()
                  }}
                  onClick={() => setSelectedId(option.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-brand-600" />
                      <span className="font-semibold text-foreground">{option.title}</span>
                    </div>
                    <span className="text-body text-muted-foreground">
                      {t('recommendationDialog.confidence', { value: formatConfidence(option.confidence || 0) })}
                    </span>
                  </div>
                  {option.target_region?.selector && (
                    <div className="mt-1 text-body text-muted-foreground">
                      {t('recommendationDialog.targetRegion', { selector: option.target_region.selector })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between gap-3">
          <div className="flex-1">
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-body focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
              placeholder={t('recommendationDialog.instructionPlaceholder')}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="flex items-center gap-2">
            {onSkip && (
              <Button variant="secondary" size="sm" onClick={onSkip} disabled={disabled}>
                {t('recommendationDialog.actions.skip')}
              </Button>
            )}
            <Button size="sm" onClick={() => selectedId && onConfirm({ id: selectedId, instruction })} disabled={disabled || !selectedId}>
              {t('recommendationDialog.actions.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
