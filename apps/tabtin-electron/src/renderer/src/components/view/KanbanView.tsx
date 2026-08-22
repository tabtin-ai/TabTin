import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Button,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  ScrollBar,
  cn,
  toast,
} from '@tabtin/smartsheet-ui'
import { Layers, Plus, ChevronDown, Minimize2, RefreshCw, Image as ImageIcon } from 'lucide-react'
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  useSensors,
  useSensor,
  MouseSensor,
  TouchSensor,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { RecordFormContainer } from '@components/record/RecordFormContainer'
import { CollabStatus } from '@tabtin/collab-core'
import { shouldProjectViewRecordsFromCollabYdoc, useTableCollab } from '@components/table/TableCollabContext'
import { getKanbanOffsetKey, KANBAN_DEFAULT_PER_GROUP_LIMIT } from '@tabtin/table-engine/collab'
import { RecordApiService } from '@tabtin/table-core'
import {
  extractViewCoverUrl,
  isAttachmentFieldType,
} from '@tabtin/table-ui'
import { useTranslation } from 'react-i18next'
import { formatNumber } from '@/utils/i18n/format'
import { CellValueRenderer, ViewPaginationBar } from './ViewShared'
import { useKanbanViewController } from './controller/useKanbanViewController'
import { commitKanbanInitialConfig } from './controller/commitKanbanInitialConfig'
import { RecordCommentCountBadge } from './RecordCommentCountBadge'
import { useTableMemberDisplayNames } from '@components/table/hooks/useTableMemberDisplayNames'

// ---------------------------------------------------------------------------
// KanbanView — Droppable / Draggable primitives
// ---------------------------------------------------------------------------

/** 拖拽 payload 类型定义 */
interface KanbanDragData {
  recordId: string
  groupValue: string | null
  record: Record<string, unknown>
}

/** 看板列的 droppable 容器，拖入时高亮边框 */
const KanbanDroppableColumn: React.FC<{
  droppableId: string
  groupValue: string | null
  children: React.ReactNode
}> = ({ droppableId, groupValue, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
    data: { groupValue },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full w-[264px] shrink-0 flex-col overflow-hidden rounded-md border bg-muted transition-colors duration-200',
        isOver && 'border-primary/40 ring-2 ring-primary/20',
      )}
    >
      {children}
    </div>
  )
}

/** 可拖拽的看板卡片 */
const KanbanDraggableCard: React.FC<{
  recordId: string
  groupValue: string | null
  record: Record<string, unknown>
  disabled?: boolean
  children: React.ReactNode
}> = ({ recordId, groupValue, record, disabled = false, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `kanban-card-${recordId}`,
    data: { recordId, groupValue, record } satisfies KanbanDragData,
    disabled,
  })

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'w-full px-3 pb-2',
        disabled ? 'cursor-default' : 'cursor-grab',
        isDragging && 'cursor-grabbing opacity-40',
      )}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// KanbanView
// ---------------------------------------------------------------------------

