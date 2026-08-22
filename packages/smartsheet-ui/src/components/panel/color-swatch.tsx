/**
 * ColorSwatch — clickable color block that opens a ColorPicker popover (Tailwind)
 *
 * Shows current color + opacity. Click to toggle inline ColorPicker.
 * Supports gradient preview. The picker is portaled to document.body with fixed positioning.
 */

import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { cn } from '../../utils/cn'
import { ColorPicker, type ColorPickerProps } from './color-picker'
import { colorWithOpacity } from './color-utils'
import type { Gradient } from './gradient-types'
import { useOverlayContainer } from '../overlay-container-context'

export interface ColorSwatchProps {
  color: string
  opacity?: number
  gradient?: Gradient
  onChange: (color: string, opacity: number) => void
  small?: boolean
  disabled?: boolean
  className?: string
  /** Props forwarded to the internal ColorPicker */
  pickerProps?: Partial<Omit<ColorPickerProps, 'color' | 'opacity' | 'onChange' | 'onClose'>>
}

function gradientToCss(g: Gradient): string {
  const stops = g.stops
    .slice()
    .sort((a, b) => a.offset - b.offset)
    .map((s) => `${colorWithOpacity(s.color, s.opacity ?? 1)} ${s.offset * 100}%`)
    .join(', ')

  if (g.type === 'radial') return `radial-gradient(circle, ${stops})`
  const dx = g.endX - g.startX
  const dy = g.endY - g.startY
  const angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90)
  return `linear-gradient(${angle}deg, ${stops})`
}

export const ColorSwatch = memo(function ColorSwatch({
  color,
  opacity = 1,
  gradient,
  onChange,
  small = false,
  disabled = false,
  className,
  pickerProps,
}: ColorSwatchProps) {
  const [showPicker, setShowPicker] = useState(false)
  const swatchRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  // Wave 6.3：消费 OverlayContainerProvider 容器，让 picker 跟随所属 Space 自动隐藏。
  const overlayContainer = useOverlayContainer()

  const togglePicker = useCallback(() => {
    if (!disabled) setShowPicker((prev) => !prev)
  }, [disabled])

  const handleClose = useCallback(() => { setShowPicker(false) }, [])

  useEffect(() => {
    if (!showPicker || !swatchRef.current) { setPopoverPos(null); return }
    const rect = swatchRef.current.getBoundingClientRect()
    const pickerWidth = 260
    const pickerHeight = 360
    let top = rect.bottom + 4
    let left = rect.left

    if (top + pickerHeight > window.innerHeight) top = rect.top - pickerHeight - 4
    if (left + pickerWidth > window.innerWidth) left = window.innerWidth - pickerWidth - 8
    setPopoverPos({ top, left })
  }, [showPicker])

  const bgStyle: React.CSSProperties = gradient
    ? { backgroundImage: gradientToCss(gradient) }
    : { backgroundColor: colorWithOpacity(color, opacity) }

  return (
    <div className={cn('inline-block', className)} ref={swatchRef}>
      <div
        className={cn(
          'cursor-pointer rounded border border-border/20',
          small ? 'h-4 w-4' : 'h-6 w-6',
        )}
        style={bgStyle}
        onClick={togglePicker}
        title={gradient ? 'Gradient' : `${color} ${Math.round(opacity * 100)}%`}
      />
      {showPicker && popoverPos && ReactDOM.createPortal(
        <div className="z-dropdown" style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left }}>
          <ColorPicker
            color={color}
            opacity={opacity}
            onChange={onChange}
            onClose={handleClose}
            {...pickerProps}
          />
        </div>,
        overlayContainer ?? document.body,
      )}
    </div>
  )
})
