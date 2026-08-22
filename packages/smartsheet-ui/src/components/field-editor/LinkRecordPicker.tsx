/**
 * LinkRecordPicker — 关联记录选择器（平台无关 UI）
 *
 * - 标题 + 数据源
 * - 搜索范围 + 搜索 + 全部 / 已选中
 * - 多列表格（字段类型图标 + checkbox + 展开）
 * - 底部仅「+ 添加记录」；选中变更由宿主即时落库
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Maximize2, Plus, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../button'
import { Checkbox } from '../checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import { Input } from '../input'
import { LoadingSpinner } from '../loading-spinner'
import { ScrollArea } from '../scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../select'
import { FieldTypeIcon } from '../common/field-type-icon'
import { useOverlayContainer } from '../overlay-container-context'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../tooltip'
import { cn } from '../../utils/cn'
import {
  formatLinkRecordLabel,
  resolveLinkGridCellText,
  UNNAMED_RECORD_DISPLAY_NAME,
} from './linkRecordLabel'

export type LinkPickerListMode = 'all' | 'selected'

/** 关联选择器最小宽度（px）；窄于 TabData 面板时仍保底可读 */
export const LINK_PICKER_MIN_WIDTH_PX = 500

/** 相对 TabData 面板左右各留的空白（px） */
export const LINK_PICKER_SIDE_GUTTER_PX = 200

/**
 * Scoped Dialog 遮罩默认 z-modal 会盖住壳层列分割手柄（ 后手柄仅 z-sticky）。
 * 遮罩只负责视觉压暗；命中穿透到两侧 gutter，才能继续拖对话/画布比例。
 * 须用 `!important`：Radix Dialog Overlay 会写内联 `pointer-events: auto`，普通 utility 盖不住。
 * DialogContent 须配套 `pointer-events-auto`。
 */
export const LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS = '!pointer-events-none'

/**
 * 弹窗尺寸 class：有 OverlayContainer（TabData GridViewHost / ViewContainer）时
 * 宽度 = 面板宽 − 两侧各 200px，最小 500px；否则回退视口约束。
 */
export function resolveLinkPickerDialogSizeClass(scopedToTabData: boolean): string {
  if (scopedToTabData) {
    // 100% − 400px（左右各 200）；min-w 保底 500
    return 'h-[min(560px,85%)] w-[calc(100%-400px)] min-w-[500px] max-w-[calc(100%-400px)]'
  }
  return 'h-[min(560px,80vh)] w-[min(860px,92vw)] min-w-[500px] max-w-4xl'
}

export interface LinkPickerRecord {
  id: string
  title: string
  fields?: Record<string, unknown>
}

export interface LinkPickerField {
  id: string
  name: string
  field_type: string
  is_primary: boolean
}

export interface LinkRecordPickerProps {
  open: boolean
  onClose: () => void
  /** 单选（OneOne / ManyOne） */
  isSingleSelect: boolean
  foreignTableName?: string
  selected: Map<string, { id: string; title?: string }>
  candidates: LinkPickerRecord[]
  displayColumns: LinkPickerField[]
  /** 可供搜索范围选择的字段（通常为完整外表字段） */
  searchFields?: LinkPickerField[]
  isLoading: boolean
  hasMore: boolean
  searchText: string
  onSearchTextChange: (value: string) => void
  listMode: LinkPickerListMode
  onListModeChange: (mode: LinkPickerListMode) => void
  /** 空字符串表示全局搜索 */
  searchFieldId: string
  onSearchFieldIdChange: (fieldId: string) => void
  onToggleRecord: (record: LinkPickerRecord) => void
  onRemoveRecord: (id: string) => void
  onLoadMore: () => void
  onGoToForeignTable?: () => void
  onCreateRecord?: () => void
  /** 内联新建表单展开态由宿主控制 */
  createForm?: React.ReactNode
  previewRecord?: LinkPickerRecord | null
  onPreviewRecordChange?: (record: LinkPickerRecord | null) => void
  /** 打开完整记录详情（跨表） */
  onOpenFullRecord?: (record: LinkPickerRecord) => void
  /** 加载失败时展示重试 */
  loadError?: string | null
  onRetry?: () => void
  className?: string
}

const MAX_DISPLAY_COLUMNS = 5
const SEARCH_GLOBAL_VALUE = '__global__'
const TRUNCATE_OVERFLOW_EPSILON = 1
/** 仅「触发搜索」防抖；输入本地态在独立子组件，避免每键重渲染候选行 */
const SEARCH_TRIGGER_DEBOUNCE_MS = 300

