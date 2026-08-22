/**
 * FormLinkPicker — 表单视图中的轻量 Link 记录选择器
 *
 * 使用 Dialog + 搜索 + 列表，复用 LinkFieldApiService.getLinkableRecords。
 * 设计为表单填写场景：简洁、快速，支持单选/多选。
 * 支持无限滚动分页加载。
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Check, X, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  ScrollArea,
  cn,
  LoadingSpinner,
  formatLinkRecordLabel,
} from '@tabtin/smartsheet-ui'
import { LinkFieldApiService } from '@tabtin/table-core'
import type { LinkableRecordItem } from '@tabtin/table-core'

export interface FormLinkPickerProps {
  open: boolean
  onClose: () => void
  tableId: string
  fieldId: string
  fieldName: string
  currentValue: Array<{ id: string; title?: string }>
  onSave: (value: Array<{ id: string; title?: string }>) => void
  multiple?: boolean
  /** 公开分享场景的 share_id；存在时使用表单专用端点（无需 JWT） */
  shareId?: string
  /** 密码保护表单的密码（用于 X-Form-Password header） */
  formPassword?: string
}

const SEARCH_DEBOUNCE = 300
const PAGE_SIZE = 50
const SCROLL_THRESHOLD = 80

export const FormLinkPicker: React.FC<FormLinkPickerProps> = ({
  open,
  onClose,
  tableId,
  fieldId,
  fieldName,
  currentValue,
  onSave,
  multiple = true,
  shareId,
  formPassword,
}) => {
  const { t } = useTranslation('view')

  const [search, setSearch] = useState('')
  const [records, setRecords] = useState<LinkableRecordItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Map<string, { id: string; title?: string }>>(
    () => new Map(currentValue.map((v) => [v.id, v])),
  )
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const loadingMoreRef = useRef(false)

  const hasMore = useMemo(() => {
    if (total > 0) return records.length < total
    return records.length > 0 && records.length % PAGE_SIZE === 0
  }, [records.length, total])

  const fetchRecords = useCallback(
    async (searchText: string, pageNum: number, append: boolean) => {
      if (append) {
        if (loadingMoreRef.current) return
        setLoadingMore(true)
        loadingMoreRef.current = true
      } else {
        setLoading(true)
      }
      setFetchError(null)
      try {
        const params = { search: searchText, page: pageNum, page_size: PAGE_SIZE }
        const res = shareId
          ? await LinkFieldApiService.getFormLinkRecords(shareId, fieldId, params, formPassword)
          : await LinkFieldApiService.getLinkableRecords(tableId, fieldId, params)

        if (append) {
          setRecords((prev) => [...prev, ...res.records])
        } else {
          setRecords(res.records)
        }
        setTotal(res.total ?? 0)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[FormLinkPicker] fetchRecords failed:', msg)
        if (!append) {
          setRecords([])
        }
        setFetchError(msg)
      } finally {
        setLoading(false)
        setLoadingMore(false)
        loadingMoreRef.current = false
      }
    },
    [tableId, fieldId, shareId, formPassword],
  )

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || loading || !hasMore) return
    const nextPage = page + 1
    setPage(nextPage)
    fetchRecords(search, nextPage, true)
  }, [loading, hasMore, page, search, fetchRecords])

  const loadMoreRef = useRef(loadMore)
  loadMoreRef.current = loadMore

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      if (scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD) {
        loadMoreRef.current()
      }
    }
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [open])

  useEffect(() => {
    if (!open) return
    setPage(1)
    setTotal(0)
    fetchRecords('', 1, false)
    setSelected(new Map(currentValue.map((v) => [v.id, v])))
    setSearch('')
  }, [open, fetchRecords, currentValue])

  const isInitialRef = useRef(true)
  useEffect(() => {
    if (!open) { isInitialRef.current = true; return }
    if (isInitialRef.current) { isInitialRef.current = false; return }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      setPage(1)
      setTotal(0)
      fetchRecords(search, 1, false)
    }, SEARCH_DEBOUNCE)
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [search, open, fetchRecords])

  const toggleRecord = useCallback(
    (record: LinkableRecordItem) => {
      setSelected((prev) => {
        const next = new Map(prev)
        if (next.has(record.id)) {
          next.delete(record.id)
        } else {
          if (!multiple) next.clear()
          next.set(record.id, { id: record.id, title: record.title })
        }
        return next
      })
    },
    [multiple],
  )

  const handleSave = useCallback(() => {
    onSave(Array.from(selected.values()))
    onClose()
  }, [selected, onSave, onClose])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>
            {t('form.linkPicker.title', { name: fieldName, defaultValue: `选择关联：${fieldName}` })}
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('form.linkPicker.search', '搜索记录…')}
            className="pl-9"
          />
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            {Array.from(selected.values()).map((item) => (
              <span
                key={item.id}
                className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-body text-primary"
              >
                {formatLinkRecordLabel(item.id, item.title)}
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev)
                      next.delete(item.id)
                      return next
                    })
                  }
                  className="ml-0.5 rounded-full hover:bg-primary/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <ScrollArea className="max-h-64" viewportRef={viewportRef}>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <LoadingSpinner />
            </div>
          ) : fetchError ? (
            <div className="py-8 text-center text-body text-destructive">
              {t('form.linkPicker.fetchError', '加载关联记录失败，请稍后重试')}
            </div>
          ) : records.length === 0 ? (
            <div className="py-8 text-center text-body text-muted-foreground">
              {search
                ? t('form.linkPicker.noResults', '没有找到匹配的记录')
                : t('form.linkPicker.empty', '暂无可关联的记录')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {records.map((record) => {
                const isSelected = selected.has(record.id)
                return (
                  <button
                    key={record.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-body transition-colors',
                      isSelected ? 'bg-primary/10' : 'hover:bg-accent',
                    )}
                    onClick={() => toggleRecord(record)}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </div>
                    <span className="truncate">{formatLinkRecordLabel(record.id, record.title)}</span>
                  </button>
                )
              })}

              {loadingMore && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}

              {!loadingMore && hasMore && (
                <button
                  type="button"
                  className="flex w-full items-center justify-center py-2 text-body text-muted-foreground hover:text-foreground transition-colors"
                  onClick={loadMore}
                >
                  {t('form.linkPicker.loadMore', '加载更多…')}
                </button>
              )}
            </div>
          )}
        </ScrollArea>

        {total > 0 && !loading && (
          <div className="text-caption text-muted-foreground text-right px-1">
            {t('form.linkPicker.total', {
              loaded: records.length,
              total,
              defaultValue: `已加载 ${records.length} / ${total} 条`,
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('actions.cancel', '取消')}
          </Button>
          <Button onClick={handleSave}>
            {t('actions.confirm', '确定')}
            {selected.size > 0 && ` (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
