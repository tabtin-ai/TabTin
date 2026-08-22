import React, { useState } from 'react'
import * as t from '../../theme'
import { PanelWrapper } from './shared'

type Translate = (key: string, options?: Record<string, unknown>) => string

const MAX_ROWS = 8
const MAX_COLS = 8
const CELL_SIZE = 24
const CELL_GAP = 3
const TABLE_PANEL_HORIZONTAL_PADDING = 32
const TABLE_PANEL_WIDTH = CELL_SIZE * MAX_COLS + CELL_GAP * (MAX_COLS - 1) + TABLE_PANEL_HORIZONTAL_PADDING

export const TableGridPicker: React.FC<{
  onInsert: (rows: number, cols: number) => void
  translate: Translate
  width?: React.CSSProperties['width']
}> = ({ onInsert, translate, width = TABLE_PANEL_WIDTH }) => {
  const [hoverRow, setHoverRow] = useState(0)
  const [hoverCol, setHoverCol] = useState(0)

  return (
    <PanelWrapper width={width}>
      <div style={{ padding: '12px 16px 10px' }}>
        <div style={{
          fontSize: 13,
          fontWeight: 400,
          color: hoverRow > 0 ? t.textPrimary : t.textSecondary,
          marginBottom: 10,
          textAlign: 'center',
          height: 18,
          lineHeight: '18px',
          transition: 'color 0.12s ease',
        }}>
          {hoverRow > 0
            ? translate('insert.table.preview', { rows: hoverRow, cols: hoverCol })
            : translate('insert.table.chooseSize')}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${MAX_COLS}, minmax(0, 1fr))`,
            gap: CELL_GAP,
          }}
          onMouseLeave={() => { setHoverRow(0); setHoverCol(0) }}
        >
          {Array.from({ length: MAX_ROWS * MAX_COLS }, (_, i) => {
            const r = Math.floor(i / MAX_COLS) + 1
            const c = (i % MAX_COLS) + 1
            const active = r <= hoverRow && c <= hoverCol

            return (
              <div
                key={i}
                onMouseEnter={() => { setHoverRow(r); setHoverCol(c) }}
                onClick={() => onInsert(r, c)}
                style={{
                  aspectRatio: '1 / 1',
                  minWidth: 0,
                  borderRadius: t.radiusSm,
                  border: `1px solid ${active ? t.accent : t.border}`,
                  background: active ? t.accentBg : 'transparent',
                  cursor: 'pointer',
                  transition: 'background 0.1s ease, border-color 0.1s ease',
                }}
              />
            )
          })}
        </div>
        <div style={{
          fontSize: 12,
          color: t.textSecondary,
          textAlign: 'center',
          marginTop: 10,
          lineHeight: 1,
        }}>
          max {MAX_ROWS}×{MAX_COLS}
        </div>
      </div>
    </PanelWrapper>
  )
}
