/**
 * RecordHistorySheet — 右侧面板，展示变更历史
 *
 * 布局模式：
 * - 右侧 Sheet 面板（不遮挡表格主体）
 * - 顶部标题栏
 * - 主体区域：时间线（可折叠日期分组、用户头像、字段级内联 diff）
 * - 底部：快照预览 + 还原按钮 + 确认对话框
 *
 * 使用 ScrollArea 实现平滑滚动。
 */

import * as React from 'react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { Button } from '../button'
import { ScrollArea } from '../scroll-area'
import { cn } from '../../utils/cn'
import { t } from '../../i18n'
import type { HistoryOperation } from './record-history-dialog'
import type { HistoryGroup } from './history-utils'
import { HistoryTimeline } from './history-timeline'
import { formatTimeRange } from './history-utils'
import { LoadingSpinner } from '../loading-spinner'

export interface RecordHistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 记录/表格标签（显示在标题中） */
  label: string
  /** 变更操作列表 */
  operations: HistoryOperation[]
  /** 总操作数 */
  total: number
  /** 是否正在加载 */
  loading?: boolean
  /** 加载更多回调 */
  onLoadMore?: () => void
  /** 字段 ID → 显示名称的映射 */
  fieldNameMap?: Record<string, string>
  /** 字段 ID → 字段类型的映射 */
  fieldTypeMap?: Record<string, string>
  /** 点击历史分组回调（用于高亮单元格） */
  onGroupClick?: (group: HistoryGroup) => void
  /** 请求快照数据的回调 */
  onRequestSnapshot?: (group: HistoryGroup) => void
  /** 请求还原的回调 */
  onRequestRestore?: (group: HistoryGroup) => void
  /** 快照数据（当有值时显示快照预览） */
  snapshotData?: Record<string, unknown> | null
  /** 快照是否正在加载 */
  snapshotLoading?: boolean
  /** 是否正在执行还原 */
  restoreLoading?: boolean
  /** 清理当前历史预览选中态（用于外部还原主视图） */
  onClearSelection?: () => void
  /** 当前语言 locale（如 'zh-CN'、'en-US'），影响日期和时间格式化 */
  locale?: string
}

