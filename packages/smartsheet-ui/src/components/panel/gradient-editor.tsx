/**
 * GradientEditor — edit gradient stops, type, and direction (Tailwind)
 *
 * Decoupled from design-engine: no internal i18n or undo hooks.
 * Undo and labels injected via props.
 */

import React, { memo, useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '../../utils/cn'
import type { Gradient, GradientStop, GradientType } from './gradient-types'
import { ColorPicker, type ColorPickerProps } from './color-picker'
import { NumberInput } from './number-input'
import { colorWithOpacity, hexToRgb, rgbToHex, CHECKERBOARD_BG } from './color-utils'

export interface GradientEditorLabels {
  gradientEditor?: string
  linearGradient?: string
  radialGradient?: string
  reverseStops?: string
  equalSpacing?: string
  gradientBar?: string
  selectedStop?: string
  editStopColor?: string
  removeStop?: string
}

export interface GradientEditorProps {
  gradient: Gradient
  onChange: (gradient: Gradient) => void
  onBeginEdit?: () => void
  onEndEdit?: () => void
  labels?: GradientEditorLabels
  /** Props forwarded to the embedded ColorPicker for stop editing */
  colorPickerProps?: Partial<Omit<ColorPickerProps, 'color' | 'opacity' | 'onChange' | 'onClose'>>
}

function interpolateColor(color1: string, color2: string, t: number): string {
  const c1 = hexToRgb(color1)
  const c2 = hexToRgb(color2)
  return rgbToHex({
    r: Math.round(c1.r + (c2.r - c1.r) * t),
    g: Math.round(c1.g + (c2.g - c1.g) * t),
    b: Math.round(c1.b + (c2.b - c1.b) * t),
  })
}

function gradientToLinearCss(g: Gradient, angle?: number): string {
  const sorted = g.stops.slice().sort((a, b) => a.offset - b.offset)
  const stops = sorted
    .map((s) => `${colorWithOpacity(s.color, s.opacity ?? 1)} ${Math.round(s.offset * 100)}%`)
    .join(', ')
  const a = angle ?? computeAngle(g)
  return `linear-gradient(${a}deg, ${stops})`
}

function computeAngle(g: Gradient): number {
  const dx = g.endX - g.startX
  const dy = g.endY - g.startY
  return Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90)
}

function angleToEndpoints(angle: number) {
  const rad = ((angle - 90) * Math.PI) / 180
  return {
    startX: 0.5 - Math.cos(rad) * 0.5,
    startY: 0.5 - Math.sin(rad) * 0.5,
    endX: 0.5 + Math.cos(rad) * 0.5,
    endY: 0.5 + Math.sin(rad) * 0.5,
  }
}