type DebouncedLinkSearchInputProps = {
  /** 宿主已提交的搜索词（打开重置 / 外部清空时同步） */
  committedValue: string
  /** 防抖后通知宿主去搜；清空立即提交 */
  onCommit: (value: string) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  placeholder: string
}

/**
 * 搜索输入独立组件：键入只更新本组件 state，不带动整表重渲染。
 */
const DebouncedLinkSearchInput = React.memo(
  React.forwardRef<HTMLInputElement, DebouncedLinkSearchInputProps>(
    function DebouncedLinkSearchInput(
      { committedValue, onCommit, onKeyDown, placeholder },
      ref,
    ) {
      const [localValue, setLocalValue] = useState(committedValue)
      const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

      useEffect(() => {
        setLocalValue(committedValue)
      }, [committedValue])

      useEffect(() => {
        return () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
        }
      }, [])

      const scheduleCommit = useCallback(
        (value: string) => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
          }
          if (!value.trim()) {
            onCommit(value)
            return
          }
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            onCommit(value)
          }, SEARCH_TRIGGER_DEBOUNCE_MS)
        },
        [onCommit],
      )

      return (
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={ref}
            value={localValue}
            onChange={(e) => {
              const next = e.target.value
              setLocalValue(next)
              scheduleCommit(next)
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="h-8 pl-8 text-body"
          />
        </div>
      )
    },
  ),
)
DebouncedLinkSearchInput.displayName = 'DebouncedLinkSearchInput'

const renderCellValue = (value: unknown): string => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(renderCellValue).join(', ')
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return obj.title ? String(obj.title) : obj.name ? String(obj.name) : JSON.stringify(value)
  }
  return String(value)
}

