import type { ViewSortRulesEditorTexts } from '../components/view/ViewSortRulesEditor'

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

export const buildSortPanelTexts = (t: TranslateFn): ViewSortRulesEditorTexts => ({
  title: String(t('view:sortPanel.title')),
  empty: String(t('view:sortPanel.empty')),
  add: String(t('view:sortPanel.add')),
  remove: String(t('common:delete')),
  fieldPlaceholder: String(t('view:sortPanel.fieldPlaceholder')),
  orderAsc: String(t('view:sortPanel.directionAsc')),
  orderDesc: String(t('view:sortPanel.directionDesc')),
  orderAscNumber: String(t('view:sortPanel.directionAscNumber')),
  orderDescNumber: String(t('view:sortPanel.directionDescNumber')),
  orderAscDate: String(t('view:sortPanel.directionAscDate')),
  orderDescDate: String(t('view:sortPanel.directionDescDate')),
  orderAscSelect: String(t('view:sortPanel.directionAscSelect')),
  orderDescSelect: String(t('view:sortPanel.directionDescSelect')),
  searchPlaceholder: String(t('view:sortPanel.searchPlaceholder')),
  noResults: String(t('view:sortPanel.noResults')),
})
