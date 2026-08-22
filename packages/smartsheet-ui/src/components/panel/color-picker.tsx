/**
 * ColorPicker — Figma-style color picker (Tailwind)
 *
 * Decoupled from design-engine: no internal i18n, undo, or document-colors hooks.
 * All integrations injected via props.
 */

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { cn } from '../../utils/cn'
import { OVERLAY_SURFACE_CLASS } from '../overlay-surface'
import {
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  rgbToHsv,
  hexToRgb,
  rgbToHex,
  hexToHsl,
  hslToRgb,
  rgbToHsv as rgb2hsv,
  isValidHex,
  normalizeHex,
  CHECKERBOARD_BG,
  colorWithOpacity,
  type HSV,
  type RGB,
  type HSL,
} from './color-utils'
import './color-picker.css'

export interface ColorPickerLabels {
  recent?: string
  documentColors?: string
  colorPicker?: string
  colorPreview?: string
  eyedropper?: string
}

export interface ColorPickerProps {
  color: string
  opacity?: number
  onChange: (color: string, opacity: number) => void
  onClose?: () => void
  showOpacity?: boolean
  onBeginEdit?: () => void
  onEndEdit?: () => void
  recentColors?: string[]
  onRecentColorAdd?: (hex: string) => void
  documentColors?: string[]
  labels?: ColorPickerLabels
  className?: string
}

type InputMode = 'hex' | 'rgb' | 'hsl'

// --- Sub-components ---

const SatBrightArea = memo(function SatBrightArea({
  hue, saturation, brightness, onChangeSB, onInteractionStart, onInteractionEnd,
}: {
  hue: number; saturation: number; brightness: number
  onChangeSB: (s: number, v: number) => void
  onInteractionStart?: () => void; onInteractionEnd?: () => void
}) {
  const areaRef = useRef<HTMLDivElement>(null)
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onInteractionStart?.()
    const update = (cx: number, cy: number) => {
      const rect = areaRef.current?.getBoundingClientRect()
      if (!rect) return
      const s = Math.max(0, Math.min(100, ((cx - rect.left) / rect.width) * 100))
      const v = Math.max(0, Math.min(100, (1 - (cy - rect.top) / rect.height) * 100))
      onChangeSB(Math.round(s), Math.round(v))
    }
    update(e.clientX, e.clientY)
    const onMove = (me: MouseEvent) => update(me.clientX, me.clientY)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); onInteractionEnd?.() }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChangeSB, onInteractionStart, onInteractionEnd])

  return (
    <div ref={areaRef} className="sui-cp-sv-area" style={{ backgroundColor: hsvToHex({ h: hue, s: 100, v: 100 }) }} onMouseDown={startDrag}>
      <div className="sui-cp-sv-white" />
      <div className="sui-cp-sv-black" />
      <div className="sui-cp-sv-cursor" style={{ left: `${saturation}%`, top: `${100 - brightness}%` }} />
    </div>
  )
})

const HueSlider = memo(function HueSlider({
  hue, onChangeHue, onInteractionStart, onInteractionEnd,
}: {
  hue: number; onChangeHue: (h: number) => void
  onInteractionStart?: () => void; onInteractionEnd?: () => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onInteractionStart?.()
    const update = (cx: number) => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect) return
      onChangeHue(Math.round(Math.max(0, Math.min(360, ((cx - rect.left) / rect.width) * 360))))
    }
    update(e.clientX)
    const onMove = (me: MouseEvent) => update(me.clientX)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); onInteractionEnd?.() }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChangeHue, onInteractionStart, onInteractionEnd])

  return (
    <div ref={barRef} className="sui-cp-hue-bar" onMouseDown={startDrag}>
      <div className="sui-cp-slider-thumb" style={{ left: `${(hue / 360) * 100}%` }} />
    </div>
  )
})

const OpacitySlider = memo(function OpacitySlider({
  opacity, color, onChangeOpacity, onInteractionStart, onInteractionEnd,
}: {
  opacity: number; color: string; onChangeOpacity: (o: number) => void
  onInteractionStart?: () => void; onInteractionEnd?: () => void
}) {
  const barRef = useRef<HTMLDivElement>(null)
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    onInteractionStart?.()
    const update = (cx: number) => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect) return
      onChangeOpacity(Math.round(Math.max(0, Math.min(1, (cx - rect.left) / rect.width)) * 100) / 100)
    }
    update(e.clientX)
    const onMove = (me: MouseEvent) => update(me.clientX)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); onInteractionEnd?.() }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChangeOpacity, onInteractionStart, onInteractionEnd])

  return (
    <div ref={barRef} className="sui-cp-opacity-bar" onMouseDown={startDrag}
      style={{ backgroundImage: `linear-gradient(to right, transparent, ${color}), ${CHECKERBOARD_BG}` }}>
      <div className="sui-cp-slider-thumb" style={{ left: `${opacity * 100}%` }} />
    </div>
  )
})