/** 截断单元格：文字溢出时用项目 Tooltip 展示全文 */
const TruncatedCellText: React.FC<{
  text: string
  className?: string
}> = ({ text, className }) => {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setOpen(false)
      return
    }
    const el = ref.current
    const overflowing = Boolean(
      el && el.scrollWidth - el.clientWidth > TRUNCATE_OVERFLOW_EPSILON,
    )
    setOpen(overflowing)
  }, [])

  if (!text) {
    return <span className={cn('block min-w-0 truncate', className)} />
  }

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>
        <span ref={ref} className={cn('block min-w-0 truncate', className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm whitespace-pre-wrap break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

interface RecordPreviewPanelProps {
  record: LinkPickerRecord
  fields: LinkPickerField[]
  onClose: () => void
  onOpenFull?: () => void
}

const RecordPreviewPanel: React.FC<RecordPreviewPanelProps> = ({
  record,
  fields,
  onClose,
  onOpenFull,
}) => {
  const { t } = useTranslation('field')

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h3 className="truncate text-body font-semibold">
          {formatLinkRecordLabel(
            record.id,
            record.title,
            t('fieldSettingPanel.linkEditor.unnamedRecord', { defaultValue: UNNAMED_RECORD_DISPLAY_NAME }),
          )}
        </h3>
        <div className="flex items-center gap-0.5">
          {onOpenFull && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-caption"
              onClick={onOpenFull}
              title={t('fieldSettingPanel.linkEditor.openFullRecord', {
                defaultValue: '打开完整详情',
              })}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3">
          {fields.length > 0 ? (
            fields.map((field) => (
              <div key={field.id} className="space-y-1">
                <div className="truncate text-caption font-medium text-muted-foreground">
                  {field.name}
                </div>
                <div className="break-words text-body leading-relaxed">
                  {renderCellValue(record.fields?.[field.id]) || '—'}
                </div>
              </div>
            ))
          ) : (
            <div className="space-y-1">
              <div className="text-caption font-medium text-muted-foreground">
                {t('linkEditor.title', { defaultValue: '标题' })}
              </div>
              <div className="text-body">
                {formatLinkRecordLabel(
                  record.id,
                  record.title,
                  t('fieldSettingPanel.linkEditor.unnamedRecord', { defaultValue: UNNAMED_RECORD_DISPLAY_NAME }),
                )}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
      {onOpenFull && (
        <div className="border-t px-3 py-2">
          <Button variant="outline" size="sm" className="h-8 w-full text-body" onClick={onOpenFull}>
            {t('fieldSettingPanel.linkEditor.openFullRecord', {
              defaultValue: '打开完整详情',
            })}
          </Button>
        </div>
      )}
    </div>
  )
}

interface GridRowProps {
  record: LinkPickerRecord
  isSelected: boolean
  isHighlighted: boolean
  isExpanded: boolean
  displayColumns: LinkPickerField[]
  onToggleRecord: (record: LinkPickerRecord) => void
  onExpandRecord: (e: React.MouseEvent, record: LinkPickerRecord) => void
  expandLabel: string
}

const GridRow = React.memo<GridRowProps>(({
  record,
  isSelected,
  isHighlighted,
  isExpanded,
  displayColumns,
  onToggleRecord,
  onExpandRecord,
  expandLabel,
}) => {
  const { t } = useTranslation('field')
  const hasMultiColumn = displayColumns.length > 0
  const untitledLabel = t('fieldSettingPanel.linkEditor.unnamedRecord', {
    defaultValue: UNNAMED_RECORD_DISPLAY_NAME,
  })
  const titleLabel = formatLinkRecordLabel(record.id, record.title, untitledLabel)
  const handleToggle = useCallback(() => {
    onToggleRecord(record)
  }, [onToggleRecord, record])
  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      onExpandRecord(e, record)
    },
    [onExpandRecord, record],
  )

  return (
    <div
      role="row"
      className={cn(
        'group flex h-9 cursor-pointer items-center border-b border-border/60 px-2 transition-colors',
        isHighlighted || isExpanded ? 'bg-accent/80' : 'hover:bg-muted/50',
        isSelected && 'bg-primary/5',
      )}
      onClick={handleToggle}
    >
      <div className="flex w-8 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onCheckedChange={handleToggle}
          className="rounded-full"
        />
      </div>
      <button
        type="button"
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground',
          isExpanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onClick={handleExpandClick}
        title={expandLabel}
      >
        <Maximize2 className="h-3 w-3" />
      </button>
      {hasMultiColumn ? (
        displayColumns.map((col, idx) => {
          // 多列只渲染本列 fields[id]；勿 || record.title（lookup 标题会串进空首列）
          const text = resolveLinkGridCellText(renderCellValue(record.fields?.[col.id]))
          return (
            <div
              key={col.id}
              className={cn(
                'min-w-0 px-2 text-body',
                idx === 0 ? 'flex-[1.4] font-medium' : 'flex-1 text-muted-foreground',
              )}
            >
              <TruncatedCellText text={text} />
            </div>
          )
        })
      ) : (
        <div className="min-w-0 flex-1 px-2 text-body">
          <TruncatedCellText text={titleLabel} />
        </div>
      )}
    </div>
  )
})
GridRow.displayName = 'GridRow'

export function sliceDisplayColumns(
  fields: LinkPickerField[],
  visibleFieldIds?: string[],
  max = MAX_DISPLAY_COLUMNS,
): LinkPickerField[] {
  if (fields.length === 0) return []
  if (visibleFieldIds && visibleFieldIds.length > 0) {
    const byId = new Map(fields.map((f) => [f.id, f]))
    const ordered = visibleFieldIds
      .map((id) => byId.get(id))
      .filter((f): f is LinkPickerField => Boolean(f))
    // 用户显式勾选的「编辑器显示字段」全量展示，不再套默认 5 列上限
    if (ordered.length > 0) return ordered
  }
  const primary = fields.find((f) => f.is_primary)
  const rest = fields.filter((f) => !f.is_primary)
  return (primary ? [primary, ...rest] : [...fields]).slice(0, max)
}

export const LinkRecordPicker: React.FC<LinkRecordPickerProps> = ({
  open,
  onClose,
  isSingleSelect,
  foreignTableName,
  selected,
  candidates,
  displayColumns,
  searchFields,
  isLoading,
  hasMore,
  searchText,
  onSearchTextChange,
  listMode,
  onListModeChange,
  searchFieldId,
  onSearchFieldIdChange,
  onToggleRecord,
  onRemoveRecord,
  onLoadMore,
  onGoToForeignTable,
  onCreateRecord,
  createForm,
  previewRecord,
  onPreviewRecordChange,
  onOpenFullRecord,
  loadError,
  onRetry,
  className,
}) => {
  const { t } = useTranslation('field')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  // DialogContent 会 portal 进同一 OverlayContainer；有容器即按 TabData 面板宽铺满
  const overlayContainer = useOverlayContainer()
  const dialogSizeClass = resolveLinkPickerDialogSizeClass(Boolean(overlayContainer))

  const expandLabel = t('fieldSettingPanel.linkEditor.expandRecord', {
    defaultValue: '预览记录',
  })
  const searchPlaceholder = t('fieldSettingPanel.linkEditor.searchPlaceholder', {
    defaultValue: '搜索记录',
  })
  const rows = candidates
  // 搜索范围下拉：只展示有名称的表头列（与 displayColumns 对齐；过滤空名噪声）
  const fieldOptions = (searchFields && searchFields.length > 0 ? searchFields : displayColumns)
    .filter((field) => Boolean(field.id && field.name?.trim()))
  const selectedCount = selected.size

  useEffect(() => {
    if (open) {
      setHighlightIndex(-1)
      setTimeout(() => searchInputRef.current?.focus(), 80)
    }
  }, [open])

  useEffect(() => {
    setHighlightIndex(-1)
  }, [listMode, searchText, searchFieldId])

  useEffect(() => {
    const sentinel = loadMoreSentinelRef.current
    if (!sentinel || !hasMore || isLoading) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
      },
      { rootMargin: '120px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, isLoading, onLoadMore, rows.length])

  const handleExpand = useCallback(
    (e: React.MouseEvent, record: LinkPickerRecord) => {
      e.stopPropagation()
      onPreviewRecordChange?.(previewRecord?.id === record.id ? null : record)
    },
    [onPreviewRecordChange, previewRecord?.id],
  )

  const handleRowToggle = useCallback(
    (record: LinkPickerRecord) => {
      if (selected.has(record.id)) {
        onRemoveRecord(record.id)
      } else {
        onToggleRecord(record)
      }
    },
    [selected, onRemoveRecord, onToggleRecord],
  )

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const maxIndex = rows.length - 1
      if (maxIndex < 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIndex((prev) => (prev < maxIndex ? prev + 1 : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIndex((prev) => (prev > 0 ? prev - 1 : maxIndex))
      } else if (e.key === 'Enter' && highlightIndex >= 0 && highlightIndex <= maxIndex) {
        e.preventDefault()
        const record = rows[highlightIndex]
        if (record) handleRowToggle(record)
      }
    },
    [rows, highlightIndex, handleRowToggle],
  )

  const emptyMessage =
    listMode === 'selected'
      ? t('fieldSettingPanel.linkEditor.noSelectedRecords', {
          defaultValue: '尚未选择任何记录',
        })
      : t('fieldSettingPanel.linkEditor.noResults', {
          defaultValue: '没有匹配的记录',
        })

  return (
    <TooltipProvider>
    {/*
      modal=false：Radix 默认 modal 会把 dialog 外整页标 inert / 禁交互，
      壳层比例拖拽条即使用 !pointer-events-none 遮罩也点不到。
      关闭仍靠 onOpenChange；outside 由下方 preventDefault 拦住误关。
    */}
    <Dialog open={open} modal={false} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        data-shell-overlay-allows-resize
        className={cn(
          // 遮罩穿透后，内容区必须自己接事件，否则标题/列表会点不中
          'pointer-events-auto flex flex-col gap-0 overflow-hidden p-0',
          dialogSizeClass,
          className,
        )}
        overlayClassName={LINK_PICKER_OVERLAY_PASS_THROUGH_CLASS}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {/* Header */}
            <DialogHeader className="shrink-0 space-y-0 border-b px-4 py-3">
              <div className="flex items-center gap-2 pr-6">
                <DialogTitle className="text-subtitle font-semibold">
                  {t('fieldSettingPanel.linkEditor.selectTitle', {
                    defaultValue: '选择要关联的记录',
                  })}
                </DialogTitle>
                {foreignTableName && (
                  <button
                    type="button"
                    className="inline-flex max-w-[280px] items-center gap-1 truncate text-body text-muted-foreground hover:text-foreground"
                    onClick={onGoToForeignTable}
                    disabled={!onGoToForeignTable}
                  >
                    <span className="truncate">
                      {t('fieldSettingPanel.linkEditor.jumpToTable', {
                        defaultValue: '跳转至 {{name}}',
                        name: foreignTableName,
                      })}
                    </span>
                    {onGoToForeignTable && <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                )}
              </div>
            </DialogHeader>

            {/* Toolbar: search scope + search + all/selected */}
            <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
              {fieldOptions.length > 0 && (
                <Select
                  value={searchFieldId || SEARCH_GLOBAL_VALUE}
                  onValueChange={(v) =>
                    onSearchFieldIdChange(v === SEARCH_GLOBAL_VALUE ? '' : v)
                  }
                >
                  <SelectTrigger className="h-8 w-[110px] shrink-0 text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SEARCH_GLOBAL_VALUE}>
                      {t('fieldSettingPanel.linkEditor.searchGlobal', {
                        defaultValue: '全局',
                      })}
                    </SelectItem>
                    {fieldOptions.map((field) => (
                      <SelectItem key={field.id} value={field.id}>
                        {field.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <DebouncedLinkSearchInput
                ref={searchInputRef}
                committedValue={searchText}
                onCommit={onSearchTextChange}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder}
              />
              <div className="flex shrink-0 items-center rounded-md border p-0.5">
                <button
                  type="button"
                  className={cn(
                    'h-7 rounded-sm px-2.5 text-body transition-colors',
                    listMode === 'all'
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => onListModeChange('all')}
                >
                  {t('fieldSettingPanel.linkEditor.all', { defaultValue: '全部' })}
                </button>
                <button
                  type="button"
                  className={cn(
                    'h-7 rounded-sm px-2.5 text-body transition-colors',
                    listMode === 'selected'
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => onListModeChange('selected')}
                >
                  {t('fieldSettingPanel.linkEditor.selected', { defaultValue: '已选中' })}
                  {selectedCount > 0 ? ` ${selectedCount}` : ''}
                </button>
              </div>
            </div>

            {isSingleSelect && (
              <div className="shrink-0 border-b px-4 py-1.5 text-caption text-muted-foreground">
                {t('fieldSettingPanel.linkEditor.singleSelectHint', {
                  defaultValue: '该关联类型最多选择 1 条记录',
                })}
              </div>
            )}

            {/* Grid：列表超长在弹窗内纵向滚动（ScrollArea），不撑破 Dialog */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {displayColumns.length > 0 && (
                <div className="flex h-9 shrink-0 items-center border-b bg-muted/30 px-2">
                  <div className="w-8 shrink-0" />
                  <div className="w-6 shrink-0" />
                  {displayColumns.map((col, idx) => (
                    <div
                      key={col.id}
                      className={cn(
                        'flex min-w-0 items-center gap-1.5 truncate px-2 text-caption font-medium text-muted-foreground',
                        idx === 0 ? 'flex-[1.4]' : 'flex-1',
                      )}
                    >
                      <FieldTypeIcon type={col.field_type} size={12} className="shrink-0 opacity-70" />
                      <span className="truncate">{col.name}</span>
                    </div>
                  ))}
                </div>
              )}

              {loadError ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-body text-muted-foreground">
                  <span>{loadError}</span>
                  {onRetry && (
                    <Button variant="outline" size="sm" onClick={onRetry}>
                      {t('fieldSettingPanel.linkEditor.retry', { defaultValue: '重试' })}
                    </Button>
                  )}
                </div>
              ) : isLoading && rows.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <LoadingSpinner size="sm" />
                </div>
              ) : rows.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
                  {emptyMessage}
                </div>
              ) : (
                <ScrollArea className="min-h-0 min-w-0 flex-1">
                  <div role="table" className="min-w-0">
                    {rows.map((record, index) => (
                      <GridRow
                        key={record.id}
                        record={record}
                        isSelected={selected.has(record.id)}
                        isHighlighted={index === highlightIndex}
                        isExpanded={previewRecord?.id === record.id}
                        displayColumns={displayColumns}
                        onToggleRecord={handleRowToggle}
                        onExpandRecord={handleExpand}
                        expandLabel={expandLabel}
                      />
                    ))}
                    <div ref={loadMoreSentinelRef} className="h-1" />
                    {isLoading && rows.length > 0 && (
                      <div className="flex items-center justify-center p-2">
                        <LoadingSpinner size="sm" />
                      </div>
                    )}
                  </div>
                </ScrollArea>
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 flex-col border-t">
              {createForm}
              {onCreateRecord && !createForm && (
                <div className="px-2 py-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 text-body text-muted-foreground hover:text-foreground"
                    onClick={onCreateRecord}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('fieldSettingPanel.linkEditor.addRecord', {
                      defaultValue: '添加记录',
                    })}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {previewRecord && (
            <RecordPreviewPanel
              record={previewRecord}
              fields={displayColumns}
              onClose={() => onPreviewRecordChange?.(null)}
              onOpenFull={
                onOpenFullRecord ? () => onOpenFullRecord(previewRecord) : undefined
              }
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  )
}
