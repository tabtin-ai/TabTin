import { FILTER_OPERATOR_OPTIONS } from '@/table-host/view-config-editor'
import type { ViewFiltersPanelProps } from '@/table-host/view-editor/types'
import type { ViewFilterEditorRule } from '@tabtin/table-ui'
import { ViewFilterRulesEditor } from '@tabtin/table-ui'

const stringifyFilterValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ')
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function ViewFiltersPanel({
  availableFieldOptions,
  viewFilterItems,
  isViewEditorDisabled,
  onAddFilter,
  onRemoveFilter,
  onUpdateFilter,
}: ViewFiltersPanelProps) {
  const editorRules: ViewFilterEditorRule[] = viewFilterItems.map((item) => ({
    id: item.id,
    fieldId: item.fieldId,
    operator: item.operator,
    value: item.valueText,
    enabled: item.enabled,
  }))

  return (
    <div className="space-y-2">
      <ViewFilterRulesEditor
        fields={availableFieldOptions}
        rules={editorRules}
        operatorOptions={FILTER_OPERATOR_OPTIONS}
        disabled={isViewEditorDisabled}
        onAddRule={onAddFilter}
        onRemoveRule={onRemoveFilter}
        onUpdateRule={(ruleId, patch) => {
          const mappedPatch: Partial<{
            fieldId: string
            operator: string
            valueText: string
            enabled: boolean
          }> = {}

          if (patch.fieldId !== undefined) {
            mappedPatch.fieldId = patch.fieldId
          }
          if (patch.operator !== undefined) {
            mappedPatch.operator = patch.operator
          }
          if (patch.value !== undefined) {
            mappedPatch.valueText = stringifyFilterValue(patch.value)
          }
          if (patch.enabled !== undefined) {
            mappedPatch.enabled = patch.enabled
          }

          onUpdateFilter(ruleId, mappedPatch)
        }}
        texts={{
          title: 'filters（结构化筛选）',
          empty: '当前没有筛选条件',
          add: '新增筛选',
          remove: '删除',
          fieldPlaceholder: '请选择字段',
          operatorPlaceholder: '请选择操作符',
          valuePlaceholder: '值（支持纯文本或 JSON，如 {"a":1}）',
          multiValuePlaceholder: '值（逗号分隔多个选项）',
          numberPlaceholder: '请输入数字',
          datePlaceholder: 'YYYY-MM-DD',
          dateTimePlaceholder: 'YYYY-MM-DD HH:mm:ss',
          booleanTrue: 'true',
          booleanFalse: 'false',
          selectValuePlaceholder: '请选择值',
          emptyOption: '空值',
          enabledLabel: '启用该筛选',
        }}
      />
    </div>
  )
}
