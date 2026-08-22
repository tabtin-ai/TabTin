import type { ViewGroupsPanelProps } from '@/table-host/view-editor/types'
import { ViewGroupRulesEditor } from '@tabtin/table-ui'

export function ViewGroupsPanel({
  availableFieldOptions,
  viewGroupItems,
  isViewEditorDisabled,
  onAddGroup,
  onRemoveGroup,
  onUpdateGroup,
}: ViewGroupsPanelProps) {
  return (
    <div className="space-y-2">
      <ViewGroupRulesEditor
        fields={availableFieldOptions}
        rules={viewGroupItems.map((item) => ({
          fieldId: item.fieldId,
          direction: item.direction,
        }))}
        disabled={isViewEditorDisabled}
        onAddRule={onAddGroup}
        onRemoveRule={(index) => {
          const target = viewGroupItems[index]
          if (!target) return
          onRemoveGroup(target.id)
        }}
        onUpdateRule={(index, patch) => {
          const target = viewGroupItems[index]
          if (!target) return
          onUpdateGroup(target.id, {
            fieldId: patch.fieldId ?? target.fieldId,
            direction: patch.direction ?? target.direction,
          })
        }}
        texts={{
          title: 'groups（结构化分组）',
          empty: '当前没有分组条件',
          add: '新增分组',
          remove: '删除',
          fieldPlaceholder: '请选择字段',
          orderAsc: '升序',
          orderDesc: '降序',
          moveUp: '上移',
          moveDown: '下移',
        }}
      />
    </div>
  )
}
