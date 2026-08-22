import React from 'react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  toast,
  cn,
} from '@tabtin/smartsheet-ui'
import {
  ArrowUpDown,
  Calendar,
  EyeOff,
  Filter,
  Layers,
  LayoutGrid,
  Palette,
  Settings2,
} from 'lucide-react'
import type { Field, ViewCreateRequest, ViewFilter, ViewGroup, ViewMeta, ViewSort, ViewUpdateRequest } from '@tabtin/table-core'
import {
  ViewSortRulesEditor,
  ViewFilterPanel,
  ViewGroupPanel,
  buildViewVisibilityUpdate,
  buildViewVisibilityColumnMetaOnlyUpdate,
  useViewFilterGroupController,
  useHideFieldsState,
  useSortEditorState,
  useTableViewUiStore,
  ToolBarButton,
  HideFieldsPopoverContent,
  SaveAsViewDialog,
  ViewDraftActions,
  handlePopoverInteractOutside,
  buildSortPanelTexts,
  getViewToolbarActions,
  isViewLocked,
  normalizeSortRulesFromView,
  resolveViewDraftSaveDisabledReason,
  VIEW_DRAFT_SAVE_DISABLED_REASON_KEYS,
  type ViewPopoverControls,
  type ViewSortRuleDraftItem,
  type ViewToolbarAction,
} from '@tabtin/table-ui'
import { useViewStore } from '@/stores/table/useViewStore'
import { useTranslation } from 'react-i18next'
import { createLooseTranslate } from '@/types/table-adapters'
import { WebViewEditorDialog } from './WebViewEditorDialog'

interface WebViewFilterGroupBarProps {
  fields: Field[]
  currentViewOverride?: ViewMeta | null
  className?: string
  controlsRef?: React.MutableRefObject<ViewPopoverControls | null>
  tableFontStyle?: string
  tableFontWeight?: string
  tableFontSize?: number
  onFontStyleChange?: (value: string) => void
  onFontWeightChange?: (value: string) => void
  onFontSizeChange?: (value: number) => void
  isPersonalViewEnabled?: boolean
  isReadonly?: boolean
  tableId?: string | null
  updateViewOverride?: (
    viewId: string,
    payload: ViewUpdateRequest,
    options?: { silent?: boolean; refreshRecords?: boolean; optimisticConfig?: Record<string, unknown> }
  ) => Promise<unknown>
  saveDraftOverride?: (viewId: string) => Promise<unknown>
  /**
   * 协作完整 Y.Doc 投影态：只更新本地排序草稿，不打 REST（避免晚到结果覆盖投影顺序）。
   */
  skipSortRecordsFetch?: boolean
}

/* ================================================================ */
/*  WebViewFilterGroupBar                                           */
/* ================================================================ */

const FONT_STYLE_VALUES = ['system', 'serif', 'mono', 'rounded'] as const
const FONT_WEIGHT_VALUES = ['thin', 'regular', 'medium', 'semibold'] as const
const FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14, 16, 18, 20, 24]

const getViewFilterLogic = (view: { config?: unknown } | null | undefined): 'and' | 'or' => {
  const config = view?.config as Record<string, unknown> | null | undefined
  return config?.filter_logic === 'or' ? 'or' : 'and'
}

const normalizeFiltersForDraftCompare = (filters: unknown): unknown[] => {
  if (!Array.isArray(filters)) return []
  return filters.map(filter => {
    if (!filter || typeof filter !== 'object') return filter
    const { id: _id, enabled, ...rest } = filter as Record<string, unknown>
    return {
      ...rest,
      enabled: enabled !== false,
    }
  })
}

const normalizeGroupsForDraftCompare = (groups: unknown): unknown[] => {
  if (!Array.isArray(groups)) return []
  return groups.map(group => {
    if (!group || typeof group !== 'object') return group
    return {
      ...(group as Record<string, unknown>),
      direction: (group as { direction?: unknown }).direction || 'asc',
    }
  })
}

const getViewGroupsForDraftCompare = (
  view: { view_type?: string; groups?: unknown; config?: unknown } | null | undefined,
) => {
  if (view?.view_type === 'kanban') {
    const config = view?.config as Record<string, unknown> | null | undefined
    const groupField = typeof config?.group_by_field === 'string' ? config.group_by_field : null
    return groupField ? [{ field_id: groupField, direction: 'asc' }] : []
  }
  const groups = view?.groups
  return Array.isArray(groups) ? groups : []
}

const isDraftPartDirty = (savedValue: unknown, draftValue: unknown): boolean =>
  JSON.stringify(savedValue ?? []) !== JSON.stringify(draftValue ?? [])

