import React, { useCallback } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { executeAlign, getMovableAlignUnitCount } from '../utils/align'
import type { AlignCommand } from '../utils/align'
import type { PPTElement } from '../types/slides'
import * as t from '../theme'
import { useT } from '../i18n'

const AlignToolbar: React.FC = () => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const selectedElements = useSlideStore((s) => s.selectedElements)
  const updateElement = useSlideStore((s) => s.updateElement)

  const elements = selectedElements()
  const movableUnitCount = getMovableAlignUnitCount(elements)
  const canvasWidth = presentation?.canvasWidth || 1280
  const canvasHeight = presentation?.canvasHeight || 720

  const handleAlign = useCallback(
    (command: AlignCommand) => {
      if (movableUnitCount === 0) return
      const updates = executeAlign(command, elements, canvasWidth, canvasHeight)
      if (updates.length === 0) return

      const byId = new Map(elements.map((el) => [el.id, el] as const))
      const effectiveUpdates = updates.filter((u) => {
        const current = byId.get(u.id)
        if (!current) return false
        return Math.abs(current.x - u.x) > 0.001 || Math.abs(current.y - u.y) > 0.001
      })
      if (effectiveUpdates.length === 0) return

      const s = useSlideStore.getState()
      if (s.presentation) useHistoryStore.getState().pushSnapshot(s.presentation.pages)
      for (const u of effectiveUpdates) updateElement(u.id, { x: u.x, y: u.y } as Partial<PPTElement>)
    },
    [elements, movableUnitCount, canvasWidth, canvasHeight, updateElement],
  )

  const canAlign = movableUnitCount >= 2
  const canDistribute = movableUnitCount >= 3

  const iconProps = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

  if (!canAlign) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2, paddingLeft: 2, flexShrink: 0 }}>
      <Divider />
      <AlignBtn onClick={() => handleAlign('left')} title={translate('align.left')}>
        <svg {...iconProps}><path d="M4 3v18" /><rect x="4" y="7" width="12" height="4" rx="1" /><rect x="4" y="15" width="8" height="4" rx="1" /></svg>
      </AlignBtn>
      <AlignBtn onClick={() => handleAlign('horizontalCenter')} title={translate('align.horizontalCenter')}>
        <svg {...iconProps}><path d="M12 3v18" /><rect x="6" y="7" width="12" height="3" rx="1" /><rect x="8" y="14" width="8" height="3" rx="1" /></svg>
      </AlignBtn>
      <AlignBtn onClick={() => handleAlign('right')} title={translate('align.right')}>
        <svg {...iconProps}><path d="M20 3v18" /><rect x="8" y="7" width="12" height="4" rx="1" /><rect x="12" y="15" width="8" height="4" rx="1" /></svg>
      </AlignBtn>
      <AlignBtn onClick={() => handleAlign('top')} title={translate('align.top')}>
        <svg {...iconProps}><path d="M3 4h18" /><rect x="7" y="4" width="4" height="12" rx="1" /><rect x="15" y="4" width="4" height="8" rx="1" /></svg>
      </AlignBtn>
      <AlignBtn onClick={() => handleAlign('verticalCenter')} title={translate('align.verticalCenter')}>
        <svg {...iconProps}><path d="M3 12h18" /><rect x="7" y="6" width="3" height="12" rx="1" /><rect x="14" y="8" width="3" height="8" rx="1" /></svg>
      </AlignBtn>
      <AlignBtn onClick={() => handleAlign('bottom')} title={translate('align.bottom')}>
        <svg {...iconProps}><path d="M3 20h18" /><rect x="7" y="8" width="4" height="12" rx="1" /><rect x="15" y="12" width="4" height="8" rx="1" /></svg>
      </AlignBtn>

      {canDistribute && (
        <>
          <Divider />
          <AlignBtn onClick={() => handleAlign('distributeH')} title={translate('align.distributeH')}>
            <svg {...iconProps}><path d="M4 3v18" /><path d="M20 3v18" /><rect x="8" y="8" width="3" height="8" rx="1" /><rect x="13" y="8" width="3" height="8" rx="1" /></svg>
          </AlignBtn>
          <AlignBtn onClick={() => handleAlign('distributeV')} title={translate('align.distributeV')}>
            <svg {...iconProps}><path d="M3 4h18" /><path d="M3 20h18" /><rect x="8" y="8" width="8" height="3" rx="1" /><rect x="8" y="13" width="8" height="3" rx="1" /></svg>
          </AlignBtn>
          <AlignBtn onClick={() => handleAlign('tidyUp')} title={translate('align.tidyUp')}>
            <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
          </AlignBtn>
        </>
      )}
    </div>
  )
}

const Divider = () => (
  <div style={{ width: 1, height: 14, background: t.borderLight, margin: '0 3px', flexShrink: 0 }} />
)

const AlignBtn: React.FC<{
  onClick: () => void
  title: string
  children: React.ReactNode
  active?: boolean
}> = ({ onClick, title, children, active = false }) => (
  <button
    onClick={onClick}
    title={title}
    className={active ? undefined : 'tabslide-panel-item'}
    style={{
      border: 'none',
      background: active ? t.accentBg : 'transparent',
      padding: 0,
      borderRadius: t.radiusSm,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: active ? t.accent : t.textSecondary,
      transition: 'background 0.12s ease, color 0.12s ease',
      width: 28,
      height: 28,
    }}
  >
    {children}
  </button>
)

export default AlignToolbar
