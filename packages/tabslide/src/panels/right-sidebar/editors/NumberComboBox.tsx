import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ScrollArea } from '../../../components/ui/ScrollArea'

export interface ComboPreset {
  label: string
  value: number
}

interface NumberComboBoxProps {
  value: number | undefined
  onChange: (v: number | undefined) => void
  presets: ComboPreset[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  suffix?: string
}

export const NumberComboBox: React.FC<NumberComboBoxProps> = ({
  value, onChange, presets, min, max, step, placeholder, suffix,
}) => {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value != null ? String(value) : '')
  const rootRef = useRef<HTMLDivElement>(null)
  const dropdownHeight = Math.max(84, Math.min(160, presets.length * 26 + 8))

  useEffect(() => {
    setDraft(value != null ? String(value) : '')
  }, [value])

  useEffect(() => {
    if (!open) return
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onClickOutside, true)
    return () => document.removeEventListener('pointerdown', onClickOutside, true)
  }, [open])

  const commit = useCallback((raw: string) => {
    const num = Number(raw)
    if (!Number.isFinite(num) || (min != null && num < min) || (max != null && num > max)) {
      onChange(undefined)
      return
    }
    onChange(num)
  }, [onChange, min, max])

  return (
    <div ref={rootRef} className="relative">
      <div className="relative flex items-center">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value)
            const num = Number(e.target.value)
            if (Number.isFinite(num) && (min == null || num >= min) && (max == null || num <= max)) {
              onChange(num)
            }
          }}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commit(draft) } }}
          onFocus={() => setOpen(true)}
          className="h-7 w-full rounded bg-muted/40 px-1.5 text-body text-foreground outline-none transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:ring-1 focus:ring-accent/40"
          style={{ paddingRight: suffix ? 28 : 22 }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-[22px] top-1/2 -translate-y-1/2 text-caption text-muted-foreground/60">
            {suffix}
          </span>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="absolute right-0.5 top-1/2 flex -translate-y-1/2 items-center px-1 py-0.5 text-muted-foreground/60 hover:text-foreground"
        >
          <svg width={8} height={8} viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={open ? '1 5 5 1 9 5' : '1 1 5 5 9 1'} />
          </svg>
        </button>
      </div>

      {open && (
        <ScrollArea
          native
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
          className="absolute left-0 right-0 top-full z-dropdown mt-0.5 rounded-md border border-border/30 bg-popover shadow-lg"
          style={{ height: dropdownHeight }}
        >
          {presets.map((item) => {
            const isActive = value != null && Math.abs(value - item.value) < 0.001
            return (
              <div
                key={item.value}
                onClick={() => {
                  onChange(item.value)
                  setDraft(String(item.value))
                  setOpen(false)
                }}
                className={`cursor-pointer px-2 py-1 text-body transition-colors ${
                  isActive
                    ? 'bg-accent/10 font-semibold text-accent'
                    : 'text-foreground hover:bg-muted/80'
                }`}
              >
                {item.label}{suffix ? ` ${suffix}` : ''}
              </div>
            )
          })}
        </ScrollArea>
      )}
    </div>
  )
}

export const FONT_SIZE_PRESETS: ComboPreset[] = [
  9, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96,
].map((v) => ({ label: String(v), value: v }))

export const LINE_HEIGHT_PRESETS: ComboPreset[] = [
  { label: '1.0', value: 1 },
  { label: '1.15', value: 1.15 },
  { label: '1.5', value: 1.5 },
  { label: '1.75', value: 1.75 },
  { label: '2.0', value: 2 },
  { label: '2.5', value: 2.5 },
  { label: '3.0', value: 3 },
]

export const LETTER_SPACING_PRESETS: ComboPreset[] = [
  { label: '-1', value: -1 },
  { label: '0', value: 0 },
  { label: '0.5', value: 0.5 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '5', value: 5 },
  { label: '8', value: 8 },
]