export const GradientEditor = memo(function GradientEditor({
  gradient,
  onChange,
  onBeginEdit,
  onEndEdit,
  labels,
  colorPickerProps,
}: GradientEditorProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const [selectedStopIndex, setSelectedStopIndex] = useState(0)
  const [showStopPicker, setShowStopPicker] = useState(false)
  const [dragDeleteHint, setDragDeleteHint] = useState(false)

  const angle = useMemo(() => computeAngle(gradient), [gradient])

  const handleTypeChange = useCallback((type: GradientType) => {
    onChange({ ...gradient, type })
  }, [gradient, onChange])

  const handleAngleChange = useCallback((a: number) => {
    onChange({ ...gradient, ...angleToEndpoints(a) })
  }, [gradient, onChange])

  const handleStopMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    e.preventDefault(); e.stopPropagation()
    setSelectedStopIndex(index); setDragDeleteHint(false)
    const barRect = barRef.current?.getBoundingClientRect()
    if (!barRect) return
    onBeginEdit?.()
    const deleteThreshold = 40

    const onMove = (me: MouseEvent) => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect) return
      const distBelow = me.clientY - rect.bottom
      if (distBelow > deleteThreshold && gradient.stops.length > 2) {
        setDragDeleteHint(true)
      } else {
        setDragDeleteHint(false)
        const offset = Math.max(0, Math.min(1, (me.clientX - rect.left) / rect.width))
        const newStops = [...gradient.stops]
        newStops[index] = { ...newStops[index], offset: Math.round(offset * 100) / 100 }
        onChange({ ...gradient, stops: newStops })
      }
    }

    const onUp = (me: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      const rect = barRef.current?.getBoundingClientRect()
      if (rect) {
        const distBelow = me.clientY - rect.bottom
        if (distBelow > deleteThreshold && gradient.stops.length > 2) {
          const newStops = gradient.stops.filter((_, i) => i !== index)
          setSelectedStopIndex(Math.min(index, newStops.length - 1))
          onChange({ ...gradient, stops: newStops })
        }
      }
      setDragDeleteHint(false)
      onEndEdit?.()
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [gradient, onChange, onBeginEdit, onEndEdit])

  const handleBarClick = useCallback((e: React.MouseEvent) => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect) return
    const offset = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const sorted = gradient.stops.slice().sort((a, b) => a.offset - b.offset)
    let left = sorted[0], right = sorted[sorted.length - 1]
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].offset <= offset && sorted[i + 1].offset >= offset) {
        left = sorted[i]; right = sorted[i + 1]; break
      }
    }
    const range = right.offset - left.offset
    const t = range > 0 ? (offset - left.offset) / range : 0
    const newStop: GradientStop = {
      color: interpolateColor(left.color, right.color, t),
      opacity: Math.round(((left.opacity ?? 1) + ((right.opacity ?? 1) - (left.opacity ?? 1)) * t) * 100) / 100,
      offset: Math.round(offset * 100) / 100,
    }
    const newStops = [...gradient.stops, newStop]
    setSelectedStopIndex(newStops.length - 1)
    onChange({ ...gradient, stops: newStops })
  }, [gradient, onChange])

  const handleRemoveStop = useCallback(() => {
    if (gradient.stops.length <= 2) return
    const newStops = gradient.stops.filter((_, i) => i !== selectedStopIndex)
    setSelectedStopIndex(Math.min(selectedStopIndex, newStops.length - 1))
    onChange({ ...gradient, stops: newStops })
  }, [gradient, selectedStopIndex, onChange])

  const handleReverseStops = useCallback(() => {
    onChange({ ...gradient, stops: gradient.stops.map((s) => ({ ...s, offset: Math.round((1 - s.offset) * 100) / 100 })) })
  }, [gradient, onChange])

  const handleEqualSpacing = useCallback(() => {
    const count = gradient.stops.length
    if (count < 2) return
    const sorted = gradient.stops.slice().sort((a, b) => a.offset - b.offset)
    onChange({ ...gradient, stops: sorted.map((s, i) => ({ ...s, offset: Math.round((i / (count - 1)) * 100) / 100 })) })
  }, [gradient, onChange])

  const handleStopColorChange = useCallback((color: string, opacity: number) => {
    const newStops = [...gradient.stops]
    newStops[selectedStopIndex] = { ...newStops[selectedStopIndex], color, opacity }
    onChange({ ...gradient, stops: newStops })
  }, [gradient, selectedStopIndex, onChange])

  const selectedStop = gradient.stops[selectedStopIndex]

  return (
    <div className="flex flex-col gap-2" role="group" aria-label={labels?.gradientEditor ?? 'Gradient Editor'}>
      {/* Type toggle + controls */}
      <div className="flex items-center gap-1">
        <button
          className={cn(
            'rounded px-2 py-1 text-caption font-medium transition-colors',
            gradient.type === 'linear' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => handleTypeChange('linear')}
          aria-pressed={gradient.type === 'linear'}
          aria-label={labels?.linearGradient ?? 'Linear gradient'}
        >
          Linear
        </button>
        <button
          className={cn(
            'rounded px-2 py-1 text-caption font-medium transition-colors',
            gradient.type === 'radial' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => handleTypeChange('radial')}
          aria-pressed={gradient.type === 'radial'}
          aria-label={labels?.radialGradient ?? 'Radial gradient'}
        >
          Radial
        </button>
        {gradient.type === 'linear' && (
          <NumberInput
            value={angle}
            onChange={handleAngleChange}
            onBeginEdit={onBeginEdit}
            onEndEdit={onEndEdit}
            min={0} max={360} precision={0} suffix="°" label=""
          />
        )}
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          onClick={handleReverseStops}
          title={labels?.reverseStops ?? 'Reverse stops'}
          aria-label={labels?.reverseStops ?? 'Reverse stops'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M3 5l-2 2 2 2M11 5l2 2-2 2M1 7h12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          onClick={handleEqualSpacing}
          title={labels?.equalSpacing ?? 'Equal spacing'}
          aria-label={labels?.equalSpacing ?? 'Equal spacing'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <line x1="3" y1="3" x2="3" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="7" y1="3" x2="7" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="11" y1="3" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Gradient bar with stops */}
      <div className="relative h-6">
        <div
          ref={barRef}
          className="h-3 cursor-pointer rounded-md"
          style={{ backgroundImage: gradientToLinearCss(gradient, 90) }}
          onClick={handleBarClick}
          role="slider"
          aria-label={labels?.gradientBar ?? 'Gradient bar'}
          tabIndex={0}
        />
        {gradient.stops.map((stop, i) => (
          <div
            key={i}
            className={cn(
              'absolute top-0 flex h-5 w-3 -translate-x-1/2 cursor-grab flex-col items-center',
              i === selectedStopIndex && 'z-sticky',
              dragDeleteHint && i === selectedStopIndex && 'opacity-30',
            )}
            style={{ left: `${stop.offset * 100}%` }}
            onMouseDown={(e) => handleStopMouseDown(e, i)}
            onClick={(e) => { e.stopPropagation(); setSelectedStopIndex(i); setShowStopPicker(true) }}
            role="button"
            aria-label={`Color stop ${i + 1} at ${Math.round(stop.offset * 100)}%`}
            tabIndex={0}
          >
            <div
              className={cn(
                'h-3 w-3 rounded-full border-2',
                i === selectedStopIndex ? 'border-accent' : 'border-border',
              )}
              style={{ backgroundColor: colorWithOpacity(stop.color, stop.opacity ?? 1) }}
            />
          </div>
        ))}
      </div>

      {/* Selected stop controls */}
      <div className="flex items-center gap-1.5" role="group" aria-label={labels?.selectedStop ?? 'Selected stop'}>
        <div
          className="h-5 w-5 cursor-pointer rounded border border-border/30"
          onClick={() => setShowStopPicker(!showStopPicker)}
          role="button"
          aria-label={labels?.editStopColor ?? 'Edit stop color'}
          tabIndex={0}
          style={{
            backgroundColor: selectedStop
              ? colorWithOpacity(selectedStop.color, selectedStop.opacity ?? 1)
              : '#000',
          }}
        />
        <NumberInput
          value={selectedStop ? Math.round(selectedStop.offset * 100) : 0}
          onChange={(v) => {
            if (!selectedStop) return
            const newStops = [...gradient.stops]
            newStops[selectedStopIndex] = { ...newStops[selectedStopIndex], offset: v / 100 }
            onChange({ ...gradient, stops: newStops })
          }}
          onBeginEdit={onBeginEdit}
          onEndEdit={onEndEdit}
          min={0} max={100} precision={0} suffix="%"
        />
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-30"
          onClick={handleRemoveStop}
          disabled={gradient.stops.length <= 2}
          title={labels?.removeStop ?? 'Remove stop'}
          aria-label={labels?.removeStop ?? 'Remove stop'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Color picker for selected stop */}
      {showStopPicker && selectedStop && (
        <div className="mt-1">
          <ColorPicker
            color={selectedStop.color}
            opacity={selectedStop.opacity ?? 1}
            onChange={handleStopColorChange}
            onClose={() => setShowStopPicker(false)}
            onBeginEdit={onBeginEdit}
            onEndEdit={onEndEdit}
            {...colorPickerProps}
          />
        </div>
      )}
    </div>
  )
})
