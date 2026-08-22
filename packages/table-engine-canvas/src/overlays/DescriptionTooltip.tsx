import { type FC, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ZIndex } from '@tabtin/app-shell'
import { useGridOverlayStore } from './store'

const TOOLTIP_OFFSET_Y = 6

/**
 * Inner component rendered only when tooltip data exists.
 * Listens for scroll events (capture phase) to dismiss the tooltip
 * when the grid or page scrolls, preventing position drift.
 */
const DescriptionTooltipInner: FC<{
  position: { x: number; y: number }
  text: string
}> = ({ position, text }) => {
  const closeDescriptionTooltip = useGridOverlayStore(
    (s) => s.closeDescriptionTooltip
  )

  useEffect(() => {
    const onScroll = () => closeDescriptionTooltip()
    // Capture phase so we catch scroll on any ancestor (including grid containers)
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [closeDescriptionTooltip])

  return createPortal(
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y + TOOLTIP_OFFSET_Y,
        transform: 'translateX(-50%)',
        maxWidth: 280,
        padding: '6px 10px',
        borderRadius: 6,
        border: '0.5px solid color-mix(in srgb, var(--tt-border-color, rgba(0,0,0,0.16)) 70%, transparent)',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--tt-text-primary, #1f2937)',
        background: 'color-mix(in srgb, var(--tt-bg-popover, #fff) 80%, transparent)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        boxShadow:
          '0 2px 8px rgba(0,0,0,0.12), 0 0 1px rgba(0,0,0,0.08)',
        pointerEvents: 'none',
        zIndex: ZIndex.global,
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      }}
    >
      {text}
    </div>,
    document.body
  )
}

export const DescriptionTooltip: FC = () => {
  const tooltip = useGridOverlayStore((s) => s.descriptionTooltip)

  if (!tooltip) return null

  return (
    <DescriptionTooltipInner position={tooltip.position} text={tooltip.text} />
  )
}
