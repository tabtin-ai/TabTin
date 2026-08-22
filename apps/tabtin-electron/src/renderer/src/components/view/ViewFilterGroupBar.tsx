import React from 'react'
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ScrollArea,
  toast,
  cn,
} from '@tabtin/smartsheet-ui'
import {
  ArrowUpDown,
  Calendar,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  EyeOff,
  Filter,
  Layers,
  LayoutGrid,
  ListTree,
  Palette,
  Plus,
  Settings2,
} from 'lucide-react'
import { createLogger } from '@/utils/logger'
import { createAndActivateParentField } from './hierarchyParentFieldFlow'
import { waitForCondition } from '@components/table/hooks/waitForCondition'
import {
  RecordApiService,
  areViewConfigValuesEqual,
  buildViewDraftSavePayload,
  getViewFilterLogic,
  normalizeGroups,
  resolveViewGroups,
  type Field,
  type ViewCreateRequest,
  type ViewMeta,
} from '@tabtin/table-core'
import {
  type TableFontStyle,
  type TableFontWeight,
  type TableFontSize,
} from '@stores/useUIStore'
import { useViewStore, useViewStoreApi } from '@stores/useViewStore'
import { useTableStore, useTableStoreApi } from '@stores/useTableStore'
import { useTableViewUiStore } from '@stores/useTableViewUiStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  useCollabViewUpdaterForTable,
  useCollabDocumentRuntimeForTable,
  useCollabIsTruncatedForTable,
  useCollabViewsMetaForTable,
} from '@stores/useTableCollabStore'
import {
  ViewFilterPanel,
  ViewGroupPanel,
  ViewSortRulesEditor,
  ToolBarButton,
  buildViewVisibilityUpdate,
  buildViewVisibilityColumnMetaOnlyUpdate,
  useHideFieldsState,
  useSortEditorState,
  HideFieldsPopoverContent,
  SaveAsViewDialog,
  ViewDraftActions,
  handlePopoverInteractOutside,
  buildSortPanelTexts,
  getViewToolbarActions,
  isViewLocked,
  normalizeSortRulesFromView,
  resolveViewDraftSaveDisabledReason,
  toOrganizationMembers,
  VIEW_DRAFT_SAVE_DISABLED_REASON_KEYS,
  type ViewSortRuleDraftItem,
  type ViewToolbarAction,
} from '@tabtin/table-ui'
import { useTranslation } from 'react-i18next'
import { useTableReadonly } from '@components/table/TableReadonlyContext'
import { useViewFilterGroupController } from './controller/useViewFilterGroupController'
import { resolveEffectiveCurrentView } from '@components/table/hooks/viewResolution'
import { ViewEditorDialog } from './ViewEditorDialog'
import {
  OPEN_VIEW_FILTER_POPOVER_EVENT,
  OPEN_VIEW_SORT_POPOVER_EVENT,
  type OpenViewFilterPopoverEventDetail,
  type OpenViewSortPopoverEventDetail,
} from './viewToolbarEvents'
import type { ViewSort, ViewUpdateRequest } from '@tabtin/table-core'
import {
  shouldRefreshViewRecordsViaRest,
  shouldUseCollabViewRuntime,
} from '@stores/tableCollabRuntime'
import {
  createSortBaselineOverride,
  resolveSortBaseline,
  type SortBaselineOverride,
} from './sortBaselineOverride'

interface ViewFilterGroupBarProps {
  fields: Field[]
  tableFontStyle: TableFontStyle
  tableFontWeight: TableFontWeight
  tableFontSize: TableFontSize
  onFontStyleChange: (value: string) => void
  onFontWeightChange: (value: string) => void
  onFontSizeChange: (value: number | string) => void
  className?: string
  isReadonly?: boolean
}

const ROW_HEIGHT_OPTIONS = [
  { value: 32, key: 'view:rowHeight.short' },
  { value: 56, key: 'view:rowHeight.medium' },
  { value: 84, key: 'view:rowHeight.tall' },
  { value: 108, key: 'view:rowHeight.extraTall' },
] as const

const FONT_SIZE_OPTIONS: readonly number[] = [12, 13, 14, 16]
const DEFAULT_ROW_HEIGHT = ROW_HEIGHT_OPTIONS[0].value
const DEFAULT_FONT_STYLE: TableFontStyle = 'system'
const DEFAULT_FONT_WEIGHT: TableFontWeight = 'regular'
const DEFAULT_FONT_SIZE: TableFontSize = 12
const VIEW_ACTION_LABEL_BUTTON_WIDTH_PX = 66
const VIEW_ACTION_WIDE_LABEL_BUTTON_WIDTH_PX = 94
const hierarchyLog = createLogger('ViewHierarchy')

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

