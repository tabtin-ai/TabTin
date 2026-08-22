import React from 'react'
import type { PPTTableElement } from '../../types/slides'
import * as t from '../../theme'
import { useT } from '../../i18n'
import { useTableCellEditor } from '../../hooks/useTableCellEditor'
import TableDisplay from './TableDisplay'

interface TableElementProps {
  element: PPTTableElement
}

const TableElement: React.FC<TableElementProps> = ({ element }) => {
  const translate = useT()

  if (!Array.isArray(element.data) || element.data.length === 0) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textTertiary, fontSize: 12 }}>
        {translate('insert.table.title')}
      </div>
    )
  }

  return <TableElementContent element={element} />
}

const TableElementContent: React.FC<TableElementProps> = ({ element }) => {
  const editor = useTableCellEditor(element)
  return <TableDisplay element={element} editor={editor} />
}

export default React.memo(TableElement)
