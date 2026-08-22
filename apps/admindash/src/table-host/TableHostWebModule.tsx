import { spaceAdminApi } from '@/api/space-admin'
import { TableHostContextCard } from '@/table-host/TableHostContextCard'
import { TableHostDataPreviewCard } from '@/table-host/TableHostDataPreviewCard'
import { TableHostHeaderBar } from '@/table-host/TableHostHeaderBar'
import { TableHostMetricsCard } from '@/table-host/TableHostMetricsCard'
import { TableHostRecordCrudCard } from '@/table-host/TableHostRecordCrudCard'
import { TableHostViewEditorPanel } from '@/table-host/TableHostViewEditorPanel'
import {
  hasAccessToken as hasStoredAccessToken,
  normalizeRouteParam,
  readSavedContext,
  saveContext,
} from '@/table-host/context-storage'
import { formatCellValue, getFieldChoices } from '@/table-host/record-draft-utils'
import { ensureTableWebRuntime } from '@/table-host/runtime/table-web-runtime'
import { useTableHostData } from '@/table-host/useTableHostData'
import { useTableHostRecordActions } from '@/table-host/useTableHostRecordActions'
import { toErrorMessage } from '@/table-host/value-utils'
import type { SpaceSummary, OrganizationSummary } from '@/types/space-admin'
import {
  isAttachmentFieldType,
  useDataGridDataset,
  useViewContainerState,
} from '@tabtin/table-ui'
import { useCallback, useEffect, useMemo, useState } from 'react'

const DEFAULT_PAGE_SIZE = 100

type GridRow = Record<string, unknown> & {
  id: string
  __rowType?: string
  __groupLabel?: string
  __groupCount?: number
  __groupLevel?: number
}

export interface TableHostWebModuleProps {
  organizationId?: string | null
  spaceId?: string | null
  currentPathname?: string
  onNavigateToContext?: (organizationId: string, spaceId: string) => void
  onNavigateToLogin?: (fromPathname: string) => void
}