// --- Main ColorPicker ---

export const ColorPicker = memo(function ColorPicker({
  color,
  opacity = 1,
  onChange,
  onClose,
  showOpacity = true,
  onBeginEdit,
  onEndEdit,
  recentColors: recentColorsProp,
  onRecentColorAdd,
  documentColors,
  labels,
  className,
}: ColorPickerProps) {
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(color || '#000000'))
  const [currentOpacity, setCurrentOpacity] = useState(opacity)
  const [inputMode, setInputMode] = useState<InputMode>('hex')
  const [hexInput, setHexInput] = useState(color || '#000000')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (color) { setHsv(hexToHsv(color)); setHexInput(normalizeHex(color)) }
  }, [color])

  useEffect(() => { setCurrentOpacity(opacity) }, [opacity])

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingChangeRef = useRef<{ hex: string; opacity: number } | null>(null)

  const emitChange = useCallback((newHsv: HSV, newOpacity: number) => {
    const hex = hsvToHex(newHsv)
    pendingChangeRef.current = { hex, opacity: newOpacity }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      if (pendingChangeRef.current) { onChange(pendingChangeRef.current.hex, pendingChangeRef.current.opacity); pendingChangeRef.current = null }
      debounceTimerRef.current = null
    }, 16)
  }, [onChange])

  const flushPendingChange = useCallback(() => {
    if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null }
    if (pendingChangeRef.current) { onChange(pendingChangeRef.current.hex, pendingChangeRef.current.opacity); pendingChangeRef.current = null }
  }, [onChange])

  const commitInteraction = useCallback(() => {
    flushPendingChange()
    onEndEdit?.()
  }, [flushPendingChange, onEndEdit])

  const beginInteraction = useCallback(() => { onBeginEdit?.() }, [onBeginEdit])

  const handleNumericInputFocus = useCallback(() => { beginInteraction() }, [beginInteraction])
  const handleNumericInputBlur = useCallback(() => { commitInteraction() }, [commitInteraction])

  const handleInputEnter = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    ;(e.currentTarget as HTMLInputElement).blur()
  }, [])

  useEffect(() => { return () => { flushPendingChange() } }, [flushPendingChange])

  const handleSBChange = useCallback((s: number, v: number) => {
    const newHsv = { ...hsv, s, v }; setHsv(newHsv); setHexInput(hsvToHex(newHsv)); emitChange(newHsv, currentOpacity)
  }, [hsv, currentOpacity, emitChange])

  const handleHueChange = useCallback((h: number) => {
    const newHsv = { ...hsv, h }; setHsv(newHsv); setHexInput(hsvToHex(newHsv)); emitChange(newHsv, currentOpacity)
  }, [hsv, currentOpacity, emitChange])

  const handleOpacityChange = useCallback((o: number) => {
    setCurrentOpacity(o); emitChange(hsv, o)
  }, [hsv, emitChange])

  const handleHexCommit = useCallback(() => {
    if (isValidHex(hexInput)) {
      const normalized = normalizeHex(hexInput); const newHsv = hexToHsv(normalized)
      setHsv(newHsv); setHexInput(normalized); emitChange(newHsv, currentOpacity)
    } else { setHexInput(hsvToHex(hsv)) }
  }, [hexInput, hsv, currentOpacity, emitChange])

  const rgb = useMemo(() => hsvToRgb(hsv), [hsv])
  const handleRgbChange = useCallback((channel: 'r' | 'g' | 'b', value: number) => {
    const newRgb = { ...rgb, [channel]: Math.max(0, Math.min(255, value)) }
    const newHsv = rgbToHsv(newRgb); setHsv(newHsv); setHexInput(rgbToHex(newRgb)); emitChange(newHsv, currentOpacity)
  }, [rgb, currentOpacity, emitChange])

  const hsl = useMemo(() => hexToHsl(hsvToHex(hsv)), [hsv])
  const handleHslChange = useCallback((channel: 'h' | 's' | 'l', value: number) => {
    const limits: Record<string, number> = { h: 360, s: 100, l: 100 }
    const newHsl = { ...hsl, [channel]: Math.max(0, Math.min(limits[channel], value)) }
    const newRgb = hslToRgb(newHsl); const newHsv = rgb2hsv(newRgb)
    setHsv(newHsv); setHexInput(rgbToHex(newRgb)); emitChange(newHsv, currentOpacity)
  }, [hsl, currentOpacity, emitChange])

  const handleInteractionStart = useCallback(() => { beginInteraction() }, [beginInteraction])
  const handleInteractionEnd = useCallback(() => { commitInteraction() }, [commitInteraction])

  useEffect(() => {
    if (!onClose) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        commitInteraction()
        onRecentColorAdd?.(hsvToHex(hsv))
        onClose()
      }
    }
    const timer = setTimeout(() => { document.addEventListener('mousedown', handleClickOutside) }, 100)
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClickOutside) }
  }, [onClose, hsv, commitInteraction, onRecentColorAdd])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1
    let newHsv = { ...hsv }; let handled = false
    if (e.key === 'ArrowRight') { newHsv.s = Math.min(100, newHsv.s + step); handled = true }
    else if (e.key === 'ArrowLeft') { newHsv.s = Math.max(0, newHsv.s - step); handled = true }
    else if (e.key === 'ArrowUp') { newHsv.v = Math.min(100, newHsv.v + step); handled = true }
    else if (e.key === 'ArrowDown') { newHsv.v = Math.max(0, newHsv.v - step); handled = true }
    if (handled) { e.preventDefault(); setHsv(newHsv); setHexInput(hsvToHex(newHsv)); emitChange(newHsv, currentOpacity) }
  }, [hsv, currentOpacity, emitChange])

  const handleSwatchSelect = useCallback((c: string) => {
    beginInteraction()
    const newHsv = hexToHsv(c); setHsv(newHsv); setHexInput(c); emitChange(newHsv, currentOpacity)
    commitInteraction()
  }, [beginInteraction, commitInteraction, currentOpacity, emitChange])

  const currentHex = hsvToHex(hsv)

  return (
    <div
      ref={containerRef}
      className={cn('w-[260px] rounded-lg p-3', OVERLAY_SURFACE_CLASS, className)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      role="dialog"
      aria-label={labels?.colorPicker ?? 'Color Picker'}
    >
      <SatBrightArea hue={hsv.h} saturation={hsv.s} brightness={hsv.v} onChangeSB={handleSBChange}
        onInteractionStart={handleInteractionStart} onInteractionEnd={handleInteractionEnd} />

      {/* Sliders row */}
      <div className="mt-2 flex items-center gap-2">
        <div className="h-6 w-6 flex-shrink-0 overflow-hidden rounded-full border border-border/30"
          aria-label={labels?.colorPreview ?? 'Color preview'}>
          <div className="h-full w-full" style={{ backgroundColor: colorWithOpacity(currentHex, currentOpacity) }} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <HueSlider hue={hsv.h} onChangeHue={handleHueChange}
            onInteractionStart={handleInteractionStart} onInteractionEnd={handleInteractionEnd} />
          {showOpacity && (
            <OpacitySlider opacity={currentOpacity} color={currentHex} onChangeOpacity={handleOpacityChange}
              onInteractionStart={handleInteractionStart} onInteractionEnd={handleInteractionEnd} />
          )}
        </div>
        {'EyeDropper' in window && (
          <button
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            onClick={async () => {
              try {
                // @ts-expect-error EyeDropper API not in TS lib
                const eyeDropper = new window.EyeDropper()
                const result = await eyeDropper.open()
                if (result?.sRGBHex) {
                  beginInteraction()
                  const newHsv = hexToHsv(result.sRGBHex)
                  setHsv(newHsv); setHexInput(normalizeHex(result.sRGBHex))
                  emitChange(newHsv, currentOpacity); commitInteraction()
                }
              } catch { /* cancelled */ }
            }}
            title={labels?.eyedropper ?? 'Eyedropper'}
            aria-label={labels?.eyedropper ?? 'Eyedropper'}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M13.3 2.7a1.5 1.5 0 00-2.1 0L9.5 4.4 8 2.9l-.7.7 1.5 1.5-5.4 5.4a.5.5 0 00-.1.2L2 14l3.3-1.3a.5.5 0 00.2-.1l5.4-5.4 1.5 1.5.7-.7-1.5-1.5 1.7-1.7a1.5 1.5 0 000-2.1z"
                fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Input mode toggle */}
      <div className="mt-2.5 flex gap-0.5 rounded-md bg-muted/40 p-0.5">
        {(['hex', 'rgb', 'hsl'] as const).map((mode) => (
          <button key={mode}
            className={cn(
              'flex-1 rounded py-1 text-caption font-medium transition-colors',
              inputMode === mode
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setInputMode(mode)}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Input fields */}
      <div className="mt-2">
        {inputMode === 'hex' && (
          <div className="flex gap-1.5">
            <input
              className="h-7 min-w-0 flex-1 rounded bg-muted/40 px-2 text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
              value={hexInput.replace('#', '')}
              onChange={(e) => setHexInput(`#${e.target.value}`)}
              onFocus={handleNumericInputFocus}
              onBlur={() => { handleHexCommit(); handleNumericInputBlur() }}
              onKeyDown={handleInputEnter}
              maxLength={6}
              spellCheck={false}
            />
            {showOpacity && (
              <input
                className="h-7 w-14 rounded bg-muted/40 px-2 text-center text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
                type="number" min={0} max={100}
                value={Math.round(currentOpacity * 100)}
                onChange={(e) => handleOpacityChange(Math.max(0, Math.min(100, +e.target.value)) / 100)}
                onFocus={handleNumericInputFocus} onBlur={handleNumericInputBlur}
                onKeyDown={handleInputEnter}
              />
            )}
          </div>
        )}

        {inputMode === 'rgb' && (
          <div className="flex gap-1">
            {(['r', 'g', 'b'] as const).map((ch) => (
              <div key={ch} className="flex flex-1 flex-col items-center gap-0.5">
                <label className="text-caption text-muted-foreground/60">{ch.toUpperCase()}</label>
                <input className="h-7 w-full rounded bg-muted/40 px-1 text-center text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
                  type="number" min={0} max={255} value={rgb[ch]}
                  onChange={(e) => handleRgbChange(ch, +e.target.value)}
                  onFocus={handleNumericInputFocus} onBlur={handleNumericInputBlur} onKeyDown={handleInputEnter} />
              </div>
            ))}
            {showOpacity && (
              <div className="flex flex-1 flex-col items-center gap-0.5">
                <label className="text-caption text-muted-foreground/60">A</label>
                <input className="h-7 w-full rounded bg-muted/40 px-1 text-center text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
                  type="number" min={0} max={100} value={Math.round(currentOpacity * 100)}
                  onChange={(e) => handleOpacityChange(+e.target.value / 100)}
                  onFocus={handleNumericInputFocus} onBlur={handleNumericInputBlur} onKeyDown={handleInputEnter} />
              </div>
            )}
          </div>
        )}

        {inputMode === 'hsl' && (
          <div className="flex gap-1">
            {(['h', 's', 'l'] as const).map((ch) => (
              <div key={ch} className="flex flex-1 flex-col items-center gap-0.5">
                <label className="text-caption text-muted-foreground/60">{ch.toUpperCase()}</label>
                <input className="h-7 w-full rounded bg-muted/40 px-1 text-center text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
                  type="number" min={0} max={ch === 'h' ? 360 : 100} value={hsl[ch]}
                  onChange={(e) => handleHslChange(ch, +e.target.value)}
                  onFocus={handleNumericInputFocus} onBlur={handleNumericInputBlur} onKeyDown={handleInputEnter} />
              </div>
            ))}
            {showOpacity && (
              <div className="flex flex-1 flex-col items-center gap-0.5">
                <label className="text-caption text-muted-foreground/60">A</label>
                <input className="h-7 w-full rounded bg-muted/40 px-1 text-center text-body text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-accent/40"
                  type="number" min={0} max={100} value={Math.round(currentOpacity * 100)}
                  onChange={(e) => handleOpacityChange(+e.target.value / 100)}
                  onFocus={handleNumericInputFocus} onBlur={handleNumericInputBlur} onKeyDown={handleInputEnter} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recent colors */}
      {recentColorsProp && recentColorsProp.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-caption font-medium text-accent">{labels?.recent ?? 'Recent'}</div>
          <div className="flex flex-wrap gap-1">
            {recentColorsProp.map((c, i) => (
              <button key={`${c}-${i}`}
                className="h-5 w-5 rounded border border-border/20 transition-transform hover:scale-110"
                style={{ backgroundColor: c }}
                onClick={() => handleSwatchSelect(c)}
                title={c} />
            ))}
          </div>
        </div>
      )}

      {/* Document colors */}
      {documentColors && documentColors.length > 0 && (
        <div className="mt-2.5">
          <div className="mb-1 text-caption font-medium text-accent">{labels?.documentColors ?? 'Document Colors'}</div>
          <div className="flex flex-wrap gap-1">
            {documentColors.map((c) => (
              <button key={c}
                className="h-5 w-5 rounded border border-border/20 transition-transform hover:scale-110"
                style={{ backgroundColor: c }}
                onClick={() => handleSwatchSelect(c)}
                title={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
