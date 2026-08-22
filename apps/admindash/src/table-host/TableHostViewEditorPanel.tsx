import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTableHostViewEditorState } from '@/table-host/useTableHostViewEditorState'
import { ViewFiltersPanel } from '@/table-host/view-editor/ViewFiltersPanel'
import { ViewGroupsPanel } from '@/table-host/view-editor/ViewGroupsPanel'
import { ViewSortsPanel } from '@/table-host/view-editor/ViewSortsPanel'
import { ViewVisibilityPanel } from '@/table-host/view-editor/ViewVisibilityPanel'
import type { FieldOption } from '@/table-host/view-editor/types'
import type { ViewMeta } from '@tabtin/table-ui'
import { Save } from 'lucide-react'

interface TableHostViewEditorPanelProps {
  hasAccessToken: boolean
  isBusy: boolean
  selectedViewId: string | null
  selectedView: ViewMeta | null
  availableFieldOptions: FieldOption[]
  availableFieldIds: string[]
  onSaved: () => void
}

export function TableHostViewEditorPanel({
  hasAccessToken,
  isBusy,
  selectedViewId,
  selectedView,
  availableFieldOptions,
  availableFieldIds,
  onSaved,
}: TableHostViewEditorPanelProps) {
  const state = useTableHostViewEditorState({
    hasAccessToken,
    isBusy,
    selectedViewId,
    selectedView,
    availableFieldIds,
    onSaved,
  })

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-subtitle">视图交互配置</CardTitle>
        <CardDescription>
          通过 `ViewApiService.updateView` 编辑当前视图的 filters/sorts/groups 与字段可见性。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-background px-3 py-2 text-body text-muted-foreground">
          current view: {selectedView?.name ?? '未选择'}
          <br />
          status: {selectedView?.is_locked ? 'locked' : 'editable'}
          <br />
          visible fields: {state.normalizedVisibleFieldIdsDraft.length}/{availableFieldIds.length}
        </div>

        {!selectedViewId && (
          <div className="rounded-md border bg-background px-3 py-3 text-body text-muted-foreground">
            请选择一个视图后再编辑筛选/排序/分组配置。
          </div>
        )}

        {state.viewActionError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {state.viewActionError}
          </div>
        )}

        {state.viewActionMessage && (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-body text-success">
            {state.viewActionMessage}
          </div>
        )}

        <ViewVisibilityPanel
          availableFieldOptions={availableFieldOptions}
          normalizedVisibleFieldIdsDraft={state.normalizedVisibleFieldIdsDraft}
          normalizedFieldOrderDraft={state.normalizedFieldOrderDraft}
          isViewEditorDisabled={state.isViewEditorDisabled}
          onSelectAllVisibleFields={state.handleSelectAllVisibleFields}
          onClearVisibleFields={state.handleClearVisibleFields}
          onToggleVisibleField={state.handleToggleVisibleField}
          onReorderFieldByTableSequence={state.handleReorderFieldByTableSequence}
          onMoveFieldOrder={state.handleMoveFieldOrder}
        />

        <ViewFiltersPanel
          availableFieldOptions={availableFieldOptions}
          viewFilterItems={state.viewFilterItems}
          isViewEditorDisabled={state.isViewEditorDisabled}
          onAddFilter={state.handleAddFilter}
          onRemoveFilter={state.handleRemoveFilter}
          onUpdateFilter={state.handleUpdateFilter}
        />

        <ViewSortsPanel
          availableFieldOptions={availableFieldOptions}
          viewSortItems={state.viewSortItems}
          isViewEditorDisabled={state.isViewEditorDisabled}
          onAddSort={state.handleAddSort}
          onRemoveSort={state.handleRemoveSort}
          onUpdateSort={state.handleUpdateSort}
        />

        <ViewGroupsPanel
          availableFieldOptions={availableFieldOptions}
          viewGroupItems={state.viewGroupItems}
          isViewEditorDisabled={state.isViewEditorDisabled}
          onAddGroup={state.handleAddGroup}
          onRemoveGroup={state.handleRemoveGroup}
          onUpdateGroup={state.handleUpdateGroup}
        />

        <div className="flex items-center gap-2">
          <Button
            className="gap-1.5"
            onClick={state.handleSaveViewDraft}
            disabled={state.saveDisabled}
          >
            <Save className="h-3.5 w-3.5" />
            {state.viewActionLoading ? '保存中...' : '保存视图配置'}
          </Button>

          <Button
            variant="outline"
            onClick={state.handleResetViewDraft}
            disabled={state.resetDisabled}
          >
            重置草稿
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