export function TableHostWebModule({
  organizationId: routeOrganizationIdInput,
  spaceId: routeSpaceIdInput,
  currentPathname = '/table-host-web',
  onNavigateToContext,
  onNavigateToLogin,
}: TableHostWebModuleProps) {
  const savedContext = useMemo(() => readSavedContext(), [])
  const routeOrganizationId = normalizeRouteParam(routeOrganizationIdInput ?? undefined)
  const routeSpaceId = normalizeRouteParam(routeSpaceIdInput ?? undefined)
  const hasRouteContext = Boolean(routeOrganizationId && routeSpaceId)
  const initialContext = hasRouteContext
    ? { organizationId: routeOrganizationId, spaceId: routeSpaceId }
    : savedContext

  const [organizationIdInput, setOrganizationIdInput] = useState(initialContext.organizationId)
  const [spaceIdInput, setSpaceIdInput] = useState(initialContext.spaceId)
  const [activeOrganizationId, setActiveOrganizationId] = useState(initialContext.organizationId)
  const [activeSpaceId, setActiveSpaceId] = useState(initialContext.spaceId)
  const [refreshTick, setRefreshTick] = useState(0)

  const [hasAccessToken, setHasAccessToken] = useState(() => hasStoredAccessToken())
  const [organizationOptions, setOrganizationOptions] = useState<OrganizationSummary[]>([])
  const [spaceOptions, setSpaceOptions] = useState<SpaceSummary[]>([])
  const [organizationOptionsLoading, setOrganizationOptionsLoading] = useState(false)
  const [spaceOptionsLoading, setSpaceOptionsLoading] = useState(false)

  const {
    tables,
    selectedTableId,
    setSelectedTableId,
    fields,
    views,
    selectedViewId,
    setSelectedViewId,
    records,
    viewRecords,
    tablesLoading,
    metadataLoading,
    recordsLoading,
    error,
    setError,
    resetData,
  } = useTableHostData({
    hasAccessToken,
    activeOrganizationId,
    activeSpaceId,
    refreshTick,
    pageSize: DEFAULT_PAGE_SIZE,
  })

  useEffect(() => {
    ensureTableWebRuntime()
  }, [])

  useEffect(() => {
    const syncTokenState = () => {
      setHasAccessToken(hasStoredAccessToken())
    }

    syncTokenState()
    window.addEventListener('storage', syncTokenState)
    window.addEventListener('focus', syncTokenState)

    return () => {
      window.removeEventListener('storage', syncTokenState)
      window.removeEventListener('focus', syncTokenState)
    }
  }, [])

  useEffect(() => {
    if (!hasAccessToken) {
      setOrganizationOptions([])
      setSpaceOptions([])
      return
    }

    let cancelled = false
    const loadOrganizationOptions = async () => {
      setOrganizationOptionsLoading(true)
      try {
        const response = await spaceAdminApi.listOrganizations({ pageSize: 100 })
        if (cancelled) {
          return
        }

        setOrganizationOptions(response.organizations ?? [])
      } catch (loadError) {
        if (cancelled) {
          return
        }
        setOrganizationOptions([])
        setError(`加载组织失败：${toErrorMessage(loadError)}`)
      } finally {
        if (!cancelled) {
          setOrganizationOptionsLoading(false)
        }
      }
    }

    void loadOrganizationOptions()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, setError])

  useEffect(() => {
    if (!hasAccessToken) {
      setSpaceOptions([])
      return
    }

    const currentOrganizationId = organizationIdInput.trim()
    if (!currentOrganizationId) {
      setSpaceOptions([])
      return
    }

    let cancelled = false
    const loadSpaceOptions = async () => {
      setSpaceOptionsLoading(true)
      try {
        const response = await spaceAdminApi.listSpaces({
          organizationId: currentOrganizationId,
          page: 1,
          pageSize: 100,
        })

        if (cancelled) {
          return
        }

        const nextSpaces = response.spaces ?? []
        setSpaceOptions(nextSpaces)

        if (nextSpaces.length > 0) {
          setSpaceIdInput((previousSpaceId) =>
            previousSpaceId.trim() ? previousSpaceId : nextSpaces[0].id
          )
        }
      } catch (loadError) {
        if (cancelled) {
          return
        }
        setSpaceOptions([])
        setError(`加载 Space 失败：${toErrorMessage(loadError)}`)
      } finally {
        if (!cancelled) {
          setSpaceOptionsLoading(false)
        }
      }
    }

    void loadSpaceOptions()

    return () => {
      cancelled = true
    }
  }, [hasAccessToken, organizationIdInput, setError])

  useEffect(() => {
    if (!hasRouteContext) {
      return
    }

    if (activeOrganizationId === routeOrganizationId && activeSpaceId === routeSpaceId) {
      return
    }

    setOrganizationIdInput(routeOrganizationId)
    setSpaceIdInput(routeSpaceId)
    setActiveOrganizationId(routeOrganizationId)
    setActiveSpaceId(routeSpaceId)
    resetData()
    setError(null)
    setRefreshTick((prev) => prev + 1)
  }, [
    hasRouteContext,
    routeOrganizationId,
    routeSpaceId,
    activeOrganizationId,
    activeSpaceId,
    resetData,
    setError,
  ])

  useEffect(() => {
    saveContext({
      organizationId: organizationIdInput,
      spaceId: spaceIdInput,
    })
  }, [organizationIdInput, spaceIdInput])

  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? null,
    [tables, selectedTableId]
  )
  const availableFieldOptions = useMemo(
    () =>
      fields.map((field) => ({
        id: field.id,
        name: field.name,
        fieldType: String(field.field_type),
        isHidden: field.is_hidden,
        options: field.options as Record<string, unknown> | undefined,
      })),
    [fields]
  )
  const availableFieldIds = useMemo(
    () => availableFieldOptions.map((field) => field.id),
    [availableFieldOptions]
  )
  const selectedView = useMemo(
    () => views.find((view) => view.id === selectedViewId) ?? null,
    [views, selectedViewId]
  )

  const viewState = useViewContainerState({
    views,
    currentViewId: selectedViewId,
    currentViewRecords: viewRecords,
    isRecordsLoading: recordsLoading,
  })

  const dataset = useDataGridDataset({
    fields,
    currentView: viewState.currentView,
    currentViewRecords: viewRecords,
    records,
    useViewData: Boolean(viewState.currentView?.id),
    collapsedGroupIds: [],
    isRecordsLoading: recordsLoading,
    isRecordLoading: recordsLoading,
    recordsQueryPage: viewRecords?.page ?? 1,
    recordsQueryPageSize: viewRecords?.page_size ?? DEFAULT_PAGE_SIZE,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    total: records.length,
    t: (key: string) => (key === 'table:group.ungrouped' ? '未分组' : key),
    locale: 'zh-CN',
  })

  const displayRows = dataset.groupedRows as GridRow[]
  const isBusy = tablesLoading || metadataLoading || viewState.shouldShowLoading

  const editableFields = useMemo(
    () => dataset.orderedFields.filter((field) => !isAttachmentFieldType(field.field_type)),
    [dataset.orderedFields]
  )

  const refreshData = useCallback(() => {
    setRefreshTick((prev) => prev + 1)
  }, [])

  const recordActions = useTableHostRecordActions({
    hasAccessToken,
    selectedTableId,
    selectedViewId,
    records,
    orderedFields: dataset.orderedFields,
    editableFields,
    onRefresh: refreshData,
  })

  const handleApplyContext = () => {
    const nextOrganizationId = organizationIdInput.trim()
    const nextSpaceId = spaceIdInput.trim()

    if (!hasAccessToken) {
      setError('未检测到 access_token，请先登录后再加载数据')
      return
    }

    if (!nextOrganizationId || !nextSpaceId) {
      setError('organizationId 和 spaceId 均为必填')
      return
    }

    setError(null)
    recordActions.clearActionFeedback()
    recordActions.resetRecordContext()
    setActiveOrganizationId(nextOrganizationId)
    setActiveSpaceId(nextSpaceId)
    resetData()
    refreshData()

    onNavigateToContext?.(nextOrganizationId, nextSpaceId)
  }

  const handleOrganizationSelect = (nextOrganizationId: string) => {
    setOrganizationIdInput(nextOrganizationId)

    if (organizationIdInput.trim() !== nextOrganizationId.trim()) {
      setSpaceIdInput('')
    }
  }

  const handleSpaceSelect = (nextSpaceId: string) => {
    setSpaceIdInput(nextSpaceId)
  }

  const contextOptionsLoading = organizationOptionsLoading || spaceOptionsLoading

  return (
    <div className="panel-container">
      <TableHostHeaderBar hasAccessToken={hasAccessToken} isBusy={isBusy} onRefresh={refreshData} />

      <div className="flex-1 overflow-auto space-y-4 bg-muted/5 p-4">
        <TableHostContextCard
          hasAccessToken={hasAccessToken}
          currentPathname={currentPathname}
          organizationIdInput={organizationIdInput}
          spaceIdInput={spaceIdInput}
          activeOrganizationId={activeOrganizationId}
          activeSpaceId={activeSpaceId}
          isApplying={tablesLoading}
          contextOptionsLoading={contextOptionsLoading}
          organizationOptions={organizationOptions}
          spaceOptions={spaceOptions}
          onOrganizationIdInputChange={setOrganizationIdInput}
          onSpaceIdInputChange={setSpaceIdInput}
          onOrganizationSelect={handleOrganizationSelect}
          onSpaceSelect={handleSpaceSelect}
          onApplyContext={handleApplyContext}
          onNavigateToLogin={onNavigateToLogin}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <TableHostDataPreviewCard
            hasAccessToken={hasAccessToken}
            isBusy={isBusy}
            error={error}
            tables={tables}
            selectedTableId={selectedTableId}
            selectedViewId={selectedViewId}
            views={views}
            selectedTable={selectedTable}
            orderedFields={dataset.orderedFields}
            displayRows={displayRows}
            selectedRecordId={recordActions.selectedRecordId}
            onSelectTable={setSelectedTableId}
            onSelectView={setSelectedViewId}
            onSelectRecord={recordActions.handleSelectRecord}
            formatCellValue={formatCellValue}
          />

          <div className="space-y-4">
            <TableHostRecordCrudCard
              hasAccessToken={hasAccessToken}
              isBusy={isBusy}
              selectedTable={selectedTable}
              selectedTableId={selectedTableId}
              selectedRecordId={recordActions.selectedRecordId}
              selectedRecord={recordActions.selectedRecord}
              formMode={recordActions.formMode}
              actionLoading={recordActions.actionLoading}
              deleteLoading={recordActions.deleteLoading}
              actionError={recordActions.actionError}
              actionMessage={recordActions.actionMessage}
              recordDraft={recordActions.recordDraft}
              orderedFields={dataset.orderedFields}
              onSetFormMode={recordActions.setFormMode}
              onDraftChange={recordActions.handleDraftChange}
              onCreateRecord={recordActions.handleCreateRecord}
              onUpdateRecord={recordActions.handleUpdateRecord}
              onDeleteRecord={recordActions.handleDeleteRecord}
              onResetDraft={recordActions.handleResetDraft}
              getFieldChoices={getFieldChoices}
            />

            <TableHostViewEditorPanel
              hasAccessToken={hasAccessToken}
              isBusy={isBusy}
              selectedViewId={selectedViewId}
              selectedView={selectedView}
              availableFieldOptions={availableFieldOptions}
              availableFieldIds={availableFieldIds}
              onSaved={refreshData}
            />

            <TableHostMetricsCard
              tablesCount={tables.length}
              fieldsCount={dataset.orderedFields.length}
              recordsCount={dataset.totalCount}
              currentViewName={viewState.currentView?.name ?? '默认记录流'}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