export const RecordHistorySheet: React.FC<RecordHistorySheetProps> = ({
  open,
  onOpenChange,
  label,
  operations,
  total,
  loading = false,
  onLoadMore,
  fieldNameMap = {},
  fieldTypeMap = {},
  onGroupClick,
  onRequestSnapshot,
  onRequestRestore,
  snapshotData,
  snapshotLoading = false,
  restoreLoading = false,
  onClearSelection,
  locale,
}) => {
  const [activeGroupId, setActiveGroupId] = React.useState<string | null>(null)
  const [activeGroup, setActiveGroup] = React.useState<HistoryGroup | null>(null)
  const [showRestoreConfirm, setShowRestoreConfirm] = React.useState(false)
  const [showSnapshot, setShowSnapshot] = React.useState(false)

  const handleExitPreview = React.useCallback(() => {
    setActiveGroupId(null)
    setActiveGroup(null)
    setShowSnapshot(false)
    onClearSelection?.()
  }, [onClearSelection])

  const handleInteractOutside = React.useCallback((event: Event) => {
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest('[role="dialog"]')
    ) {
      event.preventDefault()
    }
  }, [])

  const handleGroupClick = React.useCallback(
    (group: HistoryGroup) => {
      const isDeselect = activeGroupId === group.id
      if (isDeselect) {
        return
      }
      setActiveGroupId(group.id)
      setActiveGroup(group)
      setShowSnapshot(true)
      onGroupClick?.(group)
      onRequestSnapshot?.(group)
    },
    [activeGroupId, onGroupClick, onRequestSnapshot],
  )

  // Clear state when panel closes
  React.useEffect(() => {
    if (!open) {
      setActiveGroupId(null)
      setActiveGroup(null)
      setShowSnapshot(false)
      onClearSelection?.()
    }
  }, [onClearSelection, open])

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        side="right"
        overlay={false}
        className="w-[420px] sm:max-w-[420px] p-0 flex flex-col"
        onInteractOutside={handleInteractOutside}
        onPointerDownOutside={handleInteractOutside}
      >
        {/* ── Header ── */}
        <SheetHeader className="px-4 py-3 border-b border-border/40 shrink-0">
          <SheetTitle className="text-body font-semibold flex items-center gap-2 pr-8">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden="true">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            {t('historySheet.title')}
          </SheetTitle>
          <SheetDescription className="text-body truncate text-muted-foreground/80" title={label}>
            {label}
          </SheetDescription>
        </SheetHeader>

        {/* ── Timeline content ── */}
        <ScrollArea className="flex-1">
          <div className="px-3 py-2">
            <HistoryTimeline
              operations={operations}
              total={total}
              loading={loading}
              onLoadMore={onLoadMore}
              fieldNameMap={fieldNameMap}
              fieldTypeMap={fieldTypeMap}
              onGroupClick={handleGroupClick}
              activeGroupId={activeGroupId}
              locale={locale}
            />
          </div>
        </ScrollArea>

        {/* ── Bottom snapshot preview & restore ── */}
        {activeGroup && showSnapshot && (onRequestSnapshot || onRequestRestore) && (
          <div className="shrink-0 border-t border-border/40 bg-muted/20 animate-in slide-in-from-bottom-2 duration-200">
            {snapshotLoading ? (
              <LoadingSpinner size="xs" text={t('historySheet.snapshotLoading')} className="py-4" textClassName="text-body" />
            ) : snapshotData ? (
              <div className="p-3 space-y-2">
                {/* Snapshot header */}
                <div className="flex items-center justify-between">
                  <span className="text-caption font-medium text-muted-foreground">
                    {t('historySheet.snapshotPreview')}
                  </span>
                  <button
                    type="button"
                    className="text-caption text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                    onClick={() => setShowSnapshot(false)}
                  >
                    ✕
                  </button>
                </div>

                {/* Snapshot field list */}
                <ScrollArea className="max-h-[180px]">
                  <div className="space-y-0.5">
                    {Object.entries(snapshotData).map(([fieldId, value]) => {
                      const isChanged = activeGroup.changes.some(
                        (c) => c.fieldId === fieldId,
                      )
                      return (
                        <div
                          key={fieldId}
                          className={cn(
                            'flex items-center gap-2 text-caption px-2 py-1 rounded',
                            isChanged
                              ? 'bg-warning/10 ring-1 ring-warning/20'
                              : '',
                          )}
                        >
                          <span className={cn(
                            'font-medium min-w-[72px] max-w-[100px] truncate shrink-0',
                            isChanged ? 'text-foreground' : 'text-muted-foreground/60',
                          )}>
                            {fieldNameMap[fieldId] || fieldId}
                          </span>
                          <span className="text-foreground/80 truncate">
                            {value === null || value === undefined
                              ? <span className="text-muted-foreground/40 italic">-</span>
                              : typeof value === 'object'
                                ? JSON.stringify(value)
                                : String(value)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </ScrollArea>

                {/* Restore button */}
                <div className="flex items-center gap-2">
                  {onRequestRestore && (
                    <Button
                      size="sm"
                      className="flex-1 text-body"
                      disabled={restoreLoading}
                      onClick={() => setShowRestoreConfirm(true)}
                    >
                      {restoreLoading
                        ? t('historySheet.restoring')
                        : t('historySheet.restoreToVersion')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 text-body"
                    onClick={handleExitPreview}
                  >
                    {t('historySheet.backToTable') || '返回表格'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="py-4 px-3 space-y-3">
                <div className="text-caption text-muted-foreground/60 text-center">
                  {t('historySheet.clickToPreview')}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full text-body"
                  onClick={handleExitPreview}
                >
                  {t('historySheet.backToTable') || '返回表格'}
                </Button>
              </div>
            )}
          </div>
        )}
      </SheetContent>

      {/* ── Restore confirmation dialog ── */}
      <Dialog open={showRestoreConfirm} onOpenChange={setShowRestoreConfirm}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('historySheet.restoreConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('historySheet.restoreConfirmDescription')}
              {activeGroup && (
                <span className="block mt-2 text-body text-muted-foreground tabular-nums bg-muted/50 rounded px-2 py-1">
                  {activeGroup.user?.name || 'System'} · {formatTimeRange(activeGroup.startTime, activeGroup.endTime, locale)}
                  {activeGroup.changes.length > 0 && (
                    <> · {t('historySheet.fieldChangesCount', { count: activeGroup.changes.length })}</>
                  )}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowRestoreConfirm(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={restoreLoading}
              onClick={() => {
                if (activeGroup && onRequestRestore) {
                  setShowRestoreConfirm(false)
                  onRequestRestore(activeGroup)
                }
              }}
            >
              {restoreLoading
                ? t('historySheet.restoring')
                : t('historySheet.restoreToVersion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  )
}
