import { Button } from '@/components/ui/button'
import type { ViewVisibilityPanelProps } from '@/table-host/view-editor/types'
import { useMemo } from 'react'

export function ViewVisibilityPanel({
  availableFieldOptions,
  normalizedVisibleFieldIdsDraft,
  normalizedFieldOrderDraft,
  isViewEditorDisabled,
  onSelectAllVisibleFields,
  onClearVisibleFields,
  onToggleVisibleField,
  onReorderFieldByTableSequence,
  onMoveFieldOrder,
}: ViewVisibilityPanelProps) {
  const fieldOptionById = useMemo(
    () => new Map(availableFieldOptions.map((field) => [field.id, field] as const)),
    [availableFieldOptions]
  )

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-body text-muted-foreground">字段可见性（勾选可见字段）</div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onSelectAllVisibleFields}
              disabled={isViewEditorDisabled}
            >
              全选
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onClearVisibleFields}
              disabled={isViewEditorDisabled}
            >
              清空
            </Button>
          </div>
        </div>
        <div className="max-h-[180px] space-y-1 overflow-auto rounded-md border bg-background p-2">
          {availableFieldOptions.length === 0 && (
            <div className="px-1 py-2 text-body text-muted-foreground">当前表暂无字段</div>
          )}

          {availableFieldOptions.map((field) => {
            const checked = normalizedVisibleFieldIdsDraft.includes(field.id)
            return (
              <label
                key={`visible-${field.id}`}
                className="flex items-center justify-between gap-2 rounded px-2 py-1 text-body hover:bg-muted/30"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{field.name}</div>
                  <div className="text-caption text-muted-foreground">{field.fieldType}</div>
                </div>
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={checked}
                  onChange={(event) => onToggleVisibleField(field.id, event.target.checked)}
                  disabled={isViewEditorDisabled}
                />
              </label>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-body text-muted-foreground">field_order（可见字段顺序）</div>
          <Button
            size="sm"
            variant="outline"
            onClick={onReorderFieldByTableSequence}
            disabled={isViewEditorDisabled || normalizedVisibleFieldIdsDraft.length === 0}
          >
            按表结构顺序
          </Button>
        </div>
        <div className="max-h-[180px] space-y-1 overflow-auto rounded-md border bg-background p-2">
          {normalizedFieldOrderDraft.length === 0 && (
            <div className="px-1 py-2 text-body text-muted-foreground">
              当前没有可排序字段，请先在上方选择可见字段。
            </div>
          )}

          {normalizedFieldOrderDraft.map((fieldId, index) => {
            const field = fieldOptionById.get(fieldId)
            return (
              <div
                key={`order-${fieldId}`}
                className="flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-body"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">
                    {index + 1}. {field?.name ?? fieldId}
                  </div>
                  <div className="text-caption text-muted-foreground">
                    {field?.fieldType ?? 'unknown'}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onMoveFieldOrder(fieldId, 'up')}
                    disabled={isViewEditorDisabled || index === 0}
                  >
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onMoveFieldOrder(fieldId, 'down')}
                    disabled={
                      isViewEditorDisabled || index === normalizedFieldOrderDraft.length - 1
                    }
                  >
                    下移
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
