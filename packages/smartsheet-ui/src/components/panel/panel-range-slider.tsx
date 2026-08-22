/**
 * PanelRangeSlider — styled range input for property panels.
 *
 * Thin track with accent-colored thumb. Uses a small CSS file for
 * ::-webkit-slider-* pseudo-elements that Tailwind can't express.
 */

import React, { memo, useCallback, useEffect, useState } from 'react'
import { cn } from '../../utils/cn'
import './panel-range-slider.css'

export interface PanelRangeSliderProps {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  title?: string
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}

export const PanelRangeSlider = memo(function PanelRangeSlider({
  value,
  min,
  max,
  step,
  onChange,
  title,
  disabled,
  className,
  style,
}: PanelRangeSliderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [draftValue, setDraftValue] = useState(value)

  useEffect(() => {
    if (!isDragging) setDraftValue(value)
  }, [value, isDragging])

  useEffect(() => {
    if (!isDragging) return
    const finish = () => setIsDragging(false)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [isDragging])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = Number(e.target.value)
      if (!Number.isFinite(next)) return
      setDraftValue(next)
      onChange(next)
    },
    [onChange],
  )

  return (
    <input
      className={cn('sui-range-slider', disabled && 'opacity-40', className)}
      type="range"
      min={min}
      max={max}
      step={step}
      value={isDragging ? draftValue : value}
      title={title}
      disabled={disabled}
      onPointerDown={() => setIsDragging(true)}
      onInput={(e) => {
        const next = Number((e.target as HTMLInputElement).value)
        if (!Number.isFinite(next)) return
        setDraftValue(next)
        onChange(next)
      }}
      onChange={handleChange}
      style={{ width: '100%', ...style }}
    />
  )
})

/* ── PanelRangeField — label + range + value display ── */

export interface PanelRangeFieldProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  precision?: number
  onChange: (value: number) => void
  className?: string
}

export const PanelRangeField = memo(function PanelRangeField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  precision = 2,
  onChange,
  className,
}: PanelRangeFieldProps) {
  const displayValue =
    precision != null ? Number(value.toFixed(precision)) : value

  return (
    <div className={className}>
      <div className="mb-0.5 flex items-center justify-between gap-1.5">
        <span className="text-caption text-muted-foreground">{label}</span>
        <span className="text-caption tabular-nums text-muted-foreground">
          {displayValue}
          {suffix || ''}
        </span>
      </div>
      <PanelRangeSlider
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
      />
    </div>
  )
})
