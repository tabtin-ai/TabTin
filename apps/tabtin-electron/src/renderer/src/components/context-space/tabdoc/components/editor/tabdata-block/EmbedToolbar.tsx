import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useTableStore } from '@stores/useTableStore'
import { useViewStore } from '@stores/useViewStore'
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from '@tabtin/smartsheet-ui'
import { Filter, ArrowUpDown, Layers } from 'lucide-react'
import {
  ViewFilterPanel,
  ViewGroupPanel,
  ViewSortRulesEditor,
  buildSortPanelTexts,
} from '@tabtin/table-ui'
import { useTranslation } from 'react-i18next'
import type { ViewSortEditorRule } from '@tabtin/table-ui'

export const EmbedToolbar: React.FC = () => {
  const { t } = useTranslation(['view', 'table', 'common'])
  const fields = useTableStore(state => state.fields)
  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const updateView = useViewStore(state => state.updateView)
  const initializeDraft = useViewStore(state => state.initializeDraft)
  const setDraftFilters = useViewStore(state => state.setDraftFilters)
  const setDraftFilterLogic = useViewStore(state => state.setDraftFilterLogic)
  const setDraftGroups = useViewStore(state => state.setDraftGroups)
  const applyDraft = useViewStore(state => state.applyDraft)
  const draft = useViewStore(state => (currentViewId ? state.draftStates[currentViewId] : undefined))

  const filterStoreSlice = useMemo(
    () => ({ initializeDraft, setDraftFilters, setDraftFilterLogic, applyDraft }),
    [initializeDraft, setDraftFilters, setDraftFilterLogic, applyDraft],
  )
  const groupStoreSlice = useMemo(
    () => ({ initializeDraft, setDraftGroups, applyDraft }),
    [initializeDraft, setDraftGroups, applyDraft],
  )

  const currentView = useMemo(
    () => views.find(v => v.id === currentViewId) ?? null,
    [views, currentViewId],
  )

  const [filterOpen, setFilterOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [sortRules, setSortRules] = useState<ViewSortEditorRule[]>([])
  const sortRulesRef = useRef(sortRules)
  sortRulesRef.current = sortRules

  const prevViewIdRef = useRef(currentViewId)
  useEffect(() => {
    if (prevViewIdRef.current !== currentViewId) {
      prevViewIdRef.current = currentViewId
      setSortOpen(false)
      setFilterOpen(false)
      setGroupOpen(false)
    }
  }, [currentViewId])

  const hasActiveFilters = (draft?.filters ?? []).length > 0
  const hasActiveSorts = (currentView?.sorts ?? []).length > 0
  const hasActiveGroups = (draft?.groups ?? []).length > 0

  const sortEditorFields = useMemo(
    () => fields.map(f => ({ id: f.id, name: f.name, fieldType: String(f.field_type) })),
    [fields],
  )

  const handleSortOpen = useCallback((open: boolean) => {
    if (open && currentView) {
      const existingSorts = (currentView.sorts ?? [])
        .filter((r): r is { field_id: string; direction: 'asc' | 'desc' } => Boolean(r?.field_id))
        .map(r => ({ fieldId: r.field_id, direction: r.direction }))
      if (existingSorts.length === 0 && sortEditorFields.length > 0) {
        setSortRules([{ fieldId: sortEditorFields[0].id, direction: 'asc' as const }])
      } else {
        setSortRules(existingSorts)
      }
    }
    setSortOpen(open)
  }, [currentView, sortEditorFields])

  const handleAddRule = useCallback(() => {
    if (sortEditorFields.length === 0) return
    setSortRules(prev => [...prev, { fieldId: sortEditorFields[0].id, direction: 'asc' as const }])
  }, [sortEditorFields])

  const handleRemoveRule = useCallback((index: number) => {
    setSortRules(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleUpdateRule = useCallback(
    (index: number, patch: Partial<Pick<ViewSortEditorRule, 'fieldId' | 'direction'>>) => {
      setSortRules(prev =>
        prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
      )
    },
    [],
  )

  const handleMoveRule = useCallback((fromIndex: number, toIndex: number) => {
    setSortRules(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])
  const sortTexts = useMemo(
    () =>
      buildSortPanelTexts((key: string, opts?: Record<string, unknown>) => String(t(key, opts))),
    [t],
  )

  const handleSortApply = useCallback(async () => {
    if (!currentViewId) return
    const cleaned = sortRules
      .filter(r => Boolean(r.fieldId))
      .map(r => ({ field_id: r.fieldId, direction: r.direction }))
    try {
      await updateView(currentViewId, { sorts: cleaned })
      setSortOpen(false)
    } catch {
      toast({ title: t('view:sort.applyFailed', { defaultValue: '应用排序失败' }), variant: 'destructive' })
    }
  }, [currentViewId, sortRules, updateView, t])

  const handleSortClear = useCallback(async () => {
    if (!currentViewId) return
    const prev = sortRulesRef.current
    setSortRules([])
    try {
      await updateView(currentViewId, { sorts: [] })
      setSortOpen(false)
    } catch {
      setSortRules(prev)
      toast({ title: t('view:sort.clearFailed', { defaultValue: '清除排序失败' }), variant: 'destructive' })
    }
  }, [currentViewId, updateView, t])

  if (!currentViewId) return null

  return (
    <div className="flex items-center gap-1 border-b bg-muted/20 px-3 py-1">
      {/* Filter */}
      <ViewFilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        viewId={currentViewId}
        fields={fields}
        store={filterStoreSlice}
        draft={draft}
        translate={t}
      >
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 gap-1 px-2 text-body ${hasActiveFilters ? 'text-primary' : ''}`}
        >
          <Filter className="size-3" />
          {t('view:filter.title', { defaultValue: '筛选' })}
        </Button>
      </ViewFilterPanel>

      {/* Sort */}
      <Popover open={sortOpen} onOpenChange={handleSortOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 gap-1 px-2 text-body ${hasActiveSorts ? 'text-primary' : ''}`}
          >
            <ArrowUpDown className="size-3" />
            {t('view:sort.title', { defaultValue: '排序' })}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[380px] p-3">
          <ViewSortRulesEditor
            fields={sortEditorFields}
            rules={sortRules}
            onAddRule={handleAddRule}
            onRemoveRule={handleRemoveRule}
            onUpdateRule={handleUpdateRule}
            onMoveRule={handleMoveRule}
            texts={sortTexts}
          />
          <div className="mt-2 flex justify-end gap-2">
            {sortRules.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 text-body" onClick={handleSortClear}>
                {t('common:clear', { defaultValue: '清除' })}
              </Button>
            )}
            <Button size="sm" className="h-7 text-body" onClick={() => void handleSortApply()}>
              {t('common:apply', { defaultValue: '应用' })}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Group */}
      <ViewGroupPanel
        open={groupOpen}
        onOpenChange={setGroupOpen}
        viewId={currentViewId}
        fields={fields}
        views={views}
        store={groupStoreSlice}
        draft={draft}
        translate={t}
      >
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 gap-1 px-2 text-body ${hasActiveGroups ? 'text-primary' : ''}`}
        >
          <Layers className="size-3" />
          {t('view:group.title', { defaultValue: '分组' })}
        </Button>
      </ViewGroupPanel>
    </div>
  )
}

EmbedToolbar.displayName = 'EmbedToolbar'
