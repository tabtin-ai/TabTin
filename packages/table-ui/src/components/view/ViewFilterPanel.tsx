import React, { useMemo } from 'react'
import type { Field, ViewFilter, ViewFilterLogic } from '../../types'
import type { ViewFilterEditorUserOption } from './ViewFilterRulesEditor'
import {
  ViewFilterPopover,
  type FilterOperatorTexts,
  type FilterPanelTexts,
} from './ViewFilterPopover'

interface ViewFilterPanelStoreSlice {
  initializeDraft: (viewId: string) => void
  setDraftFilters: (viewId: string, filters: ViewFilter[]) => void
  setDraftFilterLogic: (viewId: string, logic: ViewFilterLogic) => void
  applyDraft: (viewId: string) => Promise<void>
}

interface ViewFilterDraftSlice {
  filters?: ViewFilter[]
  filter_logic?: ViewFilterLogic
}

export interface ViewFilterPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewId: string | null
  fields: Field[]
  footer?: React.ReactNode
  triggerTooltip?: React.ReactNode
  children?: React.ReactNode
  store: ViewFilterPanelStoreSlice
  draft: ViewFilterDraftSlice | undefined
  translate: (key: string, options?: Record<string, unknown>) => string
  userOptions?: ViewFilterEditorUserOption[]
  disabled?: boolean
}

const buildOperatorTexts = (t: ViewFilterPanelProps['translate']): FilterOperatorTexts => ({
  common: {
    is: t('view:operators.common.is'),
    contains: t('view:operators.common.contains'),
    not_contains: t('view:operators.common.not_contains'),
    equals: t('view:operators.common.equals'),
    not_equals: t('view:operators.common.not_equals'),
    in: t('view:operators.common.in'),
    not_in: t('view:operators.common.not_in'),
    is_empty: t('view:operators.common.is_empty'),
    is_not_empty: t('view:operators.common.is_not_empty'),
  },
  number: {
    greater_than: t('view:operators.number.greater_than'),
    greater_than_or_equals: t('view:operators.number.greater_than_or_equals'),
    less_than: t('view:operators.number.less_than'),
    less_than_or_equals: t('view:operators.number.less_than_or_equals'),
  },
  date: {
    greater_than: t('view:operators.date.greater_than'),
    greater_than_or_equals: t('view:operators.date.greater_than_or_equals'),
    less_than: t('view:operators.date.less_than'),
    less_than_or_equals: t('view:operators.date.less_than_or_equals'),
    is_within: t('view:operators.date.is_within'),
  },
  select: {
    any_of: t('view:operators.select.any_of'),
    none_of: t('view:operators.select.none_of'),
  },
  multiSelect: {
    has_any_of: t('view:operators.multi_select.has_any_of'),
    has_all_of: t('view:operators.multi_select.has_all_of'),
    has_none_of: t('view:operators.multi_select.has_none_of'),
    is_exactly: t('view:operators.multi_select.is_exactly'),
    is_not_exactly: t('view:operators.multi_select.is_not_exactly'),
  },
})

const buildPanelTexts = (t: ViewFilterPanelProps['translate']): FilterPanelTexts => ({
  logicLabel: String(t('view:filterPanel.logicLabel')),
  logicAnd: String(t('view:filterPanel.logicAnd')),
  logicOr: String(t('view:filterPanel.logicOr')),
  title: String(t('view:filterPanel.title')),
  empty: String(t('view:filterPanel.empty')),
  add: String(t('view:filterPanel.add')),
  remove: String(t('common:delete')),
  fieldPlaceholder: String(t('view:filterPanel.fieldPlaceholder')),
  operatorPlaceholder: String(t('view:filterPanel.operatorPlaceholder')),
  valuePlaceholder: String(t('view:filterPanel.valuePlaceholder')),
  multiValuePlaceholder: String(t('view:filterPanel.multiValuePlaceholder')),
  numberPlaceholder: String(t('view:filterPanel.numberPlaceholder')),
  datePlaceholder: String(t('view:filterPanel.datePlaceholder')),
  dateTimePlaceholder: String(t('view:filterPanel.dateTimePlaceholder')),
  datePresetExact: String(t('view:filterPanel.datePresetExact')),
  datePresetToday: String(t('view:filterPanel.datePresetToday')),
  datePresetTomorrow: String(t('view:filterPanel.datePresetTomorrow')),
  datePresetYesterday: String(t('view:filterPanel.datePresetYesterday')),
  datePresetThisWeek: String(t('view:filterPanel.datePresetThisWeek')),
  datePresetLastWeek: String(t('view:filterPanel.datePresetLastWeek')),
  datePresetThisMonth: String(t('view:filterPanel.datePresetThisMonth')),
  datePresetLastMonth: String(t('view:filterPanel.datePresetLastMonth')),
  datePresetPast7Days: String(t('view:filterPanel.datePresetPast7Days')),
  datePresetNext7Days: String(t('view:filterPanel.datePresetNext7Days')),
  datePresetPast30Days: String(t('view:filterPanel.datePresetPast30Days')),
  datePresetNext30Days: String(t('view:filterPanel.datePresetNext30Days')),
  booleanTrue: String(t('view:filterPanel.booleanTrue')),
  booleanFalse: String(t('view:filterPanel.booleanFalse')),
  selectValuePlaceholder: String(t('view:filterPanel.selectValuePlaceholder')),
  emptyOption: String(t('view:filterPanel.emptyOption')),
  enabledLabel: String(t('view:filterPanel.enabledLabel')),
  searchPlaceholder: String(t('view:filterPanel.searchPlaceholder')),
  noResults: String(t('view:filterPanel.noResults')),
})

export const ViewFilterPanel: React.FC<ViewFilterPanelProps> = ({
  open,
  onOpenChange,
  viewId,
  fields,
  footer,
  triggerTooltip,
  children,
  store,
  draft,
  translate,
  userOptions,
  disabled = false,
}) => {
  const operatorTexts = useMemo(() => buildOperatorTexts(translate), [translate])
  const panelTexts = useMemo(() => buildPanelTexts(translate), [translate])

  return (
    <ViewFilterPopover
      open={open}
      onOpenChange={onOpenChange}
      viewId={viewId}
      fields={fields}
      draft={draft}
      store={store}
      operatorTexts={operatorTexts}
      texts={panelTexts}
      userOptions={userOptions}
      disabled={disabled}
      footer={footer}
      triggerTooltip={triggerTooltip}
    >
      {children}
    </ViewFilterPopover>
  )
}
