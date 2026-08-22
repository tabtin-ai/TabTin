/**
 * Electron GridToolbarMainBar — thin wrapper around @tabtin/table-ui shared component.
 * Injects Electron-specific ViewFilterGroupBar as a slot.
 */
import React from 'react'
import {
  GridToolbarMainBar as SharedGridToolbarMainBar,
  type GridToolbarMainBarProps as SharedProps,
} from '@tabtin/table-ui'
import type { Field } from '@tabtin/table-core'
import type { TableFontStyle, TableFontWeight, TableFontSize } from '@stores/useUIStore'
import { ViewFilterGroupBar } from '@/components/view/ViewFilterGroupBar'
import type { DataGridSearchScope } from '../DataGridContext'

interface GridToolbarMainBarProps extends Omit<SharedProps, 'filterGroupBar' | 'fields' | 'tableFontStyle' | 'tableFontWeight' | 'tableFontSize'> {
  fields: Field[]
  tableFontStyle: TableFontStyle
  tableFontWeight: TableFontWeight
  tableFontSize: TableFontSize
}

export { type DataGridSearchScope }

export const GridToolbarMainBar: React.FC<GridToolbarMainBarProps> = ({
  fields,
  tableFontStyle,
  tableFontWeight,
  tableFontSize,
  onFontStyleChange,
  onFontWeightChange,
  onFontSizeChange,
  isReadonly = false,
  ...rest
}) => {
  const toolbarFields = fields as SharedProps['fields']

  return (
    <SharedGridToolbarMainBar
      {...rest}
      isReadonly={isReadonly}
      fields={toolbarFields}
      tableFontStyle={tableFontStyle}
      tableFontWeight={tableFontWeight}
      tableFontSize={tableFontSize}
      onFontStyleChange={onFontStyleChange}
      onFontWeightChange={onFontWeightChange}
      onFontSizeChange={onFontSizeChange}
      filterGroupBar={
        <ViewFilterGroupBar
          fields={fields}
          tableFontStyle={tableFontStyle}
          tableFontWeight={tableFontWeight}
          tableFontSize={tableFontSize}
          onFontStyleChange={onFontStyleChange!}
          onFontWeightChange={onFontWeightChange!}
          onFontSizeChange={onFontSizeChange!}
          isReadonly={isReadonly}
          className="min-w-0"
        />
      }
    />
  )
}
