import React from 'react'
import { useTableStore } from '@stores/useTableStore'
import { useTableAppearanceStore } from '@stores/useTableAppearanceStore'
import { useViewStore } from '@stores/useViewStore'
import { useTableReadonly } from '@components/table/TableReadonlyContext'
import { ViewFilterGroupBar } from './ViewFilterGroupBar'
import { useViewToolbarController } from './controller/useViewToolbarController'
import { BaseToolbar } from '@components/table/toolbar/BaseToolbar'
import { useTranslation } from 'react-i18next'

interface ViewToolbarProps {
  className?: string
  onOpenTableHistory?: () => void
}

export const ViewToolbar: React.FC<ViewToolbarProps> = ({ className, onOpenTableHistory }) => {
  const { t } = useTranslation('view')
  const fields = useTableStore(state => state.fields)
  // 字体外观按 tableId 独立存储。
  const selectedTableId = useTableStore(state => state.selectedTable?.id ?? null)
  const tableAppearanceEntry = useTableAppearanceStore(state =>
    selectedTableId ? state.byTable[selectedTableId] : undefined,
  )
  const defaultAppearance = useTableAppearanceStore(state => state.defaultAppearance)
  const appearance = tableAppearanceEntry ?? defaultAppearance
  const tableFontStyle = appearance.style
  const tableFontWeight = appearance.weight
  const tableFontSize = appearance.size
  const setTableFontStyle = useTableAppearanceStore(state => state.setTableFontStyle)
  const setTableFontWeight = useTableAppearanceStore(state => state.setTableFontWeight)
  const setTableFontSize = useTableAppearanceStore(state => state.setTableFontSize)
  const currentViewId = useViewStore(state => state.currentViewId)
  const refreshCurrentView = useViewStore(state => state.refreshCurrentView)
  const { shouldShowToolbar } = useViewToolbarController({ currentViewId })
  const { isTableReadonly: tableReadonlyFromContext } = useTableReadonly()
  // isReadonly 语义是表级权限；视图配置锁定由 ViewFilterGroupBar / canConfigure 单独处理
  const isTableReadonly = tableReadonlyFromContext

  const handleFontStyleChange = React.useCallback(
    (value: string) => {
      if (!selectedTableId) return
      if (value === 'system' || value === 'serif' || value === 'mono' || value === 'rounded') {
        setTableFontStyle(selectedTableId, value)
      }
    },
    [selectedTableId, setTableFontStyle],
  )

  const handleFontWeightChange = React.useCallback(
    (value: string) => {
      if (!selectedTableId) return
      if (value === 'thin' || value === 'regular' || value === 'medium' || value === 'semibold') {
        setTableFontWeight(selectedTableId, value)
      } else if (value === 'bold') {
        setTableFontWeight(selectedTableId, 'semibold')
      }
    },
    [selectedTableId, setTableFontWeight],
  )

  const handleFontSizeChange = React.useCallback(
    (value: number | string) => {
      if (!selectedTableId) return
      const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
      if (parsed === 12 || parsed === 13 || parsed === 14 || parsed === 16) {
        setTableFontSize(selectedTableId, parsed)
      }
    },
    [selectedTableId, setTableFontSize],
  )

  if (!shouldShowToolbar) {
    return null
  }

  return (
    <BaseToolbar
      onRefresh={refreshCurrentView}
      searchDisabledHint={String(t('toolbar.searchComingSoon'))}
      onOpenTableHistory={onOpenTableHistory}
      isReadonly={isTableReadonly}
      className={className}
    >
      <ViewFilterGroupBar
        fields={fields}
        tableFontStyle={tableFontStyle}
        tableFontWeight={tableFontWeight}
        tableFontSize={tableFontSize}
        onFontStyleChange={handleFontStyleChange}
        onFontWeightChange={handleFontWeightChange}
        onFontSizeChange={handleFontSizeChange}
        isReadonly={isTableReadonly}
      />
    </BaseToolbar>
  )
}
