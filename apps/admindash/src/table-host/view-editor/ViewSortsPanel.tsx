import { Button } from '@/components/ui/button'
import type { ViewSortsPanelProps } from '@/table-host/view-editor/types'

export function ViewSortsPanel({
  availableFieldOptions,
  viewSortItems,
  isViewEditorDisabled,
  onAddSort,
  onRemoveSort,
  onUpdateSort,
}: ViewSortsPanelProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-body text-muted-foreground">sorts（结构化排序）</div>
        <Button size="sm" variant="outline" onClick={onAddSort} disabled={isViewEditorDisabled}>
          新增排序
        </Button>
      </div>
      <div className="max-h-[220px] space-y-2 overflow-auto rounded-md border bg-background p-2">
        {viewSortItems.length === 0 && (
          <div className="px-1 py-2 text-body text-muted-foreground">当前没有排序条件</div>
        )}
        {viewSortItems.map((item, index) => (
          <div
            key={item.id}
            className="grid gap-2 rounded border px-2 py-2 md:grid-cols-[1fr_120px_64px]"
          >
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-body"
              value={item.fieldId}
              onChange={(event) => onUpdateSort(item.id, { fieldId: event.target.value })}
              disabled={isViewEditorDisabled}
            >
              <option value="">请选择字段</option>
              {availableFieldOptions.map((field) => (
                <option key={`sort-field-${field.id}`} value={field.id}>
                  {field.name}
                </option>
              ))}
            </select>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-body"
              value={item.direction}
              onChange={(event) =>
                onUpdateSort(item.id, {
                  direction: event.target.value === 'desc' ? 'desc' : 'asc',
                })
              }
              disabled={isViewEditorDisabled}
            >
              <option value="asc">升序</option>
              <option value="desc">降序</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onRemoveSort(item.id)}
              disabled={isViewEditorDisabled}
            >
              删除
            </Button>
            <div className="text-caption text-muted-foreground md:col-span-3">
              排序优先级：{index + 1}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
