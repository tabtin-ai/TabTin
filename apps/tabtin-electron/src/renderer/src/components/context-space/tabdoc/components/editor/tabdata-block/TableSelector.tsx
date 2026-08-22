import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Table2, Search, Plus, RefreshCw, ChevronDown } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  Input,
  Button,
  ScrollArea,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useAppHostClient } from '@tabtin/app-host-sdk'
import { useTabDocHostActions } from '@tabtin/tabdoc-ui'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'

interface TableSelectorTableSummary {
  id: string
  name: string
  description?: string
  icon?: string
  spaceId: string | null
  isArchived: boolean
}

// UI-19: 首次只加载前 PAGE_SIZE 条，点击"加载更多"扩展
const PAGE_SIZE = 20

interface TableSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (table: { id: string; name: string }) => void
  onCreateNew?: () => void
  spaceId?: string
}

export const TableSelector: React.FC<TableSelectorProps> = ({
  open,
  onOpenChange,
  onSelect,
  onCreateNew,
  spaceId,
}) => {
  const { t } = useTranslation(['tabdoc', 'table'])
  const client = useAppHostClient()
  const hostActions = useTabDocHostActions()
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [isTableListLoading, setIsTableListLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [retryTrigger, setRetryTrigger] = useState(0)
  const [tables, setTables] = useState<TableSelectorTableSummary[]>([])
  // UI-19: 分页显示数量
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const loadGenRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const gen = ++loadGenRef.current
    setIsTableListLoading(true)
    setLoadError(false)
    void hostActions
      .listTables({
        organizationId: client.getOrganizationId(),
        spaceId,
      })
      .then((nextTables) => {
        if (gen === loadGenRef.current) {
          setTables(nextTables)
        }
      })
      .catch(() => {
        if (gen === loadGenRef.current) {
          setLoadError(true)
          setTables([])
        }
      })
      .finally(() => {
        if (gen === loadGenRef.current) setIsTableListLoading(false)
      })
  }, [client, hostActions, open, retryTrigger, spaceId])

  const handleRetryLoad = useCallback(() => {
    setRetryTrigger((c) => c + 1)
  }, [])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setSearch('')
      setVisibleCount(PAGE_SIZE)
      onOpenChange(nextOpen)
    },
    [onOpenChange],
  )

  // UI-19: 搜索变化时重置分页
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [deferredSearch])

  const filteredTables = useMemo(() => {
    let list = tables.filter((tbl) => !tbl.isArchived)

    if (spaceId) {
      const inSpace = list.filter((tbl) => tbl.spaceId === spaceId)
      const outSpace = list.filter((tbl) => tbl.spaceId !== spaceId)
      list = [...inSpace, ...outSpace]
    }

    if (deferredSearch.trim()) {
      const q = deferredSearch.trim().toLowerCase()
      list = list.filter(
        (tbl) =>
          tbl.name?.toLowerCase().includes(q) ||
          tbl.description?.toLowerCase().includes(q),
      )
    }

    return list
  }, [tables, deferredSearch, spaceId])

  const handleSelect = useCallback(
    (tbl: { id: string; name: string }) => {
      onSelect(tbl)
      handleOpenChange(false)
    },
    [onSelect, handleOpenChange],
  )

  const handleCreateNew = useCallback(() => {
    onCreateNew?.()
    handleOpenChange(false)
  }, [onCreateNew, handleOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[420px] p-0 gap-0">
        <ContextDialogHeader
          className="px-4 pt-4 pb-2"
          icon={<Table2 className="h-7 w-7" />}
          title={t('tabdataBlock.selectTable', { defaultValue: '选择表格' })}
          description={t('tabdataBlock.selectTableDescription', { defaultValue: '选择要嵌入到文档里的表格' })}
        />

        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              autoFocus
              aria-label={t('tabdataBlock.searchPlaceholder', {
                defaultValue: '搜索表格...',
              })}
              placeholder={t('tabdataBlock.searchPlaceholder', {
                defaultValue: '搜索表格...',
              })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-body"
            />
          </div>
        </div>

        <ScrollArea className="max-h-[300px]">
          <div className="px-2 pb-2">
            {onCreateNew && (
              <button
                type="button"
                onClick={handleCreateNew}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-body text-primary hover:bg-accent transition-colors"
              >
                <div className="flex size-8 items-center justify-center rounded-md border border-dashed border-primary/40 bg-primary/5">
                  <Plus className="size-4 text-primary" />
                </div>
                <span className="font-medium">
                  {t('tabdataBlock.createNew', { defaultValue: '新建多维表格' })}
                </span>
              </button>
            )}

            {isTableListLoading && (
              <DetailedRowListSkeleton count={4} compact showPreview={false} />
            )}

            {!isTableListLoading && loadError && (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-body text-muted-foreground">
                <span>{t('tabdataBlock.loadTablesFailed', { defaultValue: '加载表格列表失败' })}</span>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-body" onClick={handleRetryLoad}>
                  <RefreshCw className="size-3" />
                  {t('table:pane.retry', { defaultValue: '重试' })}
                </Button>
              </div>
            )}

            {!isTableListLoading && !loadError && filteredTables.length === 0 && (
              <div className="flex items-center justify-center py-8 text-body text-muted-foreground">
                {t('tabdataBlock.noResults', { defaultValue: '未找到表格' })}
              </div>
            )}

            {/* UI-19: 分页渲染，首次只显示 PAGE_SIZE 条 */}
            {!isTableListLoading && !loadError && filteredTables.slice(0, visibleCount).map((tbl) => (
              <button
                key={tbl.id}
                type="button"
                onClick={() => handleSelect({ id: tbl.id, name: tbl.name })}
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-body hover:bg-accent transition-colors"
              >
                <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                  {tbl.icon ? (
                    <span className="text-subtitle">{tbl.icon}</span>
                  ) : (
                    <Table2 className="size-4 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <div className="truncate font-medium text-foreground">
                    {tbl.name || t('tabdataBlock.untitled', { defaultValue: '未命名表格' })}
                  </div>
                  {tbl.description && (
                    <div className="truncate text-body text-muted-foreground">
                      {tbl.description}
                    </div>
                  )}
                </div>
                {spaceId && tbl.spaceId !== spaceId && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
                    {t('tabdataBlock.otherSpace', { defaultValue: '其他空间' })}
                  </span>
                )}
              </button>
            ))}

            {/* UI-19: 加载更多按钮 */}
            {!isTableListLoading && !loadError && filteredTables.length > visibleCount && (
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-2 text-body text-muted-foreground hover:bg-accent transition-colors"
              >
                <ChevronDown className="size-3.5" />
                <span>
                  {t('tabdataBlock.loadMore', {
                    defaultValue: '加载更多（还有 {{count}} 个）',
                    count: filteredTables.length - visibleCount,
                  })}
                </span>
              </button>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

TableSelector.displayName = 'TableSelector'
