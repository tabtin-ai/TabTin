import type {
  FilterEditorItem,
  GroupEditorItem,
  SortEditorItem,
} from '@/table-host/view-config-editor'

export interface FieldOption {
  id: string
  name: string
  fieldType: string
  isHidden?: boolean
  options?: Record<string, unknown>
}

export interface ViewVisibilityPanelProps {
  availableFieldOptions: FieldOption[]
  normalizedVisibleFieldIdsDraft: string[]
  normalizedFieldOrderDraft: string[]
  isViewEditorDisabled: boolean
  onSelectAllVisibleFields: () => void
  onClearVisibleFields: () => void
  onToggleVisibleField: (fieldId: string, checked: boolean) => void
  onReorderFieldByTableSequence: () => void
  onMoveFieldOrder: (fieldId: string, direction: 'up' | 'down') => void
}

export interface ViewFiltersPanelProps {
  availableFieldOptions: FieldOption[]
  viewFilterItems: FilterEditorItem[]
  isViewEditorDisabled: boolean
  onAddFilter: () => void
  onRemoveFilter: (itemId: string) => void
  onUpdateFilter: (
    itemId: string,
    patch: Partial<Pick<FilterEditorItem, 'fieldId' | 'operator' | 'valueText' | 'enabled'>>
  ) => void
}

export interface ViewSortsPanelProps {
  availableFieldOptions: FieldOption[]
  viewSortItems: SortEditorItem[]
  isViewEditorDisabled: boolean
  onAddSort: () => void
  onRemoveSort: (itemId: string) => void
  onUpdateSort: (
    itemId: string,
    patch: Partial<Pick<SortEditorItem, 'fieldId' | 'direction'>>
  ) => void
}

export interface ViewGroupsPanelProps {
  availableFieldOptions: FieldOption[]
  viewGroupItems: GroupEditorItem[]
  isViewEditorDisabled: boolean
  onAddGroup: () => void
  onRemoveGroup: (itemId: string) => void
  onUpdateGroup: (
    itemId: string,
    patch: Partial<Pick<GroupEditorItem, 'fieldId' | 'direction'>>
  ) => void
}
