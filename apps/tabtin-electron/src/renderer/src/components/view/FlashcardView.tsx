import React, { useEffect, useCallback, useRef } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Check,
  RotateCcw,
  Shuffle,
  FlipHorizontal2,
  ListRestart,
  Loader2,
} from 'lucide-react'
import { cn } from '@utils/cn'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { CollabStatus } from '@tabtin/collab-core'
import { shouldProjectViewRecordsFromCollabYdoc, useTableCollab } from '@components/table/TableCollabContext'
import { useTranslation } from 'react-i18next'
import {
  useFlashcardViewController,
  type FlashcardViewControllerState,
} from './controller/useFlashcardViewController'
import { RecordCommentCountBadge } from './RecordCommentCountBadge'

const FLASHCARD_LOAD_MORE_PAGE_SIZE = 200

const formatCellText = (value: unknown): string => {
  if (value == null || value === '') return '—'
  if (Array.isArray(value)) return value.map(v => String(v ?? '')).join(', ')
  return String(value)
}

export const FlashcardView: React.FC<{ isReadonly?: boolean }> = ({ isReadonly = false }) => {
  const { t } = useTranslation('view')
  const { isCollabRuntime, collabBridge } = useTableCollab()
  const isTruncated = collabBridge.collab.isTruncated
  const isCollabProjectionReady =
    isCollabRuntime && collabBridge.collab.status === CollabStatus.SYNCED
  const viewStoreApi = useViewStoreApi()
  const currentViewRecords = useViewStore(s => s.currentViewRecords)
  const isRecordsLoading = useViewStore(s => s.isRecordsLoading)
  const isLoadingMoreRecords = useViewStore(s => s.isLoadingMoreRecords)
  const views = useViewStore(s => s.views)
  const currentViewId = useViewStore(s => s.currentViewId)
  const refreshCurrentView = useViewStore(s => s.refreshCurrentView)
  const loadMoreCurrentViewRecords = useViewStore(s => s.loadMoreCurrentViewRecords)
  const fields = useTableStore(s => s.fields)

  const currentView = views.find(v => v.id === currentViewId)

  const ctrl = useFlashcardViewController({
    currentView,
    currentViewRecords,
    fields,
    refreshCurrentView,
    isReadonly,
  })

  const ctrlRef = useRef<FlashcardViewControllerState>(ctrl)
  ctrlRef.current = ctrl

  const containerRef = useRef<HTMLDivElement>(null)
  const loadMoreInFlightRef = useRef(false)
  const requestLoadMoreRef = useRef<() => void>(() => {})

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null
    // 焦点在任意可编辑元素（侧边栏聊天框 / 文档 / 单元格编辑器等）→ 不抢空格/方向键
    if (
      active &&
      (active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.tagName === 'SELECT' ||
        active.isContentEditable)
    ) {
      return
    }
    // 焦点明确落在其它面板（如另一个分屏 pane）→ 不抢键；仅在焦点位于本视图内、或页面无明确焦点时响应
    const root = containerRef.current
    if (active && active !== document.body && root && !root.contains(active)) {
      return
    }
    const c = ctrlRef.current
    switch (e.key) {
      case ' ':
        e.preventDefault()
        c.flipCard()
        break
      case 'ArrowRight':
        e.preventDefault()
        if (c.currentIndex >= c.totalCards - 1) {
          requestLoadMoreRef.current()
        } else {
          c.nextCard()
        }
        break
      case 'ArrowLeft':
        e.preventDefault()
        c.prevCard()
        break
      case '1':
        e.preventDefault()
        if (c.isReadonly) break
        void c.markMastered()
        break
      case '2':
        e.preventDefault()
        if (c.isReadonly) break
        void c.markNotMastered()
        break
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const loadedCount = currentViewRecords?.records?.length ?? 0
  const totalCount = Math.max(0, currentViewRecords?.matched_total ?? currentViewRecords?.total ?? 0)
  const hasMoreRecords = loadedCount < totalCount

  const requestLoadMore = useCallback(() => {
    if (!hasMoreRecords || isRecordsLoading || isLoadingMoreRecords || loadMoreInFlightRef.current) {
      return
    }
    loadMoreInFlightRef.current = true
    const recordsQuery = viewStoreApi.getState().recordsQuery
    if (shouldProjectViewRecordsFromCollabYdoc(isCollabRuntime, isTruncated, isCollabProjectionReady)) {
      const currentPageSize = recordsQuery.page_size
      const nextPageSize = Math.min(
        Math.max(currentPageSize, loadedCount) + FLASHCARD_LOAD_MORE_PAGE_SIZE,
        Math.max(loadedCount, totalCount),
      )
      if (nextPageSize > currentPageSize) {
        viewStoreApi.setState(state => ({
          recordsQuery: {
            ...state.recordsQuery,
            page: 1,
            page_size: nextPageSize,
          },
        }))
      }
      queueMicrotask(() => {
        loadMoreInFlightRef.current = false
      })
      return
    }
    void loadMoreCurrentViewRecords().finally(() => {
      loadMoreInFlightRef.current = false
    })
  }, [hasMoreRecords, isCollabProjectionReady, isCollabRuntime, isTruncated, isLoadingMoreRecords, isRecordsLoading, loadMoreCurrentViewRecords, loadedCount, totalCount, viewStoreApi])
  requestLoadMoreRef.current = requestLoadMore

  useEffect(() => {
    if (ctrl.totalCards === 0) return
    if (ctrl.currentIndex >= ctrl.totalCards - 2) {
      requestLoadMore()
    }
  }, [ctrl.currentIndex, ctrl.totalCards, requestLoadMore])

  const handleNextCard = useCallback(() => {
    if (ctrl.currentIndex >= ctrl.totalCards - 1) {
      requestLoadMore()
      return
    }
    ctrl.nextCard()
  }, [ctrl, requestLoadMore])

  if (!ctrl.config) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{t('flashcard.noConfig')}</p>
      </div>
    )
  }

  if (ctrl.totalCards === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{t('flashcard.noCards')}</p>
      </div>
    )
  }

  const card = ctrl.cards[ctrl.currentIndex]
  if (!card) return null
  const cardRecordId = typeof (card as Record<string, unknown>).id === 'string'
    ? String((card as Record<string, unknown>).id)
    : null

  const frontValue = ctrl.frontField
    ? ctrl.getRecordFieldValue(card, ctrl.frontField.id)
    : undefined
  const backValue = ctrl.backField
    ? ctrl.getRecordFieldValue(card, ctrl.backField.id)
    : undefined
  const tagsValue = ctrl.tagsField
    ? ctrl.getRecordFieldValue(card, ctrl.tagsField.id)
    : undefined

  const progressPct = ctrl.totalCards > 0
    ? Math.round((ctrl.masteredCount / ctrl.totalCards) * 100)
    : 0

  return (
    <div ref={containerRef} className="flex h-full flex-col">
      {/* Progress bar */}
      {ctrl.config.show_progress !== false && (
        <div className="flex items-center gap-3 border-b px-4 py-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="shrink-0 text-body text-muted-foreground">
            {t('flashcard.progress', {
              mastered: ctrl.masteredCount,
              total: ctrl.totalCards,
            })}
          </span>
        </div>
      )}

      {/* Card area */}
      <div className="flex flex-1 items-center justify-center px-4 py-6">
        <div className="w-full max-w-lg" style={{ perspective: '1200px' }}>
          <div
            className="relative cursor-pointer transition-transform duration-500"
            style={{
              transformStyle: 'preserve-3d',
              transform: ctrl.isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            }}
            onClick={ctrl.flipCard}
          >
            {/* Front face */}
            <div
              className={cn(
                'rounded-xl border bg-card p-8 shadow-md',
                'min-h-[280px] flex flex-col items-center justify-center',
              )}
              style={{ backfaceVisibility: 'hidden' }}
            >
              <RecordCommentCountBadge
                recordId={cardRecordId}
                className="absolute right-3 top-3"
              />
              <span className="mb-2 text-body font-medium uppercase tracking-wider text-muted-foreground">
                {ctrl.frontField?.name ?? t('flashcard.front')}
              </span>
              <div className="max-h-[180px] overflow-auto text-center text-title leading-relaxed whitespace-pre-wrap">
                {formatCellText(frontValue)}
              </div>
              {tagsValue != null && tagsValue !== '' && (
                <div className="mt-4 flex flex-wrap justify-center gap-1">
                  {(Array.isArray(tagsValue) ? tagsValue : [tagsValue]).map(
                    (tag, i) => (
                      <span
                        key={`${String(tag)}-${i}`}
                        className="rounded-md bg-secondary px-2 py-0.5 text-body text-secondary-foreground"
                      >
                        {String(tag)}
                      </span>
                    ),
                  )}
                </div>
              )}
              <span className="mt-4 text-body text-muted-foreground/60">
                {t('flashcard.clickToFlip')}
              </span>
            </div>

            {/* Back face */}
            <div
              className={cn(
                'absolute inset-0 rounded-xl border bg-card p-8 shadow-md',
                'min-h-[280px] flex flex-col items-center justify-center',
              )}
              style={{
                backfaceVisibility: 'hidden',
                transform: 'rotateY(180deg)',
              }}
            >
              <RecordCommentCountBadge
                recordId={cardRecordId}
                className="absolute right-3 top-3"
              />
              <span className="mb-2 text-body font-medium uppercase tracking-wider text-muted-foreground">
                {ctrl.backField?.name ?? t('flashcard.back')}
              </span>
              <div className="max-h-[180px] overflow-auto text-center text-title leading-relaxed whitespace-pre-wrap">
                {formatCellText(backValue)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center gap-3 border-t px-4 py-3">
        <button
          type="button"
          onClick={ctrl.resetProgress}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/8 hover:text-foreground"
          title={t('flashcard.resetProgress')}
        >
          <ListRestart className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={ctrl.shuffleCards}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/8 hover:text-foreground"
          title={t('flashcard.shuffle')}
        >
          <Shuffle className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={ctrl.prevCard}
          disabled={ctrl.currentIndex === 0}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/8 hover:text-foreground disabled:opacity-30"
          title={`${t('flashcard.prev')} (←)`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => void ctrl.markNotMastered()}
          disabled={isReadonly}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-type-cron/30 bg-type-cron/10 px-4 text-body font-medium text-type-cron hover:bg-type-cron/20 disabled:cursor-not-allowed disabled:opacity-40"
          title={`${t('flashcard.again')} (2)`}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('flashcard.again')}
        </button>

        <button
          type="button"
          onClick={ctrl.flipCard}
          className="flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground hover:bg-accent/8 hover:text-foreground"
          title={`${t('flashcard.flip')} (Space)`}
        >
          <FlipHorizontal2 className="h-4 w-4" />
        </button>

        <button
          type="button"
          onClick={() => void ctrl.markMastered()}
          disabled={isReadonly}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-success/40 bg-success/15 px-4 text-body font-medium text-success hover:bg-success/25 disabled:cursor-not-allowed disabled:opacity-40"
          title={`${t('flashcard.knew')} (1)`}
        >
          <Check className="h-3.5 w-3.5" />
          {t('flashcard.knew')}
        </button>

        <button
          type="button"
          onClick={handleNextCard}
          disabled={ctrl.currentIndex >= ctrl.totalCards - 1 && (!hasMoreRecords || isLoadingMoreRecords)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/8 hover:text-foreground disabled:opacity-30"
          title={`${t('flashcard.next')} (→)`}
        >
          {isLoadingMoreRecords && ctrl.currentIndex >= ctrl.totalCards - 1
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <ChevronRight className="h-4 w-4" />}
        </button>

        <span className="ml-2 text-body tabular-nums text-muted-foreground">
          {ctrl.currentIndex + 1} / {ctrl.totalCards}
        </span>
      </div>
    </div>
  )
}
