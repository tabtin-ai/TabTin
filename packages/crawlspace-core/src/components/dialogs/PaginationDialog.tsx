import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, MousePointerClick, ArrowDown, XCircle, Sparkles, Activity, ChevronRight } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { t } from '../../i18n'

type PaginationMethod = 'click' | 'scroll' | 'both'

export interface PaginationInfo {
  recommendation?: {
    pages?: number
    method?: PaginationMethod
  }
  aiDetection?: {
    detected?: boolean
    type?: PaginationMethod | 'infinite_scroll' | 'load_more'
    selector?: string
    confidence?: number
    pageNumbers?: { current?: number; total?: number }
  }
  scrollDetection?: {
    tested?: boolean
    initialItemCount?: number
    afterScrollItemCount?: number
    scrollDistance?: number
    hasMore?: boolean
  }
}

export interface PaginationDialogProps {
  isOpen: boolean
  paginationInfo: PaginationInfo
  onConfirm: (pages: number, method: PaginationMethod) => void
  onDiscard: () => void
}

export const PaginationDialog: React.FC<PaginationDialogProps> = ({
  isOpen,
  paginationInfo,
  onConfirm,
  onDiscard,
}) => {
  const [selectedPages, setSelectedPages] = useState(5)
  const [selectedMethod, setSelectedMethod] = useState<PaginationMethod>(
    paginationInfo.recommendation?.method || 'click'
  )
  const [crawlToEnd, setCrawlToEnd] = useState(false)

  if (!isOpen) return null

  const crawlToEndClasses = crawlToEnd
    ? 'border-success bg-success'
    : 'border-border bg-background'

  const handleConfirm = () => {
    const pages = crawlToEnd ? -1 : selectedPages
    onConfirm(pages, selectedMethod)
  }

  const dialogRef = useRef<HTMLDivElement>(null)

  // Escape to close + Focus trap
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onDiscard()
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
  }, [onDiscard])

  // Auto-focus dialog on mount
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-modal" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pagination-dialog-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-card rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto border border-border focus:outline-none">
        <div className="px-6 py-5 border-b border-border bg-muted/30">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 bg-success rounded-xl flex items-center justify-center">
                <Activity className="w-6 h-6 text-success" />
              </div>
              <div>
                <h2 id="pagination-dialog-title" className="text-title font-semibold text-foreground">{t('paginationDialog.title')}</h2>
                <p className="text-body text-muted-foreground mt-1">
                  {t('paginationDialog.description')}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-gradient-to-br from-brand-50 to-brand-100 rounded-lg p-4 border border-brand-200">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-5 h-5 text-brand-600" />
              <h3 className="font-semibold text-foreground">{t('paginationDialog.ai.title')}</h3>
            </div>

            {paginationInfo.aiDetection?.detected ? (
              <div className="space-y-2 text-body">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.ai.detectionType')}</span>
                  <span className="font-medium text-foreground">
                    {paginationInfo.aiDetection.type === 'click' && t('paginationDialog.method.click')}
                    {paginationInfo.aiDetection.type === 'load_more' && t('paginationDialog.method.loadMore')}
                    {paginationInfo.aiDetection.type === 'infinite_scroll' && t('paginationDialog.method.infiniteScroll')}
                    {paginationInfo.aiDetection.type === 'scroll' && t('paginationDialog.method.scroll')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.ai.selector')}</span>
                  <code className="px-2 py-1 bg-background rounded text-body font-mono border border-brand-200">
                    {paginationInfo.aiDetection.selector}
                  </code>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.ai.confidence')}</span>
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-brand-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-600 transition-all"
                        style={{ width: `${(paginationInfo.aiDetection.confidence || 0) * 100}%` }}
                      />
                    </div>
                    <span className="font-medium text-foreground">
                      {((paginationInfo.aiDetection.confidence || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                {paginationInfo.aiDetection.pageNumbers && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">{t('paginationDialog.ai.pageInfo')}</span>
                    <span className="font-medium text-foreground">
                      {paginationInfo.aiDetection.pageNumbers.total
                        ? t('paginationDialog.ai.pageInfoDetail', {
                            current: paginationInfo.aiDetection.pageNumbers.current ?? '-',
                            total: paginationInfo.aiDetection.pageNumbers.total
                          })
                        : t('paginationDialog.ai.pageInfoDetailSimple', {
                            current: paginationInfo.aiDetection.pageNumbers.current ?? '-'
                          })}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-body text-muted-foreground">{t('paginationDialog.ai.noDetection')}</p>
            )}
          </div>

          {paginationInfo.scrollDetection?.tested && (
            <div className="bg-gradient-to-br from-brand-50 to-pink-50 rounded-lg p-4 border border-brand-200">
              <div className="flex items-center gap-2 mb-3">
                <ArrowDown className="w-5 h-5 text-brand-600" />
                <h3 className="font-semibold text-foreground">{t('paginationDialog.scroll.title')}</h3>
              </div>

              <div className="space-y-2 text-body">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.scroll.initialCount')}</span>
                  <span className="font-medium text-foreground">
                    {paginationInfo.scrollDetection.initialItemCount}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.scroll.afterCount')}</span>
                  <span className="font-medium text-foreground">
                    {paginationInfo.scrollDetection.afterScrollItemCount}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('paginationDialog.scroll.distance')}</span>
                  <span className="font-medium text-foreground">
                    {paginationInfo.scrollDetection.scrollDistance ?? '-'} px
                  </span>
                </div>
              </div>
            </div>
          )}

          <div className="bg-card rounded-lg p-4 border-2 border-border">
            <h3 className="font-semibold text-foreground mb-4">{t('paginationDialog.config.title')}</h3>

            <div className="mb-4">
              <label className="text-body font-medium text-foreground mb-2 block">
                {t('paginationDialog.config.methodLabel')}
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['click', 'scroll', 'both'] as PaginationMethod[]).map(method => (
                  <button
                    key={method}
                    onClick={() => setSelectedMethod(method)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 transition-all ${
                      selectedMethod === method
                        ? 'border-success bg-success text-success'
                        : 'border-border hover:border-border/80 text-muted-foreground'
                    }`}
                  >
                    {method === 'click' && <MousePointerClick className="w-5 h-5" />}
                    {method === 'scroll' && <ArrowDown className="w-5 h-5" />}
                    {method === 'both' && <Activity className="w-5 h-5" />}
                    <span className="text-body font-medium">
                      {method === 'click' && t('paginationDialog.method.click')}
                      {method === 'scroll' && t('paginationDialog.method.scroll')}
                      {method === 'both' && t('paginationDialog.method.both')}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-body font-medium text-foreground mb-2 block">
                {t('paginationDialog.config.pagesLabel')}
              </label>

              <div className="mb-3">
                <label
                  className={`flex items-center gap-2 cursor-pointer p-3 rounded-lg border-2 transition-all hover:bg-muted/40 ${crawlToEndClasses}`}
                >
                  <input
                    type="checkbox"
                    checked={crawlToEnd}
                    onChange={(e) => setCrawlToEnd(e.target.checked)}
                    className="w-4 h-4 rounded border-border text-success focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
                  />
                  <div className="flex-1">
                    <span className="text-body font-medium text-foreground">
                      {t('paginationDialog.config.crawlToEndTitle')}
                    </span>
                    <p className="text-body text-muted-foreground mt-0.5">
                      {t('paginationDialog.config.crawlToEndDesc')}
                    </p>
                  </div>
                </label>
              </div>

              <div className={`${crawlToEnd ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-4">
                  <input
                    type="range"
                    min="1"
                    max="100"
                    value={selectedPages}
                    onChange={(e) => setSelectedPages(Number(e.target.value))}
                    disabled={crawlToEnd}
                    className="flex-1"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={selectedPages}
                      onChange={(e) => setSelectedPages(Number(e.target.value))}
                      disabled={crawlToEnd}
                      className="w-20 px-3 py-2 border border-border bg-background rounded-lg text-center font-medium text-foreground"
                    />
                    <span className="text-body text-muted-foreground">{t('paginationDialog.config.pageUnit')}</span>
                  </div>
                </div>
                <p className="text-body text-muted-foreground mt-2">
                  {crawlToEnd
                    ? t('paginationDialog.config.tip.crawlToEnd')
                    : t('paginationDialog.config.tip.suggest')}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-warning rounded-lg p-4 border border-warning">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
              <div className="text-body text-warning">
                <p className="font-medium mb-1">{t('paginationDialog.notice.title')}</p>
                <ul className="space-y-1 list-disc list-inside text-body">
                  <li>{t('paginationDialog.notice.item1')}</li>
                  <li>{t('paginationDialog.notice.item2')}</li>
                  <li>{t('paginationDialog.notice.item3')}</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 bg-muted/30 border-t border-border flex items-center justify-end gap-3">
          <Button variant="outline" onClick={onDiscard} className="px-4 py-2">
            <XCircle className="w-4 h-4 mr-2" />
            {t('paginationDialog.actions.discard')}
          </Button>
          <Button onClick={handleConfirm} className="px-4 py-2 bg-success hover:bg-success text-white">
            <ChevronRight className="w-4 h-4 mr-2" />
            {crawlToEnd
              ? t('paginationDialog.actions.startAll')
              : t('paginationDialog.actions.startPages', { count: selectedPages })}
          </Button>
        </div>
      </div>
    </div>
  )
}