const KanbanView: React.FC<{ embedded?: boolean; isReadonly?: boolean }> = ({ embedded, isReadonly = false }) => {
  const { t } = useTranslation('view')
  const { isCollabRuntime, collabBridge, updateRecordFields, updateViewForRuntime, effectiveCurrentView } = useTableCollab()
  const isTruncated = collabBridge.collab.isTruncated
  const isCollabProjectionReady =
    isCollabRuntime && collabBridge.collab.status === CollabStatus.SYNCED
  const viewStoreApi = useViewStoreApi()
  const currentViewRecords = useViewStore(s => s.currentViewRecords)
  const recordsQuery = useViewStore(s => s.recordsQuery)
  const views = useViewStore(s => s.views)
  const currentViewId = useViewStore(s => s.currentViewId)
  const fields = useTableStore(s => s.fields)
  const selectedTable = useTableStore(s => s.selectedTable)
  const { userDisplayNameById } = useTableMemberDisplayNames()

  // 协作在线时 `updateViewForRuntime` 只写 Y.Doc viewsMeta，store views 要等服务端回流
  // REST 才更新。这里用 context 暴露的 Y.Doc 派生视图替换当前视图，让配置卡 needsConfig
  // 与分组口径与 grid 一致、即时刷新（ 回归修复）。
  const effectiveViews = useMemo(() => {
    if (!effectiveCurrentView || !currentViewId) return views
    return views.map(v => (v.id === currentViewId ? effectiveCurrentView : v))
  }, [views, effectiveCurrentView, currentViewId])

  const {
    kanbanConfig, groups, fieldIdToFieldMap, fieldIdToNameMap,
    getRecordFieldValue,
    getRecordTitle, cardCoverFieldName, visibleFieldIds,
    selectedRecord, dialogMode, isRecordDialogOpen, createDefaults,
    handleCardClick, handleCreateCard, handleDialogOpenChange,
  } = useKanbanViewController({
    views: effectiveViews, currentViewId, currentViewRecords, fields,
    selectedTableId: selectedTable?.id ?? null,
    userDisplayNameById,
    t: (key, opts) => String(t(key as any, opts as any)),
  })

  const setViewPage = useViewStore(s => s.setPage)
  const isRecordsLoading = useViewStore(s => s.isRecordsLoading)
  const currentView = effectiveViews.find(v => v.id === currentViewId)
  const needsConfig = !kanbanConfig.groupByField

  const currentPage = Math.max(1, currentViewRecords?.page ?? recordsQuery.page ?? 1)
  const pageSize = Math.max(1, currentViewRecords?.page_size ?? recordsQuery.page_size ?? 100)
  const totalCount = Math.max(0, currentViewRecords?.total ?? 0)
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))

  const [configSelectedFieldId, setConfigSelectedFieldId] = useState<string | undefined>()
  const [isDismissed, setIsDismissed] = useState(false)
  const [isSavingConfig, setIsSavingConfig] = useState(false)
  const [collapsedStacks, setCollapsedStacks] = useState<Set<string>>(new Set())
  const [coverImageErrors, setCoverImageErrors] = useState<Set<string>>(new Set())

  const hasCoverField = Boolean(kanbanConfig.cardCoverField || cardCoverFieldName)
  const handleCoverImageError = useCallback((recordId: string) => {
    setCoverImageErrors(prev => {
      if (prev.has(recordId)) return prev
      return new Set(prev).add(recordId)
    })
  }, [])

  useEffect(() => {
    setIsDismissed(false)
    setConfigSelectedFieldId(undefined)
    setCoverImageErrors(new Set())
  }, [currentViewId])

  useEffect(() => {
    setCoverImageErrors(new Set())
  }, [currentViewRecords])

  const configurableFields = fields.filter(f => !isAttachmentFieldType(f.field_type))

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedStacks(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  // ---- 跨列拖拽 ----
  const refreshCurrentView = useViewStore(s => s.refreshCurrentView)
  const [activeDragRecord, setActiveDragRecord] = useState<Record<string, unknown> | null>(null)
  const [optimisticMoves, setOptimisticMoves] = useState<Map<string, string | null>>(new Map())

  const dndSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  )

  // ---- 组内加载更多 ----
  const loadMoreCurrentViewGroupRecords = useViewStore(s => s.loadMoreCurrentViewGroupRecords)
  const [loadingGroups, setLoadingGroups] = useState<Set<string | null>>(new Set())

  const loadMoreForGroup = useCallback(async (group: { value: string | null; count: number; offset: number; records?: any[]; isFallback?: boolean; per_group_limit?: number }) => {
    if (!currentViewId) return
    const groupKey = group.value
    setLoadingGroups(prev => new Set(prev).add(groupKey))
    try {
      if (shouldProjectViewRecordsFromCollabYdoc(isCollabRuntime, isTruncated, isCollabProjectionReady)) {
        const perGroupLimit =
          typeof group.per_group_limit === 'number' && group.per_group_limit > 0
            ? group.per_group_limit
            : typeof recordsQuery.per_group_limit === 'number' && recordsQuery.per_group_limit > 0
              ? recordsQuery.per_group_limit
              : KANBAN_DEFAULT_PER_GROUP_LIMIT
        const offsetKey = getKanbanOffsetKey(groupKey)
        const currentOffset =
          typeof group.offset === 'number' && group.offset >= 0
            ? group.offset
            : recordsQuery.group_offsets?.[offsetKey] ?? 0
        viewStoreApi.setState(state => ({
          recordsQuery: {
            ...state.recordsQuery,
            per_group_limit: perGroupLimit,
            group_offsets: {
              ...state.recordsQuery.group_offsets,
              [offsetKey]: currentOffset + perGroupLimit,
            },
          },
        }))
        return
      }
      await loadMoreCurrentViewGroupRecords(groupKey)
    } catch (err) {
      console.error('[KanbanView] loadMore failed', groupKey, err)
    } finally {
      setLoadingGroups(prev => { const n = new Set(prev); n.delete(groupKey); return n })
    }
  }, [
    currentViewId,
    isCollabProjectionReady,
    isCollabRuntime,
    isTruncated,
    loadMoreCurrentViewGroupRecords,
    recordsQuery.group_offsets,
    recordsQuery.per_group_limit,
    viewStoreApi,
  ])

  const displayGroups = useMemo(() => {
    const merged = groups
    if (optimisticMoves.size === 0) return merged
    const cloned = merged.map(g => ({ ...g, records: [...g.records], count: g.count }))
    const byValue = new Map(cloned.map(g => [g.value, g]))
    optimisticMoves.forEach((targetValue, recordId) => {
      for (const g of cloned) {
        const idx = g.records.findIndex((r: any) => (r.id ?? r._id ?? r.__id) === recordId)
        if (idx > -1) {
          const [moved] = g.records.splice(idx, 1)
          g.count = g.records.length
          const target = byValue.get(targetValue)
          if (target) { target.records.push(moved); target.count = target.records.length }
          break
        }
      }
    })
    return cloned
  }, [groups, optimisticMoves])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as KanbanDragData | undefined
    setActiveDragRecord(data?.record ?? null)
  }, [])

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDragRecord(null)
      if (isReadonly) return
      const { active, over } = event
      if (!over) return

      const dragData = active.data.current as KanbanDragData | undefined
      const sourceGroupValue = dragData?.groupValue
      const recordId = dragData?.recordId
      const targetGroupValue = (over.data.current as { groupValue?: string | null } | undefined)?.groupValue

      if (!recordId || targetGroupValue === undefined || targetGroupValue === sourceGroupValue) return

      const groupFieldId = kanbanConfig.groupByField
      if (!groupFieldId) return
      const groupFieldName = fieldIdToNameMap.get(groupFieldId)
      if (!groupFieldName) return
      const groupField = fieldIdToFieldMap.get(groupFieldId)

      const targetGroup = displayGroups.find(g => g.value === targetGroupValue)
      const targetRawValue = targetGroup?.isFallback ? null : (targetGroup?.rawValue ?? null)

      let newValue: unknown
      if (groupField?.field_type === 'multi_select') {
        const cur = getRecordFieldValue(dragData?.record, groupFieldId)
        const arr = Array.isArray(cur) ? [...cur] : []
        const srcGroup = displayGroups.find(g => g.value === sourceGroupValue)
        if (srcGroup && !srcGroup.isFallback && srcGroup.rawValue !== undefined) {
          const si = arr.findIndex(v => String(v) === String(srcGroup.rawValue))
          if (si > -1) arr.splice(si, 1)
        }
        if (targetRawValue != null && !arr.some(v => String(v) === String(targetRawValue))) {
          arr.push(targetRawValue)
        }
        newValue = arr.length > 0 ? arr : null
      } else {
        newValue = targetRawValue
      }

      setOptimisticMoves(prev => new Map(prev).set(recordId, targetGroupValue))

      try {
        if (isCollabRuntime) {
          // 协作在线：写 Y.Doc（乐观合并进 view store，他端实时可见），不再 REST + 刷新。
          await updateRecordFields(recordId, { [groupFieldName]: newValue })
        } else {
          await RecordApiService.updateRecord(recordId, { fields: { [groupFieldName]: newValue } })
          await refreshCurrentView().catch(() => {})
        }
      } catch (err) {
        console.error('[KanbanView] 拖拽更新记录失败', recordId, err)
      } finally {
        setOptimisticMoves(prev => { const n = new Map(prev); n.delete(recordId); return n })
      }
    },
    [isReadonly, kanbanConfig.groupByField, fieldIdToNameMap, fieldIdToFieldMap, displayGroups, getRecordFieldValue, refreshCurrentView, isCollabRuntime, updateRecordFields],
  )

  const handleConfigConfirm = async () => {
    if (isReadonly) return
    if (!configSelectedFieldId || !currentViewId) return
    setIsSavingConfig(true)
    try {
      const cfg = (currentView?.config ?? {}) as Record<string, unknown>
      // ：协作在线写 Y.Doc viewsMeta（与 grid 一致），否则 REST。
      await commitKanbanInitialConfig({
        viewId: currentViewId,
        groupFieldId: configSelectedFieldId,
        currentConfig: cfg,
        fields,
        updateView: updateViewForRuntime,
      })
      setIsDismissed(true)
    } catch (error) {
      console.error('[KanbanView] initial configuration save failed', {
        viewId: currentViewId,
        error,
      })
      toast({
        title: t('switcher.saveFailedTitle'),
        description: t('switcher.saveFailedDesc'),
        variant: 'destructive',
      })
    } finally {
      setIsSavingConfig(false)
    }
  }

  // ---- Config prompt (unconfigured kanban) ----
  if (needsConfig && !isDismissed) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-8">
        <div className="w-full max-w-sm rounded-xl border border-border/60 bg-card p-6 shadow-lg">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
              <Layers className="size-5 text-primary" />
            </div>
            <div>
              <h3 className="text-body font-semibold">{t('kanban.configPrompt.title')}</h3>
              <p className="text-body text-muted-foreground">{t('kanban.configPrompt.description')}</p>
            </div>
          </div>
          <div className="rounded-lg border border-border/40 bg-muted/30">
            <ScrollArea className="h-52">
              <RadioGroup className="gap-0 p-1" value={configSelectedFieldId} onValueChange={setConfigSelectedFieldId}>
                {configurableFields.map(f => (
                  <label
                    key={f.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-body transition-colors',
                      configSelectedFieldId === f.id ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent/10'
                    )}
                  >
                    <RadioGroupItem value={f.id} id={`kcfg-${f.id}`} />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-caption uppercase text-muted-foreground/60">{f.field_type}</span>
                  </label>
                ))}
              </RadioGroup>
              <ScrollBar />
            </ScrollArea>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" disabled={isReadonly || !configSelectedFieldId || isSavingConfig} onClick={() => void handleConfigConfirm()} className="flex-1">
              {t('kanban.configPrompt.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIsDismissed(true)}>
              {t('kanban.configPrompt.later')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // ---- Main kanban board ----
  return (
    <>
      <DndContext sensors={dndSensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full">
        <ScrollArea className="size-full" scrollBar="horizontal"><div className="flex h-full w-max p-2">
          {displayGroups.map((group, index) => {
            const recs = group.records ?? []
            const sid = group.id ?? `${group.value}-${index}`
            const collapsed = collapsedStacks.has(sid)

            if (collapsed) {
              return (
                <div key={sid} className="h-full pr-4">
                  <div
                    className="h-full w-14 cursor-pointer rounded-md border bg-muted hover:bg-muted/80"
                    onClick={() => toggleCollapsed(sid)}
                  >
                    <div
                      className="flex h-14 w-64 origin-top-left items-center space-x-2 overflow-hidden px-4 text-muted-foreground"
                      style={{ transform: 'rotate(-90deg) translateX(-100%)' }}
                    >
                      <span className="truncate text-body font-semibold">{group.label}</span>
                      <span className="shrink-0 rounded-xl border px-2 text-body">{group.count}</span>
                    </div>
                  </div>
                </div>
              )
            }

            // ---- Expanded stack ----
            return (
              <div key={sid} className="h-full pr-4">
                <KanbanDroppableColumn droppableId={`kanban-col-${sid}`} groupValue={group.value}>
                  {/* Stack header */}
                  <div className="flex h-12 w-full shrink-0 items-center justify-between border-b bg-card px-4">
                    <div className="flex items-center space-x-2 overflow-hidden text-muted-foreground">
                      <span className="min-w-0 truncate text-body font-semibold">{group.label}</span>
                      <span className="shrink-0 rounded-xl border px-2 text-body">{group.count}</span>
                    </div>
                    <button
                      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      onClick={() => toggleCollapsed(sid)}
                    >
                      <Minimize2 className="size-4" />
                    </button>
                  </div>

                  <ScrollArea className="size-full flex-1"><div className="pt-3">
                    {recs.length === 0 ? (
                      <div className="flex size-full items-center justify-center text-body text-muted-foreground">
                        {t('kanban.emptyCards')}
                      </div>
                    ) : (
                      recs.map((record: any, ci: number) => {
                        const rid = String(record.id ?? record._id ?? record.__id ?? `${sid}-${ci}`)
                        const title = getRecordTitle(record)
                        const coverUrl = extractViewCoverUrl(
                          getRecordFieldValue(record, cardCoverFieldName ?? kanbanConfig.cardCoverField),
                        )
                        const coverBroken = coverImageErrors.has(rid)
                        const showCoverImg = Boolean(coverUrl) && !coverBroken

                        return (
                          <KanbanDraggableCard key={rid} recordId={rid} groupValue={group.value} record={record} disabled={isReadonly}>
                            <div
                              onClick={() => handleCardClick(record)}
                              className="relative flex w-full cursor-pointer flex-col space-y-2 overflow-hidden rounded-md border border-border bg-card p-3 hover:border-primary/15"
                            >
                              {/* Cover：配置了封面字段时始终占位；加载失败 / 非图片无 URL → ImageIcon，避免裂图 */}
                              {hasCoverField && (
                                showCoverImg ? (
                                  <div className="-mx-3 -mt-3 mb-1 overflow-hidden border-b" style={{ height: 160 }}>
                                    <img
                                      src={coverUrl!}
                                      alt=""
                                      className="size-full object-cover"
                                      onError={() => handleCoverImageError(rid)}
                                    />
                                  </div>
                                ) : (
                                  <div
                                    className="-mx-3 -mt-3 mb-1 flex items-center justify-center overflow-hidden border-b bg-muted"
                                    style={{ height: 160 }}
                                  >
                                    <ImageIcon className="size-16 text-muted-foreground" />
                                  </div>
                                )
                              )}

                              <div className="min-w-0 text-subtitle font-semibold">
                                <span className="line-clamp-2 break-words">{title}</span>
                              </div>

                              {visibleFieldIds.map(fid => {
                                const field = fieldIdToFieldMap.get(fid)
                                const raw = getRecordFieldValue(record, fid)

                                if (raw === null || raw === undefined || raw === '') return null
                                if (!field) return null

                                return (
                                  <div key={fid} className="min-w-0">
                                    <div className="mb-1 flex items-center space-x-1 text-muted-foreground">
                                      <span className="truncate text-body">{field.name}</span>
                                    </div>
                                    <CellValueRenderer
                                      field={field}
                                      value={raw}
                                      userDisplayNameById={userDisplayNameById}
                                    />
                                  </div>
                                )
                              })}

                              <div className="flex justify-end">
                                <RecordCommentCountBadge recordId={rid} />
                              </div>
                            </div>
                          </KanbanDraggableCard>
                        )
                      })
                    )}
                  </div></ScrollArea>

                  {/* Load more / Add card footer */}
                  <div className="flex flex-col items-center gap-1 rounded-b-md bg-muted px-3 py-2">
                    {group.hasMore && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-body text-muted-foreground"
                        disabled={loadingGroups.has(group.value)}
                        onClick={() => void loadMoreForGroup(group)}
                      >
                        {loadingGroups.has(group.value)
                          ? <RefreshCw className="mr-1.5 size-3.5 animate-spin" />
                          : <ChevronDown className="mr-1.5 size-3.5" />}
                        {t('kanban.loadMore', { remaining: formatNumber(group.count - recs.length) })}
                      </Button>
                    )}
                    {kanbanConfig.groupByField && (
                      <Button
                        variant="outline"
                        className="w-full shadow-none"
                        disabled={isReadonly}
                        onClick={() => handleCreateCard(group)}
                      >
                        <Plus className="size-5" />
                      </Button>
                    )}
                  </div>
                </KanbanDroppableColumn>
              </div>
            )
          })}
        </div></ScrollArea>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragRecord ? (
          <div className="w-[240px] rounded-md border border-primary/20 bg-card p-3 shadow-lg">
            <div className="min-w-0 text-subtitle font-semibold">
              <span className="truncate">
                {(() => {
                  return getRecordTitle(activeDragRecord)
                })()}
              </span>
            </div>
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>

      {!embedded && (
        <ViewPaginationBar
          currentPage={currentPage} totalPages={totalPages}
          totalCount={totalCount} isLoading={isRecordsLoading}
          onPageChange={setViewPage}
        />
      )}

      <RecordFormContainer
        open={isRecordDialogOpen}
        onOpenChange={handleDialogOpenChange}
        mode={dialogMode}
        record={dialogMode === 'edit' ? selectedRecord ?? undefined : undefined}
        initialValues={dialogMode === 'create' ? createDefaults : undefined}
        isReadonly={isReadonly}
      />
    </>
  )
}

export default KanbanView