const isDraftPartDirty = (savedValue: unknown, draftValue: unknown): boolean =>
  !areViewConfigValuesEqual(savedValue ?? [], draftValue ?? [])

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export const ViewFilterGroupBar: React.FC<ViewFilterGroupBarProps> = ({
  fields,
  tableFontStyle,
  tableFontWeight,
  tableFontSize,
  onFontStyleChange,
  onFontWeightChange,
  onFontSizeChange,
  className,
  isReadonly: isReadonlyProp = false,
}) => {
  const { t } = useTranslation(['view', 'common', 'table'])
  const { isTableReadonly: isTableReadonlyFromContext } = useTableReadonly()
  const isReadonly = isReadonlyProp || isTableReadonlyFromContext
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [showViewActionLabels, setShowViewActionLabels] = React.useState(true)
  const [viewEditorOpen, setViewEditorOpen] = React.useState(false)
  const [viewEditorFocus, setViewEditorFocus] = React.useState<'full' | 'typeConfig'>('full')
  const [isViewEditorSubmitting, setIsViewEditorSubmitting] = React.useState(false)

  const openViewEditor = React.useCallback((focus: 'full' | 'typeConfig' = 'full') => {
    setViewEditorFocus(focus)
    setViewEditorOpen(true)
  }, [])

  const stableTranslate = React.useCallback(
    (key: string, opts?: Record<string, unknown>) => String(t(key as any, opts as any)),
    [t],
  )
  const sortTexts = React.useMemo(() => buildSortPanelTexts(stableTranslate), [stableTranslate])

  React.useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') {
      return
    }

    const updateLabelVisibility = (width: number) => {
      const allLabelButtonsWidth =
        VIEW_ACTION_WIDE_LABEL_BUTTON_WIDTH_PX +
        6 * VIEW_ACTION_LABEL_BUTTON_WIDTH_PX +
        6 * 4
      setShowViewActionLabels(width >= allLabelButtonsWidth)
    }

    updateLabelVisibility(root.getBoundingClientRect().width)
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      updateLabelVisibility(entry.contentRect.width)
    })
    observer.observe(root)

    return () => observer.disconnect()
  }, [])

  const views = useViewStore(state => state.views)
  const currentViewId = useViewStore(state => state.currentViewId)
  const selectedTableId = useTableStore(state => state.selectedTable?.id ?? null)
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const organizationStoreMembers = useOrganizationStore(state => state.members)
  const loadOrganizationMembers = useOrganizationStore(state => state.loadMembers)
  const loadFields = useTableStore(state => state.loadFields)
  const tableStoreApi = useTableStoreApi()
  const personalViewByScope = useTableViewUiStore(state => state.personalViewByScope)
  const personalViewDraftByScope = useTableViewUiStore(state => state.personalViewDraftByScope)
  const setPersonalViewDraft = useTableViewUiStore(state => state.setPersonalViewDraft)
  const clearPersonalViewFilterDraft = useTableViewUiStore(state => state.clearPersonalViewFilterDraft)
  const clearPersonalViewSortDraft = useTableViewUiStore(state => state.clearPersonalViewSortDraft)
  const initializeDraft = useViewStore(state => state.initializeDraft)
  const setDraftFilters = useViewStore(state => state.setDraftFilters)
  const setDraftGroups = useViewStore(state => state.setDraftGroups)
  const setDraftSorts = useViewStore(state => state.setDraftSorts)
  const setDraftFilterLogic = useViewStore(state => state.setDraftFilterLogic)
  const restoreDraftSection = useViewStore(state => state.restoreDraftSection)
  const draft = useViewStore(state => (currentViewId ? state.draftStates[currentViewId] : undefined))
  const clearDraft = useViewStore(state => state.clearDraft)
  const saveDraft = useViewStore(state => state.saveDraft)
  const saveDraftAsView = useViewStore(state => state.saveDraftAsView)
  const applyDraft = useViewStore(state => state.applyDraft)
  const updateView = useViewStore(state => state.updateView)
  const fetchViewRecords = useViewStore(state => state.fetchViewRecords)
  const recordsQuery = useViewStore(state => state.recordsQuery)
  const viewStoreApi = useViewStoreApi()
  const collabUpdateView = useCollabViewUpdaterForTable(selectedTableId)
  const collabViewsMeta = useCollabViewsMetaForTable(selectedTableId)
  const isCollabDocumentRuntime = useCollabDocumentRuntimeForTable(selectedTableId)
  const isCollabTruncated = useCollabIsTruncatedForTable(selectedTableId)
  const isCurrentViewCollabRuntime = React.useMemo(
    () =>
      currentViewId
        ? shouldUseCollabViewRuntime({
            isDocumentRuntimeActive: isCollabDocumentRuntime,
            targetViewId: currentViewId,
            collabViews: collabViewsMeta,
          })
        : false,
    [collabViewsMeta, currentViewId, isCollabDocumentRuntime],
  )

  // Y.Doc 协作运行时启用时，表格渲染读取的是当前表的 Y.Doc 视图。视图配置的保存
  // 必须写进同一个 Y.Doc 运行时，否则 REST `updateView` 写入不会反映到正在
  // 渲染的视图，导致保存看起来没生效（筛选/排序/隐藏字段等）。离线时仍走 REST。
  const runtimeUpdateView = React.useCallback(
    (
      viewId: string,
      payload: ViewUpdateRequest,
      options?: { silent?: boolean; refreshRecords?: boolean; optimisticConfig?: Record<string, unknown> },
    ): Promise<unknown> => {
      if (isReadonly) {
        return Promise.resolve(null)
      }
      if (!shouldUseCollabViewRuntime({
        isDocumentRuntimeActive: isCollabDocumentRuntime,
        targetViewId: viewId,
        collabViews: collabViewsMeta,
      })) {
        return updateView(viewId, payload, options)
      }
      if (!collabUpdateView) {
        return Promise.resolve(null)
      }
      return collabUpdateView(viewId, payload, options)
    },
    [collabUpdateView, collabViewsMeta, isCollabDocumentRuntime, isReadonly, updateView],
  )

  // 保存视图草稿（筛选 / 分组 / 排序 / filter_logic 一起提交）时，Y.Doc 运行时写入
  // Y.Doc 视图，并保留草稿内容，让生效视图在 Y.Doc 传播期间持续生效，避免出现
  // 「无筛选」闪烁。kanban 的 group_by_field 映射由 table-core adapter 统一处理。
  const saveDraftForRuntime = React.useCallback(
    async (viewId: string): Promise<unknown> => {
      if (isReadonly) {
        return null
      }
      if (!shouldUseCollabViewRuntime({
        isDocumentRuntimeActive: isCollabDocumentRuntime,
        targetViewId: viewId,
        collabViews: collabViewsMeta,
      })) {
        return saveDraft(viewId)
      }
      if (!collabUpdateView) {
        toast({
          title: t('table:header.personalViewSyncFailedTitle'),
          description: t('table:header.personalViewSyncFailedDesc'),
          variant: 'destructive',
        })
        return null
      }
      const state = viewStoreApi.getState()
      const draftState = state.draftStates[viewId]
      const baseView = collabViewsMeta?.find(view => String(view.id) === viewId) ?? null
      if (!draftState || !baseView) return null

      const payload = buildViewDraftSavePayload(baseView as unknown as ViewMeta, draftState)
      const result = await collabUpdateView(
        viewId,
        {
          filters: payload.filters,
          groups: payload.groups,
          sorts: payload.sorts,
          config: payload.config,
        },
        { silent: true, refreshRecords: false },
      )
      if (result) {
        viewStoreApi.setState(state => ({
          draftStates: {
            ...state.draftStates,
            [viewId]: {
              ...draftState,
              groups: payload.groups,
              isDirty: false,
            },
          },
        }))
        // Y.Doc 运行时启用且快照完整时，视图记录由 Y.Doc 投影驱动（TableCollabContext）。
        // 此处再打 REST fetchViewRecords 会用「PG 尚未回写（3s debounce）时按旧配置
        // 计算的结果」覆盖投影，导致刚设置的分组/分层瞬间回退至平铺。
        // 仅在目标视图不由完整 Y.Doc 投影持有（含缺失视图 / 降级 / 截断）时才主动刷新。
        const needsRestRefresh = shouldRefreshViewRecordsViaRest({
          isDocumentRuntimeActive: isCollabDocumentRuntime,
          targetViewId: viewId,
          collabViews: collabViewsMeta,
          isTruncated: isCollabTruncated,
        })
        if (needsRestRefresh && viewStoreApi.getState().currentViewId === viewId) {
          await fetchViewRecords(viewId, {
            ...viewStoreApi.getState().recordsQuery,
            page: 1,
            filters: payload.filters,
            filter_logic: draftState.filter_logic,
            groups: payload.groups,
            sorts: payload.sorts,
          })
        }
      }
      return result
    },
    [collabUpdateView, collabViewsMeta, fetchViewRecords, isCollabDocumentRuntime, isCollabTruncated, isReadonly, saveDraft, t, viewStoreApi],
  )

  const filterStoreSlice = React.useMemo(
    () => ({ initializeDraft, setDraftFilters, setDraftFilterLogic, applyDraft }),
    [initializeDraft, setDraftFilters, setDraftFilterLogic, applyDraft],
  )
  const groupStoreSlice = React.useMemo(
    () => ({ initializeDraft, setDraftGroups, applyDraft }),
    [initializeDraft, setDraftGroups, applyDraft],
  )

  const personalScopeKey = selectedTableId && currentViewId ? `${selectedTableId}:${currentViewId}` : null
  const isPersonalViewEnabled = personalScopeKey ? Boolean(personalViewByScope[personalScopeKey]) : false
  const personalViewDraft = personalScopeKey ? personalViewDraftByScope[personalScopeKey] : undefined

  const currentView = React.useMemo(() => {
    const restView = views.find(view => view.id === currentViewId) ?? null
    if (!isCurrentViewCollabRuntime || !currentViewId || !collabViewsMeta) {
      return restView
    }
    const ydocView = collabViewsMeta.find(view => String(view.id) === currentViewId)
    return (ydocView as typeof restView) ?? restView
  }, [views, currentViewId, isCurrentViewCollabRuntime, collabViewsMeta])
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
  const effectiveView = React.useMemo(
    () =>
      resolveEffectiveCurrentView({
        currentView,
        isPersonalViewEnabled,
        personalViewDraft,
      }),
    [currentView, isPersonalViewEnabled, personalViewDraft],
  )

  // 完整协作投影吃 personalViewDraft；离线/截断时仍走 REST applyDraft 预览（不写共享视图）
  const shouldPreviewFilterViaRest = !(isCurrentViewCollabRuntime && !isCollabTruncated)

  // Clear：只清当前面板对应的草稿域 + 预览，不写共享视图；共享写只发生在「保存 / 另存为」。
  // 预览由下方「草稿 → personalViewDraft」镜像 effect 统一驱动（协作完整投影读
  // effectiveView，离线/截断走 REST applyDraft），此处不再自己发写请求。
  const clearFilterDraftToEmpty = React.useCallback(
    async (viewId: string) => {
      setDraftFilters(viewId, [])
      setDraftFilterLogic(viewId, 'and')
    },
    [setDraftFilterLogic, setDraftFilters],
  )
  const clearGroupDraftToEmpty = React.useCallback(
    async (viewId: string) => {
      setDraftGroups(viewId, [])
    },
    [setDraftGroups],
  )

  const controller = useViewFilterGroupController({
    views,
    currentViewId,
    draft,
    isPersonalViewEnabled,
    clearFilterDraft: clearFilterDraftToEmpty,
    clearGroupDraft: clearGroupDraftToEmpty,
    // 控制器仍保留整份 Discard 能力；工具栏取消由下方分面板 handler 接管。
    discardDraft: clearDraft,
    saveDraft: saveDraftForRuntime,
    saveDraftAsView,
    translate: stableTranslate,
  })
  const setFilterOpen = controller.setFilterOpen

  const filterUserOptions = React.useMemo(
    () => toOrganizationMembers(organizationStoreMembers).map(member => ({
      value: member.id,
      label: member.name,
      email: member.email,
      avatarUrl: member.avatarUrl,
    })),
    [organizationStoreMembers],
  )

  React.useEffect(() => {
    if (!controller.filterOpen || !selectedOrganizationId) return
    void loadOrganizationMembers(selectedOrganizationId)
  }, [controller.filterOpen, loadOrganizationMembers, selectedOrganizationId])

  const canConfigureViewConfig = Boolean(effectiveView && controller.canConfigure)
  /** 写入共享视图 / Y.Doc / REST（只读 viewer 禁止） */
  const canPersistSharedViewConfig = canConfigureViewConfig && !isReadonly
  /** 隐藏字段「保存」：个人视图草稿始终可写；共享视图仅非只读 */
  const canSaveVisibleFieldsAction =
    canConfigureViewConfig && (!isReadonly || isPersonalViewEnabled)
  /** 行高写入视图配置：同上 */
  const canPersistRowHeightToView =
    canConfigureViewConfig && (!isReadonly || isPersonalViewEnabled)

  const handleClearFilterDraft = React.useCallback(() => {
    void controller.handleClearFilter()
  }, [controller])
  const handleClearGroupDraft = React.useCallback(() => {
    void controller.handleClearGroup()
  }, [controller])

  const handleCancelFilterDraft = React.useCallback(() => {
    if (!currentViewId || !currentView || !canConfigureViewConfig) return
    restoreDraftSection(currentViewId, 'filters', currentView)
    controller.setFilterOpen(false)
  }, [canConfigureViewConfig, controller, currentView, currentViewId, restoreDraftSection])

  const handleCancelGroupDraft = React.useCallback(() => {
    if (!currentViewId || !currentView || !canConfigureViewConfig) return
    restoreDraftSection(currentViewId, 'groups', currentView)
    controller.setGroupOpen(false)
  }, [canConfigureViewConfig, controller, currentView, currentViewId, restoreDraftSection])

  /* ---- Sort: pending field from column header event ---- */
  const [pendingSortFieldId, setPendingSortFieldId] = React.useState<string | null>(null)

  /* ---- Hide-fields popover state ---- */
  const hf = useHideFieldsState({
    currentView: effectiveView,
    fields,
  })
  const [preferencesOpen, setPreferencesOpen] = React.useState(false)

  /* ---- Hierarchy popover state ---- */
  const [hierarchyOpen, setHierarchyOpen] = React.useState(false)
  const [hierarchyLoading, setHierarchyLoading] = React.useState(false)
  const expandAllTreeRecords = useViewStore(state => state.expandAllTreeRecords)
  const collapseAllTreeRecords = useViewStore(state => state.collapseAllTreeRecords)
  const currentViewRecords = useViewStore(state => state.currentViewRecords)

  /* ---- Derived active indicators ---- */
  // 已保存基线一律走 table-core adapter 派生（kanban 的 group_by_field 映射也在其中），
  // 工具栏不再自己判断视图类型。
  const savedGroups = React.useMemo(() => resolveViewGroups(currentView), [currentView])
  const savedSortRules = React.useMemo(
    () => normalizeSortRulesFromView(currentView?.sorts ?? []),
    [currentView],
  )
  const hasActiveFilters = (draft?.filters ?? currentView?.filters ?? []).some(filter => filter.enabled !== false)
  // 对齐 Web：先看 draft.isDirty，避免保存后仅因 string/number 回写形态差导致假红点
  const hasDirtyFilterDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      (
        isDraftPartDirty(normalizeFiltersForDraftCompare(currentView?.filters), normalizeFiltersForDraftCompare(draft.filters)) ||
        getViewFilterLogic(currentView) !== draft.filter_logic
      ),
  )
  const hasActiveSorts = (draft?.sorts ?? effectiveView?.sorts ?? []).length > 0
  // 与筛/排一致：激活态看草稿（本地预览），没有草稿才回落已保存基线
  const hasActiveGroups = (draft?.groups ?? savedGroups).length > 0
  const hasDirtyGroupDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      isDraftPartDirty(normalizeGroups(savedGroups), normalizeGroups(draft.groups)),
  )
  const hasDirtySortDraft = Boolean(
    controller.hasDirtyDraft &&
      draft &&
      isDraftPartDirty(savedSortRules, normalizeSortRulesFromView(draft.sorts)),
  )
  /** 整份草稿脏状态用于保存门禁；三个取消按钮分别看自己的配置域。 */
  const hasDirtyViewDraft = controller.hasDirtyDraft
  const saveDisabledReasonCode = resolveViewDraftSaveDisabledReason({
    hasCurrentView: Boolean(currentView),
    isReadonly,
    isViewLocked: isViewLocked(currentView?.is_locked),
    isPersonalViewEnabled,
    hasDirtyDraft: hasDirtyViewDraft,
  })
  const saveDisabledReason = saveDisabledReasonCode
    ? t(VIEW_DRAFT_SAVE_DISABLED_REASON_KEYS[saveDisabledReasonCode])
    : null
  /** 保存：三个面板同一门禁——可写共享视图 + 草稿确有改动 */
  const canSaveViewDraft = canPersistSharedViewConfig && controller.canSave && hasDirtyViewDraft
  const subRecordParentFieldId = React.useMemo(() => {
    const config = effectiveView?.config as Record<string, unknown> | null | undefined
    const id = config?.subRecordParentFieldId
    return typeof id === 'string' && id.length > 0 ? id : null
  }, [effectiveView?.config])
  const hasActiveHierarchy = Boolean(subRecordParentFieldId)

  const selfLinkFields = React.useMemo(() => {
    return fields.filter(f => {
      if (f.field_type !== 'link') return false
      const cfg = f.options as Record<string, unknown> | null | undefined
      if (!cfg) return false
      return (
        cfg.isOneWay === true &&
        cfg.foreignTableId === selectedTableId &&
        cfg.relationship === 'ManyOne'
      )
    })
  }, [fields, selectedTableId])

  const handleSelectParentField = React.useCallback(
    async (
      fieldId: string | null,
      options?: { closePanel?: boolean; silentToast?: boolean },
    ): Promise<boolean> => {
      if (!effectiveView || !canPersistSharedViewConfig) return false

      const nextConfig = {
        ...((effectiveView.config as Record<string, unknown>) ?? {}),
        subRecordParentFieldId: fieldId,
      }
      try {
        hierarchyLog.info(
          `activate parent field view=${effectiveView.id} field=${fieldId ?? 'none'}`,
        )
        const result = await runtimeUpdateView(
          effectiveView.id,
          { config: nextConfig },
          { silent: true, refreshRecords: true },
        )
        if (result == null) {
          // updater 未就绪 / 只读 / 离线更新失败：一律视为激活失败，避免静默成功
          if (!isReadonly) {
            toast({
              title: t('table:subRecord.selectFailed'),
              variant: 'destructive',
            })
          }
          return false
        }
        if (options?.closePanel !== false) {
          setHierarchyOpen(false)
        }
        if (!options?.silentToast) {
          toast({
            title: fieldId ? t('table:subRecord.hierarchy') : t('table:subRecord.noHierarchy'),
          })
        }
        return true
      } catch (err) {
        hierarchyLog.error('activate parent field failed:', err)
        toast({
          title: t('table:subRecord.selectFailed'),
          variant: 'destructive',
        })
        return false
      }
    },
    [
      effectiveView,
      canPersistSharedViewConfig,
      runtimeUpdateView,
      isReadonly,
      t,
    ],
  )

  const handleExpandAllTree = React.useCallback(() => {
    if (!currentViewId) return
    const metadata = (currentViewRecords as any)?.metadata
    const treeData = metadata?.sub_records?.tree_data
    if (!treeData) return
    const parentIds = Object.entries(treeData as Record<string, { has_children?: boolean }>)
      .filter(([, meta]) => meta.has_children)
      .map(([id]) => id)
    expandAllTreeRecords(currentViewId, parentIds)
  }, [currentViewId, currentViewRecords, expandAllTreeRecords])

  const handleCollapseAllTree = React.useCallback(() => {
    if (!currentViewId) return
    collapseAllTreeRecords(currentViewId)
  }, [currentViewId, collapseAllTreeRecords])

  const handleCreateParentField = React.useCallback(async () => {
    if (!selectedTableId || !canPersistSharedViewConfig) return

    setHierarchyLoading(true)
    try {
      hierarchyLog.info(`create parent field table=${selectedTableId}`)
      const result = await createAndActivateParentField({
        tableId: selectedTableId,
        createParentField: (tableId) => RecordApiService.createParentField(tableId),
        loadFields,
        // 必须读 Provider 内当前表 store，勿用模块级全局 tableStore（fields 不同源）
        waitUntilFieldReady: async (_tableId, fieldId) => {
          // store 写入后通常已同步；再兜底等一轮渲染侧 fields（列表同源）
          if (tableStoreApi.getState().fields.some((field) => field.id === fieldId)) {
            return true
          }
          return waitForCondition(
            () => tableStoreApi.getState().fields.some((field) => field.id === fieldId),
            { timeoutMs: 3000 },
          )
        },
        activateParentField: (fieldId) =>
          handleSelectParentField(fieldId, {
            closePanel: false,
            silentToast: true,
          }),
        log: (message, meta) =>
          hierarchyLog.info(
            meta ? `${message} ${JSON.stringify(meta)}` : message,
          ),
      })
      if (result.status === 'activated') {
        toast({ title: t('table:subRecord.parentFieldCreated') })
      } else if (result.status === 'created_not_activated') {
        toast({
          title: t('table:subRecord.activateFailedKeepField'),
          variant: 'destructive',
        })
      } else {
        hierarchyLog.error('create parent field failed:', result.error)
        toast({
          title: t('table:subRecord.createParentFieldFailed'),
          variant: 'destructive',
        })
      }
    } finally {
      setHierarchyLoading(false)
    }
  }, [
    selectedTableId,
    canPersistSharedViewConfig,
    loadFields,
    tableStoreApi,
    handleSelectParentField,
    t,
  ])
  const hasFilterDraftToClear =
    (draft?.filters?.length ?? 0) > 0 || draft?.filter_logic === 'or'
  const hasGroupDraftToClear = (draft?.groups?.length ?? 0) > 0
  const hasCustomPreferences =
    tableFontStyle !== DEFAULT_FONT_STYLE ||
    tableFontWeight !== DEFAULT_FONT_WEIGHT ||
    tableFontSize !== DEFAULT_FONT_SIZE
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
  const persistedLocalFilters = personalViewDraft?.filters
  const persistedLocalGroups = personalViewDraft?.groups
  const persistedLocalSorts = personalViewDraft?.sorts
  const persistedLocalFilterLogic = personalViewDraft?.filter_logic
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
  const filterDraftScopeKey =
    selectedTableId && currentViewId ? `${selectedTableId}:${currentViewId}` : null
  const restoredFilterDraftScopeRef = React.useRef<string | null>(null)
  const sortDraftScopeKey =
    selectedTableId && currentViewId ? `${selectedTableId}:${currentViewId}` : null
  const [savedSortBaselineByScope, setSavedSortBaselineByScope] = React.useState<
    Record<string, SortBaselineOverride>
  >({})

  /* ---- Sort: useSortEditorState (shared hook) ---- */
  // 排序编辑器的初始规则优先取统一草稿；草稿尚未建立时（刚进页面）回落到会话草稿。
  const sortSourceSorts = React.useMemo<ViewSortRuleDraftItem[] | undefined>(() => {
    const draftSorts = draft?.sorts ?? personalViewDraft?.sorts
    if (!Array.isArray(draftSorts)) return undefined
    return normalizeSortRulesFromView(draftSorts)
  }, [draft?.sorts, personalViewDraft?.sorts])

  // 已保存排序基线跟随 currentView（Y.Doc 运行时启用时即 Y.Doc 视图），与筛选/分组同源。
  const persistedSorts = React.useMemo<ViewSort[]>(
    () => (currentView?.sorts as ViewSort[] | undefined) ?? [],
    [currentView],
  )
  const savedSortOverride = sortDraftScopeKey
    ? savedSortBaselineByScope[sortDraftScopeKey]
    : undefined
  const resolvedSortBaseline = resolveSortBaseline(persistedSorts, savedSortOverride)
  const savedSortBaseline = resolvedSortBaseline.sorts

  React.useEffect(() => {
    if (!sortDraftScopeKey || !resolvedSortBaseline.shouldClearOverride) return
    setSavedSortBaselineByScope(previous => {
      if (previous[sortDraftScopeKey] !== savedSortOverride) return previous
      const next = { ...previous }
      delete next[sortDraftScopeKey]
      return next
    })
  }, [resolvedSortBaseline.shouldClearOverride, savedSortOverride, sortDraftScopeKey])

  // 排序改动进统一草稿：与筛选/分组共用 dirty / preview / save / discard。
  // 会话级 personalViewDraft.sorts 由下方镜像 effect 统一写入，这里不再单独写。
  const handlePersistSorts = React.useCallback(
    (sorts: ViewSort[]) => {
      if (currentViewId) {
        setDraftSorts(currentViewId, sorts)
      }
    },
    [currentViewId, setDraftSorts],
  )

  const handlePendingSortConsumed = React.useCallback(() => {
    setPendingSortFieldId(null)
  }, [])

  // 排序预览走统一草稿链路（草稿 → personalViewDraft → 协作投影 / REST applyDraft），
  // 因此编辑器本身不再直接打 REST，避免与草稿预览重复取数。
  const sortState = useSortEditorState({
    currentView: effectiveView,
    currentViewId,
    fields,
    fetchViewRecords,
    recordsQuery,
    sourceSorts: sortSourceSorts,
    onPersistSorts: handlePersistSorts,
    pendingSortFieldId,
    onPendingSortFieldConsumed: handlePendingSortConsumed,
    serverSorts: savedSortBaseline,
    skipRecordsFetch: true,
  })

  const markSortSaved = React.useCallback(
    (sorts: ViewSort[]) => {
      if (sortDraftScopeKey) {
        setSavedSortBaselineByScope(prev => ({
          ...prev,
          [sortDraftScopeKey]: createSortBaselineOverride(sorts, persistedSorts),
        }))
      }
      sortState.markSortRulesSaved(sorts)
    },
    [persistedSorts, sortDraftScopeKey, sortState],
  )

  const hasSortBadge = hasDirtySortDraft

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    const handleSortOpenRequest = (event: Event) => {
      const customEvent = event as CustomEvent<OpenViewSortPopoverEventDetail>
      const detail = customEvent.detail
      if (!detail) return

      const targetViewId =
        typeof detail.viewId === 'string' && detail.viewId.trim().length > 0
          ? detail.viewId
          : null
      if (targetViewId && targetViewId !== currentViewId) return

      const targetFieldId =
        typeof detail.fieldId === 'string' && detail.fieldId.trim().length > 0
          ? detail.fieldId.trim()
          : null

      setPendingSortFieldId(targetFieldId)
      sortState.setSortOpen(true)
    }

    window.addEventListener(OPEN_VIEW_SORT_POPOVER_EVENT, handleSortOpenRequest as EventListener)
    return () => {
      window.removeEventListener(OPEN_VIEW_SORT_POPOVER_EVENT, handleSortOpenRequest as EventListener)
    }
  }, [currentViewId, sortState.setSortOpen])

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    const handleFilterOpenRequest = (event: Event) => {
      const customEvent = event as CustomEvent<OpenViewFilterPopoverEventDetail>
      const detail = customEvent.detail
      if (!detail) return

      const targetViewId =
        typeof detail.viewId === 'string' && detail.viewId.trim().length > 0
          ? detail.viewId
          : null
      if (targetViewId && targetViewId !== currentViewId) return

      setFilterOpen(true)
    }

    // eslint-disable-next-line tabtin/prefer-scoped-activity-effects -- 与排序弹窗一致，表头菜单通过同页全局事件打开工具栏 popover。
    window.addEventListener(OPEN_VIEW_FILTER_POPOVER_EVENT, handleFilterOpenRequest as EventListener)
    return () => {
      window.removeEventListener(OPEN_VIEW_FILTER_POPOVER_EVENT, handleFilterOpenRequest as EventListener)
    }
  }, [currentViewId, setFilterOpen])

  React.useEffect(() => {
    if (!filterDraftScopeKey || !currentViewId) {
      restoredFilterDraftScopeRef.current = null
      return
    }

    if (restoredFilterDraftScopeRef.current === filterDraftScopeKey) {
      return
    }
    restoredFilterDraftScopeRef.current = filterDraftScopeKey

    if (!hasPersistedLocalViewDraft) {
      return
    }

    // Restore persisted local filter/group/sort draft only once per table+view scope.
    initializeDraft(currentViewId)

    if (Array.isArray(persistedLocalFilters)) {
      setDraftFilters(currentViewId, persistedLocalFilters)
    }
    if (Array.isArray(persistedLocalGroups)) {
      setDraftGroups(currentViewId, persistedLocalGroups)
    }
    if (Array.isArray(persistedLocalSorts)) {
      setDraftSorts(currentViewId, persistedLocalSorts)
    }
    if (persistedLocalFilterLogic === 'and' || persistedLocalFilterLogic === 'or') {
      setDraftFilterLogic(currentViewId, persistedLocalFilterLogic)
    }

    void applyDraft(currentViewId)
  }, [
    applyDraft,
    currentViewId,
    filterDraftScopeKey,
    hasPersistedLocalViewDraft,
    initializeDraft,
    persistedLocalFilterLogic,
    persistedLocalFilters,
    persistedLocalGroups,
    persistedLocalSorts,
    setDraftFilterLogic,
    setDraftFilters,
    setDraftGroups,
    setDraftSorts,
  ])

  // 统一草稿 → 会话级 personalViewDraft 镜像：筛选 / 分组 / 排序共用同一条预览链路。
  // 协作完整投影读 effectiveView（不写共享视图），离线/截断时补一发 REST applyDraft。
  React.useEffect(() => {
    if (!selectedTableId || !currentViewId || !draft) {
      return
    }

    if (!draft.isDirty) {
      if (!hasPersistedLocalViewDraft) {
        return
      }
      clearPersonalViewFilterDraft(selectedTableId, currentViewId)
      clearPersonalViewSortDraft(selectedTableId, currentViewId)
      // 草稿刚回到已保存配置（保存 / 清除 / 取消）：REST 预览需按已保存配置重新取数。
      if (shouldPreviewFilterViaRest) {
        void applyDraft(currentViewId)
      }
      return
    }

    if (draftViewFingerprint === persistedLocalViewFingerprint) {
      return
    }

    setPersonalViewDraft(selectedTableId, currentViewId, {
      filters: draft.filters ?? [],
      groups: draft.groups ?? [],
      sorts: draft.sorts ?? [],
      filter_logic: draft.filter_logic === 'or' ? 'or' : 'and',
    })

    if (shouldPreviewFilterViaRest) {
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
    selectedTableId,
    setPersonalViewDraft,
    shouldPreviewFilterViaRest,
  ])

  /* ---- Row height ---- */
  const rowHeightRaw = Number((effectiveView?.config as any)?.row_height)
  const rowHeight = Number.isFinite(rowHeightRaw) ? rowHeightRaw : DEFAULT_ROW_HEIGHT
  const fontStyleOptions = React.useMemo(
    () => [
      {
        value: 'system' as TableFontStyle,
        label: String(t('table:toolbar.fontSystem')),
      },
      {
        value: 'serif' as TableFontStyle,
        label: String(t('table:toolbar.fontSerif')),
      },
      {
        value: 'mono' as TableFontStyle,
        label: String(t('table:toolbar.fontMono')),
      },
      {
        value: 'rounded' as TableFontStyle,
        label: String(t('table:toolbar.fontRounded')),
      },
    ],
    [t],
  )
  const fontWeightOptions = React.useMemo(
    () => [
      { value: 'thin' as TableFontWeight, label: String(t('table:fontWeight.thin')) },
      { value: 'regular' as TableFontWeight, label: String(t('table:fontWeight.regular')) },
      { value: 'medium' as TableFontWeight, label: String(t('table:fontWeight.medium')) },
      { value: 'semibold' as TableFontWeight, label: String(t('table:fontWeight.semibold')) },
    ],
    [t],
  )
  const selectedRowHeight = React.useMemo(() => {
    return ROW_HEIGHT_OPTIONS.reduce<number>((nearest, option) => {
      const nearestDelta = Math.abs(nearest - rowHeight)
      const currentDelta = Math.abs(option.value - rowHeight)
      return currentDelta < nearestDelta ? option.value : nearest
    }, DEFAULT_ROW_HEIGHT)
  }, [rowHeight])
  const isPreferenceActive = hasCustomPreferences || selectedRowHeight !== DEFAULT_ROW_HEIGHT
  const canResetPreferences =
    hasCustomPreferences ||
    (canPersistRowHeightToView && selectedRowHeight !== DEFAULT_ROW_HEIGHT)
  const selectedFontSizeIndex = React.useMemo(
    () => Math.max(0, FONT_SIZE_OPTIONS.indexOf(tableFontSize)),
    [tableFontSize],
  )
  const selectedRowHeightIndex = React.useMemo(() => {
    const index = ROW_HEIGHT_OPTIONS.findIndex(option => option.value === selectedRowHeight)
    return Math.max(0, index)
  }, [selectedRowHeight])
  const selectedRowHeightLabelKey =
    ROW_HEIGHT_OPTIONS[selectedRowHeightIndex]?.key ?? ROW_HEIGHT_OPTIONS[0].key
  const [rowHeightSliderIndex, setRowHeightSliderIndex] = React.useState(selectedRowHeightIndex)

  React.useEffect(() => {
    if (!preferencesOpen) return
    setRowHeightSliderIndex(selectedRowHeightIndex)
  }, [preferencesOpen, selectedRowHeightIndex])

  /* ---- Personal-view toast ---- */
  const notifyPersonalOnly = React.useCallback(() => {
    toast({
      title: t('table:header.personalViewNoSharedWriteTitle'),
      description: t('table:header.personalViewNoSharedWriteDesc'),
    })
  }, [t])

  /* ================================================================ */
  /*  Handlers                                                         */
  /* ================================================================ */

  /**
   * 统一保存：把整份草稿（筛选 / 分组 / 排序 / filter_logic，kanban 另含 group_by_field）
   * 一次写入共享视图。三个面板的「保存」都走这里，避免各写各的字段互相覆盖。
   */
  const handleSaveViewDraft = async (): Promise<boolean> => {
    if (!currentViewId || !canPersistSharedViewConfig) return false
    const savedSorts = viewStoreApi.getState().draftStates[currentViewId]?.sorts ?? []

    const result = await controller.handleSave()
    // saveDraft 成功可能返回更新后的 ViewMeta / true；被门禁拦下时为 null/undefined
    if (result == null) return false

    // 已落到共享视图，排序编辑器的已保存基线随之推进（协作态 REST views 可能还没回写）
    markSortSaved(savedSorts)
    return true
  }

  const handleSaveSorts = async (
    options?: { closePopover?: boolean; showSuccessToast?: boolean },
  ): Promise<boolean> => {
    const closePopover = options?.closePopover ?? true
    const showSuccessToast = options?.showSuccessToast ?? true

    const saved = await handleSaveViewDraft()
    if (!saved) {
      toast({
        title: t('view:operator.saveSortFailedTitle'),
        description: t('view:operator.saveSortFailedDesc'),
        variant: 'destructive',
      })
      return false
    }

    if (showSuccessToast) {
      toast({ title: t('view:operator.saveSortSuccessTitle') })
    }
    if (closePopover) {
      sortState.setSortOpen(false)
    }
    return true
  }

  const handleDiscardSorts = () => {
    if (!canConfigureViewConfig || !currentViewId || !currentView) return
    // 排序编辑器先回到自己的已保存基线，再让统一草稿仅回滚排序部分。
    sortState.handleDiscardSortDraft()
    restoreDraftSection(currentViewId, 'sorts', {
      ...currentView,
      sorts: savedSortBaseline,
    })
    sortState.setSortOpen(false)
  }

  const handleSaveVisibleFields = async () => {
    if (!effectiveView || !canConfigureViewConfig) return

    if (hf.visibleFieldIds.length === 0) {
      toast({
        title: t('view:operator.visibleFieldsRequiredTitle'),
        description: t('view:operator.visibleFieldsRequiredDesc'),
        variant: 'destructive',
      })
      return
    }

    const payload = buildViewVisibilityUpdate(effectiveView, fields, hf.visibleFieldIds)

    if (isPersonalViewEnabled && selectedTableId && currentViewId) {
      setPersonalViewDraft(selectedTableId, currentViewId, {
        visible_fields: payload.visible_fields,
        field_order: payload.field_order,
        ...(payload.column_meta ? { column_meta: payload.column_meta } : {}),
        ...(payload.config ? { config: payload.config as Record<string, unknown> } : {}),
      })
      notifyPersonalOnly()
      hf.setHideFieldsOpen(false)
      return
    }

    if (isReadonly) {
      return
    }

    const serverPayload = buildViewVisibilityColumnMetaOnlyUpdate(
      effectiveView,
      fields,
      hf.visibleFieldIds,
    )
    const result = await runtimeUpdateView(effectiveView.id, serverPayload, { silent: true })

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

  const handleRowHeightChange = async (nextRowHeight: number) => {
    if (!effectiveView || !canConfigureViewConfig) return

    const nextConfig = {
      ...((effectiveView.config as Record<string, unknown>) ?? {}),
      row_height: nextRowHeight,
    }

    if (isPersonalViewEnabled && selectedTableId && currentViewId) {
      setPersonalViewDraft(selectedTableId, currentViewId, {
        config: { row_height: nextRowHeight },
      })
      notifyPersonalOnly()
      return
    }

    if (isReadonly) {
      return
    }

    const result = await runtimeUpdateView(
      effectiveView.id,
      { config: nextConfig },
      { silent: true, refreshRecords: false, optimisticConfig: nextConfig },
    )

    if (!result) {
      toast({
        title: t('view:operator.saveRowHeightFailedTitle'),
        description: t('view:operator.saveRowHeightFailedDesc'),
        variant: 'destructive',
      })
      return
    }

    toast({ title: t('view:operator.saveRowHeightSuccessTitle') })
  }

  const handleResetPreferences = async () => {
    if (tableFontStyle !== DEFAULT_FONT_STYLE) {
      onFontStyleChange(DEFAULT_FONT_STYLE)
    }
    if (tableFontWeight !== DEFAULT_FONT_WEIGHT) {
      onFontWeightChange(DEFAULT_FONT_WEIGHT)
    }
    if (tableFontSize !== DEFAULT_FONT_SIZE) {
      onFontSizeChange(DEFAULT_FONT_SIZE)
    }

    if (canPersistRowHeightToView && selectedRowHeight !== DEFAULT_ROW_HEIGHT) {
      await handleRowHeightChange(DEFAULT_ROW_HEIGHT)
    }
  }

  const handleFontSizeSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextIndex = Math.min(
      FONT_SIZE_OPTIONS.length - 1,
      Math.max(0, Number.parseInt(event.target.value, 10) || 0),
    )
    const nextSize = FONT_SIZE_OPTIONS[nextIndex]
    if (nextSize !== tableFontSize) {
      onFontSizeChange(nextSize)
    }
  }

  const handleRowHeightSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextIndex = Math.min(
      ROW_HEIGHT_OPTIONS.length - 1,
      Math.max(0, Number.parseInt(event.target.value, 10) || 0),
    )
    setRowHeightSliderIndex(nextIndex)
  }

  const commitRowHeightSlider = () => {
    if (!canPersistRowHeightToView) return
    const nextRowHeight =
      ROW_HEIGHT_OPTIONS[rowHeightSliderIndex]?.value ?? DEFAULT_ROW_HEIGHT
    if (nextRowHeight !== selectedRowHeight) {
      void handleRowHeightChange(nextRowHeight)
    }
  }

  const renderSortActions = () => (
    <ViewDraftActions
      onClear={sortState.handleClearSortRules}
      onCancel={handleDiscardSorts}
      onSave={() => {
        void handleSaveSorts()
      }}
      onSaveAs={controller.handleOpenSaveAs}
      canClear={canConfigureViewConfig && sortState.sortRules.length > 0}
      canCancel={canConfigureViewConfig && hasDirtySortDraft}
      canSave={canSaveViewDraft}
      canSaveAs={canPersistSharedViewConfig}
      saveDisabledReason={saveDisabledReason}
      translate={stableTranslate}
    />
  )

  const toolbarButtonLabelClassName = showViewActionLabels ? 'inline' : 'hidden'
  const getViewActionTooltip = (label: string) =>
    showViewActionLabels ? '' : label
  const renderViewActionTrigger = (tooltip: string, trigger: React.ReactElement) =>
    tooltip ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : (
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    )
  /** 标签可见时 tooltip 为空——勿包空 TooltipContent（否则 hover 出空框） */
  const renderPlainActionTooltip = (tooltip: string, trigger: React.ReactElement) =>
    tooltip ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{trigger}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : (
      trigger
    )

  const handleViewEditorSubmit = React.useCallback(
    async (payload: ViewCreateRequest | ViewUpdateRequest) => {
      if (!currentView || isReadonly) return

      setIsViewEditorSubmitting(true)
      try {
        const result = await runtimeUpdateView(currentView.id, payload as ViewUpdateRequest, {
          refreshRecords: true,
        })

        if (!result) {
          toast({
            title: t('view:switcher.saveFailedTitle'),
            description: t('view:switcher.saveFailedDesc'),
            variant: 'destructive',
          })
          return
        }

        toast({ title: t('view:switcher.updateSuccessTitle') })
        setViewEditorOpen(false)
      } catch (error) {
        toast({
          title: t('view:switcher.saveFailedTitle'),
          description: error instanceof Error ? error.message : t('view:switcher.saveFailedDesc'),
          variant: 'destructive',
        })
      } finally {
        setIsViewEditorSubmitting(false)
      }
    },
    [currentView, isReadonly, runtimeUpdateView, t],
  )

  if (!controller.shouldShow) return null

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div className="flex items-center gap-1">
        {/* ---- Hide Fields (Popover) — 只读 viewer 不展示 ---- */}
        {wrapToolbarAction(
          'hideFields',
          !isReadonly ? (
        <Popover open={hf.hideFieldsOpen} onOpenChange={hf.setHideFieldsOpen}>
          {renderViewActionTrigger(
            getViewActionTooltip(t('view:actions.hideFields')),
            <ToolBarButton
              icon={<EyeOff className="h-3.5 w-3.5" />}
              label={t('view:actions.hideFields')}
              labelClassName={toolbarButtonLabelClassName}
              title={getViewActionTooltip(t('view:actions.hideFields'))}
              isActive={hf.hasHiddenFields}
              activeClass="bg-info/10 text-info hover:bg-info/20 hover:text-info"
              disabled={!canConfigureViewConfig}
            />,
          )}
          <HideFieldsPopoverContent
            search={hf.hideFieldsSearch}
            onSearchChange={hf.setHideFieldsSearch}
            filteredFields={hf.filteredFields}
            visibleFieldIds={hf.visibleFieldIds}
            onToggleField={hf.toggleFieldVisibility}
            onShowAll={hf.showAllFields}
            onHideAll={hf.hideAllFields}
            onSave={() => void handleSaveVisibleFields()}
            canSave={canSaveVisibleFieldsAction}
            lockPrimaryVisibility={hf.lockPrimaryVisibility}
            translate={stableTranslate}
            onInteractOutside={handlePopoverInteractOutside}
          />
        </Popover>
          ) : null,
        )}

        {/* ---- Filter (Popover via ViewFilterPanel) ---- */}
        {wrapToolbarAction(
          'filter',
          <ViewFilterPanel
          open={controller.filterOpen}
          onOpenChange={controller.setFilterOpen}
          viewId={currentViewId}
          fields={fields}
          triggerTooltip={getViewActionTooltip(t('view:actions.filter')) || undefined}
          store={filterStoreSlice}
          draft={draft}
          translate={stableTranslate}
          userOptions={filterUserOptions}
          footer={
            <ViewDraftActions
              onCancel={handleCancelFilterDraft}
              onClear={handleClearFilterDraft}
              onSave={() => {
                void handleSaveViewDraft()
                controller.setFilterOpen(false)
              }}
              onSaveAs={controller.handleOpenSaveAs}
              canClear={canConfigureViewConfig && hasFilterDraftToClear}
              canCancel={canConfigureViewConfig && hasDirtyFilterDraft}
              canSave={canSaveViewDraft}
              canSaveAs={canPersistSharedViewConfig}
              saveDisabledReason={saveDisabledReason}
              translate={stableTranslate}
            />
          }
        >
          <ToolBarButton
            icon={<Filter className="h-3.5 w-3.5" />}
            label={t('view:actions.filter')}
            labelClassName={toolbarButtonLabelClassName}
            hasBadge={hasDirtyFilterDraft}
            title={getViewActionTooltip(t('view:actions.filter'))}
            isActive={hasActiveFilters}
            activeClass="bg-accent/10 text-accent hover:bg-accent/20 hover:text-accent"
            disabled={!canConfigureViewConfig}
          />
        </ViewFilterPanel>,
        )}

        {/* ---- Sort (Popover) ---- */}
        {wrapToolbarAction(
          'sort',
          <Popover open={sortState.sortOpen} onOpenChange={sortState.setSortOpen}>
          {renderViewActionTrigger(
            getViewActionTooltip(t('view:actions.sort')),
            <ToolBarButton
              icon={<ArrowUpDown className="h-3.5 w-3.5" />}
              label={t('view:actions.sort')}
              labelClassName={toolbarButtonLabelClassName}
              hasBadge={hasSortBadge}
              title={getViewActionTooltip(t('view:actions.sort'))}
              isActive={hasActiveSorts}
              activeClass="bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning"
              disabled={!canConfigureViewConfig}
            />,
          )}
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
              {renderSortActions()}
            </div>
          </PopoverContent>
        </Popover>,
        )}

        {/* ---- Group (Popover via ViewGroupPanel) ---- */}
        {wrapToolbarAction(
          'group',
          <ViewGroupPanel
          open={controller.groupOpen}
          onOpenChange={controller.setGroupOpen}
          viewId={currentViewId}
          fields={fields}
          views={views}
          triggerTooltip={getViewActionTooltip(groupActionLabel) || undefined}
          store={groupStoreSlice}
          draft={draft}
          translate={stableTranslate}
          footer={
            <ViewDraftActions
              onCancel={handleCancelGroupDraft}
              onClear={handleClearGroupDraft}
              onSave={() => {
                void handleSaveViewDraft()
                controller.setGroupOpen(false)
              }}
              onSaveAs={controller.handleOpenSaveAs}
              canClear={canConfigureViewConfig && hasGroupDraftToClear}
              canCancel={canConfigureViewConfig && hasDirtyGroupDraft}
              canSave={canSaveViewDraft}
              canSaveAs={canPersistSharedViewConfig}
              saveDisabledReason={saveDisabledReason}
              translate={stableTranslate}
            />
          }
        >
          <ToolBarButton
            icon={<Layers className="h-3.5 w-3.5" />}
            label={groupActionLabel}
            labelClassName={toolbarButtonLabelClassName}
            hasBadge={hasDirtyGroupDraft}
            title={getViewActionTooltip(groupActionLabel)}
            isActive={hasActiveGroups}
            activeClass="bg-success/10 text-success hover:bg-success/20 hover:text-success"
            disabled={!canConfigureViewConfig}
          />
        </ViewGroupPanel>,
        )}

        {/* ---- Hierarchy (sub-record parent field selector) ---- */}
        {wrapToolbarAction(
          'hierarchy',
          <Popover open={hierarchyOpen} onOpenChange={setHierarchyOpen}>
          {renderViewActionTrigger(
            getViewActionTooltip(t('view:actions.hierarchy')),
            <ToolBarButton
              icon={<ListTree className="h-3.5 w-3.5" />}
              label={t('view:actions.hierarchy')}
              labelClassName={toolbarButtonLabelClassName}
              title={getViewActionTooltip(t('view:actions.hierarchy'))}
              isActive={hasActiveHierarchy}
              activeClass="bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
              disabled={!canConfigureViewConfig}
            />,
          )}
          <PopoverContent
            side="bottom"
            align="start"
            className="w-[260px] p-0"
            onInteractOutside={handlePopoverInteractOutside}
          >
            <div className="border-b px-4 py-2.5">
              <div className="text-body font-medium">{t('table:subRecord.parentField')}</div>
            </div>
            <ScrollArea className="max-h-[240px]">
              <div
                className="p-1"
                role="radiogroup"
                aria-label={t('table:subRecord.parentField')}
              >
              {/* No hierarchy option */}
              <button
                type="button"
                role="radio"
                aria-checked={!subRecordParentFieldId}
                disabled={!canPersistSharedViewConfig}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-body',
                  canPersistSharedViewConfig
                    ? 'cursor-pointer hover:bg-accent/60'
                    : 'cursor-default opacity-60',
                  !subRecordParentFieldId && 'bg-accent/30 font-medium',
                )}
                onClick={() => {
                  if (canPersistSharedViewConfig) void handleSelectParentField(null)
                }}
              >
                <span className="min-w-0 flex-1 truncate">{t('table:subRecord.noHierarchy')}</span>
                {!subRecordParentFieldId ? (
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-primary"
                    aria-label={t('table:subRecord.selectedMark')}
                  />
                ) : null}
              </button>

              {/* Existing self-link fields */}
              {selfLinkFields.map(field => {
                const isSelected = subRecordParentFieldId === field.id
                return (
                  <button
                    key={field.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    disabled={!canPersistSharedViewConfig}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-body',
                      canPersistSharedViewConfig
                        ? 'cursor-pointer hover:bg-accent/60'
                        : 'cursor-default opacity-60',
                      isSelected && 'bg-accent/30 font-medium',
                    )}
                    onClick={() => {
                      if (canPersistSharedViewConfig) void handleSelectParentField(field.id)
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{field.name}</span>
                    {isSelected ? (
                      <Check
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                        aria-label={t('table:subRecord.selectedMark')}
                      />
                    ) : null}
                  </button>
                )
              })}

              {selfLinkFields.length === 0 && (
                <div className="px-3 py-2 text-body text-muted-foreground">
                  {t('table:subRecord.noSelfLinkFields')}
                </div>
              )}
              </div>
            </ScrollArea>

            {/* Expand/Collapse all tree records */}
            {hasActiveHierarchy && (
              <div className="flex items-center gap-1 border-t px-3 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 gap-1 text-body"
                  onClick={handleExpandAllTree}
                >
                  <ChevronsUpDown className="h-3.5 w-3.5" />
                  {t('table:subRecord.expandAll')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1 gap-1 text-body"
                  onClick={handleCollapseAllTree}
                >
                  <ChevronsDownUp className="h-3.5 w-3.5" />
                  {t('table:subRecord.collapseAll')}
                </Button>
              </div>
            )}

            {/* Create parent field button */}
            <div className="border-t px-3 py-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-body"
                onClick={() => void handleCreateParentField()}
                disabled={hierarchyLoading || !canPersistSharedViewConfig}
              >
                <Plus className="h-4 w-4" />
                {t('table:subRecord.createParentField')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>,
        )}

        {/* ---- Style (font + row height) ---- */}
        {wrapToolbarAction(
          'preferences',
          <Popover open={preferencesOpen} onOpenChange={setPreferencesOpen}>
          {renderViewActionTrigger(
            getViewActionTooltip(t('view:actions.preferences')),
            <ToolBarButton
              icon={<Palette className="h-3.5 w-3.5" />}
              label={t('view:actions.preferences')}
              labelClassName={toolbarButtonLabelClassName}
              title={getViewActionTooltip(t('view:actions.preferences'))}
              isActive={isPreferenceActive}
              activeClass="bg-info/10 text-info hover:bg-info/20 hover:text-info"
            />,
          )}
          <PopoverContent
            side="bottom"
            align="start"
            className="w-[320px] p-0"
            onInteractOutside={handlePopoverInteractOutside}
          >
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div className="text-body font-medium">{t('view:preferencePanel.title')}</div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-body"
                onClick={() => void handleResetPreferences()}
                disabled={!canResetPreferences}
              >
                {t('view:preferencePanel.reset')}
              </Button>
            </div>

            <div className="space-y-4 p-4">
              <div className="space-y-1.5">
                <div className="text-body font-medium text-muted-foreground">
                  {t('view:preferencePanel.fontFamily')}
                </div>
                <Select value={tableFontStyle} onValueChange={onFontStyleChange}>
                  <SelectTrigger className="h-8 text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fontStyleOptions.map(option => (
                      <SelectItem key={option.value} value={option.value} className="text-body">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <div className="text-body font-medium text-muted-foreground">
                  {t('view:preferencePanel.fontWeight')}
                </div>
                <Select value={tableFontWeight} onValueChange={onFontWeightChange}>
                  <SelectTrigger className="h-8 text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fontWeightOptions.map(option => (
                      <SelectItem key={option.value} value={option.value} className="text-body">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-body font-medium text-muted-foreground">
                  <span>{t('view:preferencePanel.fontSize')}</span>
                  <span className="tabular-nums text-foreground">{tableFontSize}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={FONT_SIZE_OPTIONS.length - 1}
                  step={1}
                  value={selectedFontSizeIndex}
                  onChange={handleFontSizeSliderChange}
                  className="h-1 w-full cursor-pointer accent-primary"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-body font-medium text-muted-foreground">
                  <span>{t('view:preferencePanel.rowHeight')}</span>
                  <span className="text-foreground">
                    {t(ROW_HEIGHT_OPTIONS[rowHeightSliderIndex]?.key ?? selectedRowHeightLabelKey)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={ROW_HEIGHT_OPTIONS.length - 1}
                  step={1}
                  value={rowHeightSliderIndex}
                  onChange={handleRowHeightSliderChange}
                  onMouseUp={commitRowHeightSlider}
                  onTouchEnd={commitRowHeightSlider}
                  onKeyUp={commitRowHeightSlider}
                  onBlur={commitRowHeightSlider}
                  disabled={!canPersistRowHeightToView}
                  className="h-1 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
                {!canPersistRowHeightToView ? (
                  <p className="text-caption text-muted-foreground">
                    {t('view:preferencePanel.rowHeightReadonlyHint')}
                  </p>
                ) : null}
              </div>
            </div>
          </PopoverContent>
        </Popover>,
        )}

        {/* ---- Card Config / Calendar Config / Edit View ---- */}
        {wrapToolbarAction(
          'cardConfig',
          !isReadonly
            ? renderPlainActionTooltip(
                getViewActionTooltip(t('view:actions.cardConfig')),
                <ToolBarButton
                  icon={<LayoutGrid className="h-3.5 w-3.5" />}
                  label={t('view:actions.cardConfig')}
                  labelClassName={toolbarButtonLabelClassName}
                  title={getViewActionTooltip(t('view:actions.cardConfig'))}
                  disabled={!canPersistSharedViewConfig || !currentView}
                  onClick={() => {
                    if (!currentView || !canPersistSharedViewConfig) return
                    openViewEditor('typeConfig')
                  }}
                />,
              )
            : null,
        )}

        {wrapToolbarAction(
          'calendarConfig',
          !isReadonly
            ? renderPlainActionTooltip(
                getViewActionTooltip(t('view:actions.calendarConfig')),
                <ToolBarButton
                  icon={<Calendar className="h-3.5 w-3.5" />}
                  label={t('view:actions.calendarConfig')}
                  labelClassName={toolbarButtonLabelClassName}
                  title={getViewActionTooltip(t('view:actions.calendarConfig'))}
                  disabled={!canPersistSharedViewConfig || !currentView}
                  onClick={() => {
                    if (!currentView || !canPersistSharedViewConfig) return
                    openViewEditor('typeConfig')
                  }}
                />,
              )
            : null,
        )}

        {wrapToolbarAction(
          'editView',
          !isReadonly
            ? renderPlainActionTooltip(
                getViewActionTooltip(t('view:actions.editView')),
                <ToolBarButton
                  icon={<Settings2 className="h-3.5 w-3.5" />}
                  label={t('view:actions.editView')}
                  labelClassName={toolbarButtonLabelClassName}
                  title={getViewActionTooltip(t('view:actions.editView'))}
                  disabled={!canPersistSharedViewConfig || !currentView}
                  onClick={() => {
                    if (!currentView || !canPersistSharedViewConfig) return
                    openViewEditor('full')
                  }}
                />,
              )
            : null,
        )}

      </div>

      {!isReadonly && currentView && (
        <ViewEditorDialog
          mode="edit"
          open={viewEditorOpen}
          onOpenChange={setViewEditorOpen}
          fields={fields}
          initialView={currentView}
          focus={viewEditorFocus}
          isSubmitting={isViewEditorSubmitting}
          onSubmit={handleViewEditorSubmit}
        />
      )}

      {/* ---- Save As Dialog ---- */}
      {!isReadonly && (
        <SaveAsViewDialog
          open={controller.saveAsOpen}
          onOpenChange={controller.setSaveAsOpen}
          name={controller.saveAsName}
          onNameChange={controller.setSaveAsName}
          onSave={controller.handleSaveAs}
          translate={stableTranslate}
        />
      )}
    </div>
  )
}