export const WebViewFilterGroupBar: React.FC<WebViewFilterGroupBarProps> = ({
  fields,
  currentViewOverride,
  className,
  controlsRef,
  tableFontStyle,
  tableFontWeight,
  tableFontSize,
  onFontStyleChange,
  onFontWeightChange,
  onFontSizeChange,
  isPersonalViewEnabled = false,
  isReadonly = false,
  tableId = null,
  updateViewOverride,
  saveDraftOverride,
  skipSortRecordsFetch = false,
}) => {
  const { t } = useTranslation(['view', 'common'])
  const [viewEditorOpen, setViewEditorOpen] = React.useState(false)
  const [isViewEditorSubmitting, setIsViewEditorSubmitting] = React.useState(false)

  const fontStyleOptions = React.useMemo(
    () =>
      FONT_STYLE_VALUES.map(value => ({
        value,
        label: t(`view:preferencePanel.styles.${value}`),
      })),
    [t],
  )
  const fontWeightOptions = React.useMemo(
    () =>
      FONT_WEIGHT_VALUES.map(value => ({
        value,
        label: t(`view:preferencePanel.weights.${value}`),
      })),
    [t],
  )

  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const initializeDraft = useViewStore(state => state.initializeDraft)
  const setDraftFilters = useViewStore(state => state.setDraftFilters)
  const setDraftGroups = useViewStore(state => state.setDraftGroups)
  const setDraftSorts = useViewStore(state => state.setDraftSorts)
  const setDraftFilterLogic = useViewStore(state => state.setDraftFilterLogic)
  const applyDraft = useViewStore(state => state.applyDraft)
  const draft = useViewStore(state => (currentViewId ? state.draftStates[currentViewId] : undefined))
  const clearDraft = useViewStore(state => state.clearDraft)
  const saveDraft = useViewStore(state => state.saveDraft)
  const saveDraftAsView = useViewStore(state => state.saveDraftAsView)
  const updateView = useViewStore(state => state.updateView)
  const fetchViewRecords = useViewStore(state => state.fetchViewRecords)
  const recordsQuery = useViewStore(state => state.recordsQuery)

  const personalViewDraft = useTableViewUiStore(state =>
    tableId && currentViewId ? state.getPersonalViewDraft(tableId, currentViewId) : null,
  )
  const setPersonalViewDraft = useTableViewUiStore(state => state.setPersonalViewDraft)
  const clearPersonalViewFilterDraft = useTableViewUiStore(state => state.clearPersonalViewFilterDraft)
  const clearPersonalViewSortDraft = useTableViewUiStore(state => state.clearPersonalViewSortDraft)

  const currentView = React.useMemo(
    () => currentViewOverride ?? views.find(v => v.id === currentViewId) ?? null,
    [currentViewOverride, views, currentViewId],
  )
  const toolbarActions = React.useMemo(
    () => getViewToolbarActions(currentView?.view_type),
    [currentView?.view_type],
  )
  const toolbarActionOrder = React.useMemo(() => {
    const order = new Map<ViewToolbarAction, number>()
    toolbarActions.forEach((action, index) => order.set(action, index))
    return order
  }, [toolbarActions])
  const wrapToolbarAction = React.useCallback(
    (action: ViewToolbarAction, node: React.ReactNode) => {
      const order = toolbarActionOrder.get(action)
      if (order === undefined || node == null || node === false) return null
      return (
        <div key={action} className="inline-flex items-center" style={{ order }}>
          {node}
        </div>
      )
    },
    [toolbarActionOrder],
  )
  const groupActionLabel =
    currentView?.view_type === 'kanban'
      ? t('view:actions.groupBy')
      : t('view:actions.group')

  const effectiveView = React.useMemo(() => {
    if (!currentView) return currentView

    // 会话级排序/筛选/分组草稿：关闭弹窗后仍生效，不依赖个人视图开关。
    if (!isPersonalViewEnabled || !personalViewDraft) {
      if (!personalViewDraft) return currentView
      let next = currentView
      if (personalViewDraft.sorts !== undefined) {
        next = { ...next, sorts: personalViewDraft.sorts }
      }
      if (personalViewDraft.filters !== undefined) {
        next = { ...next, filters: personalViewDraft.filters }
      }
      if (personalViewDraft.groups !== undefined) {
        next = { ...next, groups: personalViewDraft.groups }
      }
      if (personalViewDraft.filter_logic === 'and' || personalViewDraft.filter_logic === 'or') {
        next = {
          ...next,
          config: {
            ...((next.config as Record<string, unknown>) ?? {}),
            filter_logic: personalViewDraft.filter_logic,
          },
        }
      }
      return next
    }

    const mergedConfig = personalViewDraft.config
      ? { ...((currentView.config as Record<string, unknown>) ?? {}), ...personalViewDraft.config }
      : currentView.config

    return {
      ...currentView,
      ...(personalViewDraft.filters !== undefined ? { filters: personalViewDraft.filters } : {}),
      ...(personalViewDraft.groups !== undefined ? { groups: personalViewDraft.groups } : {}),
      ...(personalViewDraft.sorts !== undefined ? { sorts: personalViewDraft.sorts } : {}),
      ...(personalViewDraft.visible_fields ? { visible_fields: personalViewDraft.visible_fields } : {}),
      ...(personalViewDraft.field_order ? { field_order: personalViewDraft.field_order } : {}),
      ...(personalViewDraft.column_meta
        ? { column_meta: personalViewDraft.column_meta }
        : {}),
      config:
        personalViewDraft.filter_logic === 'and' || personalViewDraft.filter_logic === 'or'
          ? {
              ...(mergedConfig as Record<string, unknown>),
              filter_logic: personalViewDraft.filter_logic,
            }
          : mergedConfig,
    }
  }, [currentView, isPersonalViewEnabled, personalViewDraft])

  const canMutateViewConfig =
    !isReadonly && Boolean(effectiveView && (!isViewLocked(effectiveView.is_locked) || isPersonalViewEnabled))

  const tl = React.useMemo(() => createLooseTranslate(t), [t])
  const sortTexts = React.useMemo(() => buildSortPanelTexts(tl), [tl])

  const filterStoreSlice = React.useMemo(
    () => ({
      initializeDraft,
      setDraftFilters,
      setDraftFilterLogic,
      applyDraft,
    }),
    [initializeDraft, setDraftFilters, setDraftFilterLogic, applyDraft],
  )
  const groupStoreSlice = React.useMemo(
    () => ({
      initializeDraft,
      setDraftGroups,
      applyDraft,
    }),
    [initializeDraft, setDraftGroups, applyDraft],
  )

  const clearFilterDraftToEmpty = React.useCallback(
    async (viewId: string) => {
      setDraftFilters(viewId, [])
      setDraftFilterLogic(viewId, 'and')
      await applyDraft(viewId)
    },
    [applyDraft, setDraftFilterLogic, setDraftFilters],
  )
  const clearGroupDraftToEmpty = React.useCallback(
    async (viewId: string) => {
      setDraftGroups(viewId, [])
      await applyDraft(viewId)
    },
    [applyDraft, setDraftGroups],
  )

  const controller = useViewFilterGroupController({
    views,
    currentViewId,
    draft,
    isPersonalViewEnabled,
    clearFilterDraft: clearFilterDraftToEmpty,
    clearGroupDraft: clearGroupDraftToEmpty,
    discardDraft: clearDraft,
    saveDraft: saveDraftOverride ?? saveDraft,
    saveDraftAsView,
    translate: tl,
  })

  const hasPersistedLocalViewDraft = React.useMemo(
    () =>
      personalViewDraft?.filters !== undefined ||
      personalViewDraft?.groups !== undefined ||
      personalViewDraft?.sorts !== undefined ||
      personalViewDraft?.filter_logic !== undefined,
    [personalViewDraft],
  )
  const persistedLocalViewFingerprint = React.useMemo(
    () =>
      JSON.stringify({
        filters: personalViewDraft?.filters ?? null,
        groups: personalViewDraft?.groups ?? null,
        sorts: personalViewDraft?.sorts ?? null,
        filter_logic: personalViewDraft?.filter_logic ?? null,
      }),
    [
      personalViewDraft?.filters,
      personalViewDraft?.groups,
      personalViewDraft?.sorts,
      personalViewDraft?.filter_logic,
    ],
  )
  const draftViewFingerprint = React.useMemo(
    () =>
      JSON.stringify({
        filters: draft?.filters ?? null,
        groups: draft?.groups ?? null,
        sorts: draft?.sorts ?? null,
        filter_logic: draft?.filter_logic ?? null,
      }),
    [draft?.filters, draft?.groups, draft?.sorts, draft?.filter_logic],
  )

  // 工具栏筛选/排序草稿 → 会话级 personalViewDraft，供协作投影本地预览（不写共享视图）
  React.useEffect(() => {
    if (!tableId || !currentViewId || !draft) return

    if (!draft.isDirty) {
      if (hasPersistedLocalViewDraft) {
        clearPersonalViewFilterDraft(tableId, currentViewId)
        clearPersonalViewSortDraft(tableId, currentViewId)
      }
      return
    }

    if (draftViewFingerprint === persistedLocalViewFingerprint) return

    setPersonalViewDraft(tableId, currentViewId, {
      filters: draft.filters ?? [],
      groups: draft.groups ?? [],
      sorts: draft.sorts ?? [],
      filter_logic: draft.filter_logic === 'or' ? 'or' : 'and',
    })

    // 非协作完整投影时走 REST 预览
    if (!skipSortRecordsFetch) {
      void applyDraft(currentViewId)
    }
  }, [
    applyDraft,
    clearPersonalViewFilterDraft,
    clearPersonalViewSortDraft,
    currentViewId,
    draft,
    draftViewFingerprint,
    hasPersistedLocalViewDraft,
    persistedLocalViewFingerprint,
    setPersonalViewDraft,
    skipSortRecordsFetch,
    tableId,
  ])

  const hf = useHideFieldsState({ currentView: effectiveView, fields })

  // 排序编辑器优先读统一草稿；尚未建立时回落会话 personalViewDraft。
  const sortSourceSorts = React.useMemo<ViewSortRuleDraftItem[] | undefined>(() => {
    const draftSorts = draft?.sorts ?? personalViewDraft?.sorts
    if (!Array.isArray(draftSorts)) return undefined
    return normalizeSortRulesFromView(draftSorts)
  }, [draft?.sorts, personalViewDraft?.sorts])

  const sortDraftScopeKey =
    tableId && currentViewId ? `${tableId}:${currentViewId}` : null
  const [savedSortBaselineByScope, setSavedSortBaselineByScope] = React.useState<
    Record<string, ViewSort[]>
  >({})

  const persistedSorts = React.useMemo<ViewSort[]>(
    () =>
      (views.find(view => view.id === currentViewId)?.sorts as
        | ViewSort[]
        | undefined) ?? [],
    [views, currentViewId],
  )
  const savedSortBaseline = sortDraftScopeKey
    ? (savedSortBaselineByScope[sortDraftScopeKey] ?? persistedSorts)
    : persistedSorts

  // 排序进统一草稿；会话 personalViewDraft.sorts 由上方镜像 effect 写入。
  const handlePersistSorts = React.useCallback(
    (sorts: ViewSort[]) => {
      if (isReadonly) return
      if (!currentViewId) return
      setDraftSorts(currentViewId, sorts)
    },
    [currentViewId, isReadonly, setDraftSorts],
  )

  const handleDiscardFilterGroupDraft = React.useCallback(async () => {
    if (!currentViewId || !canMutateViewConfig) return
    await controller.handleDiscard()
    if (tableId) {
      clearPersonalViewFilterDraft(tableId, currentViewId)
      clearPersonalViewSortDraft(tableId, currentViewId)
    }
  }, [
    canMutateViewConfig,
    clearPersonalViewFilterDraft,
    clearPersonalViewSortDraft,
    controller,
    currentViewId,
    tableId,
  ])

  const handleClearFilterDraft = React.useCallback(() => {
    void controller.handleClearFilter()
  }, [controller])
  const handleClearGroupDraft = React.useCallback(() => {
    void controller.handleClearGroup()
  }, [controller])

  // 预览走统一草稿 → personalViewDraft / REST applyDraft，编辑器本身不再打 REST。
  const sortState = useSortEditorState({
    currentView: effectiveView,
    currentViewId,
    fields,
    fetchViewRecords,
    recordsQuery,
    sourceSorts: sortSourceSorts,
    serverSorts: savedSortBaseline,
    onPersistSorts: handlePersistSorts,
    skipRecordsFetch: true,
  })

  const markSortSaved = React.useCallback(
    (sorts: ViewSort[]) => {
      if (sortDraftScopeKey) {
        setSavedSortBaselineByScope(prev => ({
          ...prev,
          [sortDraftScopeKey]: sorts,
        }))
      }
      sortState.markSortRulesSaved(sorts)
    },
    [sortDraftScopeKey, sortState],
  )

  /* ---- Derived active indicators ---- */
  const hasActiveFilters = (draft?.filters ?? []).length > 0
  const hasDirtyFilterDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      (
        isDraftPartDirty(normalizeFiltersForDraftCompare(currentView?.filters), normalizeFiltersForDraftCompare(draft.filters)) ||
        getViewFilterLogic(currentView) !== draft.filter_logic
      ),
  )
  const savedSortRules = React.useMemo(
    () => normalizeSortRulesFromView(currentView?.sorts ?? []),
    [currentView?.sorts],
  )
  const hasActiveSorts = (draft?.sorts ?? effectiveView?.sorts ?? []).length > 0
  const hasActiveGroups = (draft?.groups ?? []).length > 0
  const hasDirtyGroupDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      isDraftPartDirty(
        normalizeGroupsForDraftCompare(getViewGroupsForDraftCompare(currentView)),
        normalizeGroupsForDraftCompare(draft.groups),
      ),
  )
  const hasDirtySortDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      isDraftPartDirty(savedSortRules, normalizeSortRulesFromView(draft.sorts)),
  )
  const hasSortBadge = hasDirtySortDraft
  const saveDisabledReasonCode = resolveViewDraftSaveDisabledReason({
    hasCurrentView: Boolean(currentView),
    isReadonly,
    isViewLocked: isViewLocked(currentView?.is_locked),
    isPersonalViewEnabled,
    hasDirtyDraft: controller.hasDirtyDraft,
  })
  const saveDisabledReason = saveDisabledReasonCode
    ? t(VIEW_DRAFT_SAVE_DISABLED_REASON_KEYS[saveDisabledReasonCode])
    : null

  const hasFilterDraftToClear =
    (draft?.filters?.length ?? 0) > 0 || draft?.filter_logic === 'or'
  const hasGroupDraftToClear = (draft?.groups?.length ?? 0) > 0

  /* ---- Refs for stable popover-open callbacks ---- */
  const draftFiltersRef = React.useRef(draft?.filters)
  draftFiltersRef.current = draft?.filters
  const draftGroupsRef = React.useRef(draft?.groups)
  draftGroupsRef.current = draft?.groups
  const currentViewIdRef = React.useRef(currentViewId)
  currentViewIdRef.current = currentViewId

  const openSortPopover = React.useCallback((fieldId?: string) => {
    if (!canMutateViewConfig) return
    sortState.setSortOpen(true)
    if (fieldId) {
      sortState.setSortRules(prev => {
        if (prev.some(r => r.field_id === fieldId)) return prev
        return [...prev, { field_id: fieldId, direction: 'asc' as const }]
      })
    }
  }, [canMutateViewConfig, sortState])

  const openFilterPopover = React.useCallback((fieldId?: string) => {
    if (!canMutateViewConfig) return
    controller.setFilterOpen(true)
    const viewId = currentViewIdRef.current
    if (fieldId && viewId) {
      const existingFilters = draftFiltersRef.current ?? []
      const alreadyHas = existingFilters.some((f: ViewFilter) => f.field_id === fieldId)
      if (!alreadyHas) {
        setDraftFilters(viewId, [...existingFilters, {
          id: crypto.randomUUID(),
          field_id: fieldId,
          operator: 'is_not_empty',
          value: null,
          enabled: true,
        }])
      }
    }
  }, [canMutateViewConfig, controller, setDraftFilters])

  const openGroupPopover = React.useCallback((fieldId?: string) => {
    if (!canMutateViewConfig) return
    controller.setGroupOpen(true)
    const viewId = currentViewIdRef.current
    if (fieldId && viewId) {
      const existingGroups = draftGroupsRef.current ?? []
      const alreadyHas = existingGroups.some((g: ViewGroup) => g.field_id === fieldId)
      if (!alreadyHas) {
        setDraftGroups(viewId, [...existingGroups, { field_id: fieldId, direction: 'asc' }])
      }
    }
  }, [canMutateViewConfig, controller, setDraftGroups])

  React.useEffect(() => {
    if (!isReadonly) return
    controller.setFilterOpen(false)
    controller.setGroupOpen(false)
    controller.setSaveAsOpen(false)
    sortState.setSortOpen(false)
    hf.setHideFieldsOpen(false)
    setViewEditorOpen(false)
  }, [
    controller.setFilterOpen,
    controller.setGroupOpen,
    controller.setSaveAsOpen,
    hf.setHideFieldsOpen,
    isReadonly,
    sortState.setSortOpen,
  ])

  React.useEffect(() => {
    if (controlsRef) {
      controlsRef.current = { openSortPopover, openFilterPopover, openGroupPopover }
    }
    return () => {
      if (controlsRef) controlsRef.current = null
    }
  }, [controlsRef, openSortPopover, openFilterPopover, openGroupPopover])

  /* ---- Handlers ---- */

  const handleSaveSorts = async () => {
    if (!effectiveView || !canMutateViewConfig || isPersonalViewEnabled) return
    if (!currentViewId) return

    const savedSorts = normalizeSortRulesFromView(draft?.sorts ?? sortState.sortRules)
    const result = await controller.handleSave()
    if (result == null) {
      toast({
        title: t('view:operator.saveSortFailedTitle'),
        description: t('view:operator.saveSortFailedDesc'),
        variant: 'destructive',
      })
      return
    }
    toast({ title: t('view:operator.saveSortSuccessTitle') })
    markSortSaved(savedSorts)
    sortState.setSortOpen(false)
  }

  const handleDiscardSorts = () => {
    if (!canMutateViewConfig) return
    sortState.handleDiscardSortDraft()
    void handleDiscardFilterGroupDraft()
    sortState.setSortOpen(false)
  }

  const handleViewEditorSubmit = async (payload: ViewCreateRequest | ViewUpdateRequest) => {
    if (!currentView || !canMutateViewConfig) return

    setIsViewEditorSubmitting(true)
    try {
      const result = await (updateViewOverride ?? updateView)(
        currentView.id,
        payload as ViewUpdateRequest,
      )
      if (!result) {
        throw new Error(t('switcher.updateFailed'))
      }
      toast({ title: t('switcher.updateSuccess') })
      setViewEditorOpen(false)
    } catch (error) {
      toast({
        title: t('switcher.updateFailed'),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsViewEditorSubmitting(false)
    }
  }

  const handleSaveVisibleFields = async () => {
    if (!effectiveView || !canMutateViewConfig) return

    if (hf.visibleFieldIds.length === 0) {
      toast({
        title: t('view:operator.visibleFieldsRequiredTitle'),
        description: t('view:operator.visibleFieldsRequiredDesc'),
        variant: 'destructive',
      })
      return
    }

    if (isPersonalViewEnabled && tableId && currentViewId) {
      const fullPayload = buildViewVisibilityUpdate(effectiveView, fields, hf.visibleFieldIds)
      setPersonalViewDraft(tableId, currentViewId, {
        visible_fields: fullPayload.visible_fields as string[] | undefined,
        field_order: fullPayload.field_order as string[] | undefined,
        column_meta: fullPayload.column_meta as Record<string, { order?: number; hidden?: boolean; visible?: boolean; width?: number }> | undefined,
      })
      hf.setHideFieldsOpen(false)
      return
    }

    const serverPayload = buildViewVisibilityColumnMetaOnlyUpdate(effectiveView, fields, hf.visibleFieldIds)
    const result = await (updateViewOverride ?? updateView)(
      effectiveView.id,
      serverPayload,
      { silent: true },
    )
    if (!result) {
      toast({
        title: t('view:operator.saveVisibleFieldsFailedTitle'),
        description: t('view:operator.saveVisibleFieldsFailedDesc'),
        variant: 'destructive',
      })
      return
    }
    toast({ title: t('view:operator.saveVisibleFieldsSuccessTitle') })
    hf.setHideFieldsOpen(false)
  }

  if (!controller.shouldShow) return null

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div className={className}>
      <div className="flex items-center gap-1">

        {/* Hide Fields */}
        {wrapToolbarAction(
          'hideFields',
          <Popover
          open={hf.hideFieldsOpen && canMutateViewConfig}
          onOpenChange={open => hf.setHideFieldsOpen(canMutateViewConfig && open)}
        >
          <PopoverTrigger asChild>
            <ToolBarButton
              icon={<EyeOff className="h-4 w-4" />}
              label={t('view:actions.hideFields')}
              isActive={hf.hasHiddenFields}
              activeClass="bg-info/10 text-info hover:bg-info/20 hover:text-info"
              disabled={!canMutateViewConfig}
            />
          </PopoverTrigger>
          <HideFieldsPopoverContent
            search={hf.hideFieldsSearch}
            onSearchChange={hf.setHideFieldsSearch}
            filteredFields={hf.filteredFields}
            visibleFieldIds={hf.visibleFieldIds}
            onToggleField={hf.toggleFieldVisibility}
            onShowAll={hf.showAllFields}
            onHideAll={hf.hideAllFields}
            onSave={() => void handleSaveVisibleFields()}
            canSave={canMutateViewConfig}
            lockPrimaryVisibility={hf.lockPrimaryVisibility}
            translate={tl}
            onInteractOutside={handlePopoverInteractOutside}
          />
        </Popover>,
        )}

        {/* Filter */}
        {wrapToolbarAction(
          'filter',
          <ViewFilterPanel
          open={controller.filterOpen && canMutateViewConfig}
          onOpenChange={open => controller.setFilterOpen(canMutateViewConfig && open)}
          viewId={currentViewId}
          fields={fields}
          store={filterStoreSlice}
          draft={draft}
          translate={tl}
          footer={
            <ViewDraftActions
              onCancel={() => {
                void (async () => {
                  await handleDiscardFilterGroupDraft()
                  controller.setFilterOpen(false)
                })()
              }}
              onClear={handleClearFilterDraft}
              onSave={() => {
                if (!canMutateViewConfig) return
                void controller.handleSave()
                controller.setFilterOpen(false)
              }}
              onSaveAs={() => {
                if (!canMutateViewConfig) return
                controller.handleOpenSaveAs()
              }}
              canClear={canMutateViewConfig && hasFilterDraftToClear}
              canCancel={canMutateViewConfig && controller.hasDirtyDraft}
              canSave={canMutateViewConfig && controller.canSave && controller.hasDirtyDraft}
              canSaveAs={canMutateViewConfig}
              saveDisabledReason={saveDisabledReason}
              translate={tl}
            />
          }
        >
          <ToolBarButton
            icon={<Filter className="h-4 w-4" />}
            label={t('view:actions.filter')}
            hasBadge={hasDirtyFilterDraft}
            isActive={hasActiveFilters}
            activeClass="bg-accent/10 text-accent hover:bg-accent/20 hover:text-accent"
            disabled={!canMutateViewConfig}
          />
        </ViewFilterPanel>,
        )}

        {/* Sort */}
        {wrapToolbarAction(
          'sort',
          <Popover
          open={sortState.sortOpen && canMutateViewConfig}
          onOpenChange={open => sortState.setSortOpen(canMutateViewConfig && open)}
        >
          <PopoverTrigger asChild>
            <ToolBarButton
              icon={<ArrowUpDown className="h-4 w-4" />}
              label={t('view:actions.sort')}
              hasBadge={hasSortBadge}
              isActive={hasActiveSorts}
              activeClass="bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning"
              disabled={!canMutateViewConfig}
            />
          </PopoverTrigger>
          <PopoverContent
            side="bottom"
            align="start"
            className="w-fit min-w-[480px] max-w-screen-md p-0"
            onInteractOutside={handlePopoverInteractOutside}
          >
            <div className="space-y-2 p-4">
              <ViewSortRulesEditor
                fields={sortState.sortEditorFields}
                rules={sortState.sortEditorRules}
                onAddRule={sortState.handleAddSortRule}
                onRemoveRule={sortState.handleRemoveSortRule}
                onUpdateRule={sortState.handleUpdateSortRule}
                onMoveRule={sortState.handleMoveSortRule}
                texts={sortTexts}
              />
            </div>
            <div className="border-t px-4 py-3">
              <ViewDraftActions
                onCancel={handleDiscardSorts}
                onClear={() => sortState.handleClearSortRules()}
                onSave={() => void handleSaveSorts()}
                onSaveAs={() => {
                  if (!canMutateViewConfig || isPersonalViewEnabled) return
                  controller.handleOpenSaveAs()
                }}
                canClear={canMutateViewConfig && (draft?.sorts?.length ?? 0) > 0}
                canCancel={canMutateViewConfig && hasDirtySortDraft}
                canSave={
                  canMutateViewConfig &&
                  !isPersonalViewEnabled &&
                  hasDirtySortDraft
                }
                canSaveAs={canMutateViewConfig && !isPersonalViewEnabled}
                saveDisabledReason={saveDisabledReason}
                translate={tl}
              />
            </div>
          </PopoverContent>
        </Popover>,
        )}

        {/* Group */}
        {wrapToolbarAction(
          'group',
          <ViewGroupPanel
          open={controller.groupOpen && canMutateViewConfig}
          onOpenChange={open => controller.setGroupOpen(canMutateViewConfig && open)}
          viewId={currentViewId}
          fields={fields}
          views={views}
          store={groupStoreSlice}
          draft={draft}
          translate={tl}
          footer={
            <ViewDraftActions
              onCancel={() => {
                void (async () => {
                  await handleDiscardFilterGroupDraft()
                  controller.setGroupOpen(false)
                })()
              }}
              onClear={handleClearGroupDraft}
              onSave={() => {
                if (!canMutateViewConfig) return
                void controller.handleSave()
                controller.setGroupOpen(false)
              }}
              onSaveAs={() => {
                if (!canMutateViewConfig) return
                controller.handleOpenSaveAs()
              }}
              canClear={canMutateViewConfig && hasGroupDraftToClear}
              canCancel={canMutateViewConfig && controller.hasDirtyDraft}
              canSave={canMutateViewConfig && controller.canSave && controller.hasDirtyDraft}
              canSaveAs={canMutateViewConfig}
              saveDisabledReason={saveDisabledReason}
              translate={tl}
            />
          }
        >
          <ToolBarButton
            icon={<Layers className="h-4 w-4" />}
            label={groupActionLabel}
            hasBadge={hasDirtyGroupDraft}
            isActive={hasActiveGroups}
            activeClass="bg-success/10 text-success hover:bg-success/20 hover:text-success"
            disabled={!canMutateViewConfig}
          />
        </ViewGroupPanel>,
        )}

        {/* Font / Style Preferences */}
        {wrapToolbarAction(
          'preferences',
          onFontStyleChange ? (
          <Popover>
            <PopoverTrigger asChild>
              <ToolBarButton
                icon={<Palette className="h-4 w-4" />}
                label={t('view:actions.preferences')}
                disabled={isReadonly}
              />
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="start"
              className="w-[240px] p-0"
              onInteractOutside={handlePopoverInteractOutside}
            >
              <div className="space-y-3 p-3">
                <div className="space-y-1.5">
                  <label className="text-body font-medium text-muted-foreground">
                    {t('view:preferencePanel.fontFamily')}
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {fontStyleOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          if (isReadonly) return
                          onFontStyleChange(opt.value)
                        }}
                        className={cn(
                          'rounded-md border px-2 py-1.5 text-body transition-colors',
                          tableFontStyle === opt.value
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-border text-foreground hover:bg-accent',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-body font-medium text-muted-foreground">
                    {t('view:preferencePanel.fontWeight')}
                  </label>
                  <div className="grid grid-cols-2 gap-1">
                    {fontWeightOptions.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          if (isReadonly) return
                          onFontWeightChange?.(opt.value)
                        }}
                        className={cn(
                          'rounded-md border px-2 py-1.5 text-body transition-colors',
                          tableFontWeight === opt.value
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-border text-foreground hover:bg-accent',
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="text-body font-medium text-muted-foreground">
                      {t('view:preferencePanel.fontSize')}
                    </label>
                    <span className="text-body text-muted-foreground">{tableFontSize}px</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {FONT_SIZE_OPTIONS.map(size => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => {
                          if (isReadonly) return
                          onFontSizeChange?.(size)
                        }}
                        className={cn(
                          'min-w-[32px] rounded-md border px-1.5 py-1 text-body transition-colors',
                          tableFontSize === size
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-border text-foreground hover:bg-accent',
                        )}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          ) : null,
        )}

        {wrapToolbarAction(
          'cardConfig',
          <ToolBarButton
            icon={<LayoutGrid className="h-4 w-4" />}
            label={t('view:actions.cardConfig')}
            disabled={!canMutateViewConfig || !currentView}
            onClick={() => {
              if (!currentView || !canMutateViewConfig) return
              setViewEditorOpen(true)
            }}
          />,
        )}

        {wrapToolbarAction(
          'calendarConfig',
          <ToolBarButton
            icon={<Calendar className="h-4 w-4" />}
            label={t('view:actions.calendarConfig')}
            disabled={!canMutateViewConfig || !currentView}
            onClick={() => {
              if (!currentView || !canMutateViewConfig) return
              setViewEditorOpen(true)
            }}
          />,
        )}

        {wrapToolbarAction(
          'editView',
          <ToolBarButton
          icon={<Settings2 className="h-4 w-4" />}
          label={t('view:actions.editView')}
          disabled={!canMutateViewConfig || !currentView}
          onClick={() => {
            if (!currentView || !canMutateViewConfig) return
            setViewEditorOpen(true)
          }}
        />,
        )}

      </div>

      {currentView && (
        <WebViewEditorDialog
          mode="edit"
          open={viewEditorOpen}
          onOpenChange={setViewEditorOpen}
          fields={fields}
          initialView={currentView}
          isSubmitting={isViewEditorSubmitting}
          onSubmit={handleViewEditorSubmit}
        />
      )}

      <SaveAsViewDialog
        open={controller.saveAsOpen && canMutateViewConfig}
        onOpenChange={open => controller.setSaveAsOpen(canMutateViewConfig && open)}
        name={controller.saveAsName}
        onNameChange={controller.setSaveAsName}
        onSave={() => {
          if (!canMutateViewConfig) return
          controller.handleSaveAs()
        }}
        translate={tl}
      />
    </div>
  )
}
