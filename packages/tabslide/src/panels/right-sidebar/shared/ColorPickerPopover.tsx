import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import * as t from '../../../theme'
import { useT } from '../../../i18n'
import {
  hexToHsv, hsvToHex, hsvToRgb, hexToRgb, rgbToHex,
  isValidHex, normalizeHex, colorWithOpacity, parseOpacity, parseColorToHex,
  CHECKERBOARD_BG,
  type HSV, type RGB,
} from './color-utils'
import { usePresentationColors } from './usePresentationColors'
import { ZIndex } from '@tabtin/app-shell'

/* ── ColorPickerPopover ── */

interface ColorPickerPopoverProps {
  value: string
  opacity?: number
  showOpacity?: boolean
  onChange: (hex: string, opacity?: number, themeKey?: string) => void
  onClose?: () => void
}

const SV_SIZE = 200
const SLIDER_H = 14
const THUMB = 12

/* ── 2D saturation-brightness area ── */
const SatBrightArea: React.FC<{
  hue: number; sat: number; bright: number
  onChangeSB: (s: number, v: number) => void
}> = ({ hue, sat, bright, onChangeSB }) => {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const update = (cx: number, cy: number) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      const s = Math.max(0, Math.min(100, ((cx - rect.left) / rect.width) * 100))
      const v = Math.max(0, Math.min(100, (1 - (cy - rect.top) / rect.height) * 100))
      onChangeSB(Math.round(s), Math.round(v))
    }
    update(e.clientX, e.clientY)
    const onMove = (me: MouseEvent) => update(me.clientX, me.clientY)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChangeSB])

  const bgColor = hsvToHex({ h: hue, s: 100, v: 100 })
  return (
    <div
      ref={ref} onMouseDown={drag}
      style={{
        position: 'relative', width: '100%', aspectRatio: '1', borderRadius: 6, cursor: 'crosshair', overflow: 'hidden',
        background: bgColor,
      }}
    >
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to right, #ffffff, transparent)' }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent, #000000)' }} />
      <div style={{
        position: 'absolute',
        left: `${sat}%`, top: `${100 - bright}%`,
        width: THUMB, height: THUMB, borderRadius: '50%',
        border: '2px solid #fff', boxShadow: '0 0 2px rgba(0,0,0,0.6)',
        transform: 'translate(-50%, -50%)', pointerEvents: 'none',
      }} />
    </div>
  )
}

/* ── Hue slider ── */
const HueSlider: React.FC<{ hue: number; onChangeHue: (h: number) => void }> = ({ hue, onChangeHue }) => {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const update = (cx: number) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      onChangeHue(Math.round(Math.max(0, Math.min(360, ((cx - rect.left) / rect.width) * 360))))
    }
    update(e.clientX)
    const onMove = (me: MouseEvent) => update(me.clientX)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChangeHue])

  return (
    <div
      ref={ref} onMouseDown={drag}
      style={{
        position: 'relative', width: '100%', height: SLIDER_H, borderRadius: SLIDER_H / 2, cursor: 'pointer',
        background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
      }}
    >
      <div style={{
        position: 'absolute',
        left: `${(hue / 360) * 100}%`, top: '50%',
        width: THUMB, height: THUMB, borderRadius: '50%',
        border: '2px solid #fff', boxShadow: '0 0 2px rgba(0,0,0,0.4)',
        transform: 'translate(-50%, -50%)', pointerEvents: 'none',
        background: hsvToHex({ h: hue, s: 100, v: 100 }),
      }} />
    </div>
  )
}

/* ── Opacity slider ── */
const OpacitySlider: React.FC<{ hex: string; opacity: number; onChange: (a: number) => void }> = ({ hex, opacity, onChange }) => {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const update = (cx: number) => {
      const rect = ref.current?.getBoundingClientRect()
      if (!rect) return
      onChange(Math.round(Math.max(0, Math.min(1, (cx - rect.left) / rect.width)) * 100) / 100)
    }
    update(e.clientX)
    const onMove = (me: MouseEvent) => update(me.clientX)
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onChange])

  return (
    <div
      ref={ref} onMouseDown={drag}
      style={{
        position: 'relative', width: '100%', height: SLIDER_H, borderRadius: SLIDER_H / 2, cursor: 'pointer',
        backgroundImage: `${CHECKERBOARD_BG}`,
        backgroundSize: '16px 16px',
      }}
    >
      <div style={{
        position: 'absolute', inset: 0, borderRadius: SLIDER_H / 2,
        background: `linear-gradient(to right, ${colorWithOpacity(hex, 0)}, ${hex})`,
      }} />
      <div style={{
        position: 'absolute',
        left: `${opacity * 100}%`, top: '50%',
        width: THUMB, height: THUMB, borderRadius: '50%',
        border: '2px solid #fff', boxShadow: '0 0 2px rgba(0,0,0,0.4)',
        transform: 'translate(-50%, -50%)', pointerEvents: 'none',
        background: colorWithOpacity(hex, opacity),
      }} />
    </div>
  )
}

/* ── Swatch grid for preset / document colors ── */
const SwatchGrid: React.FC<{
  colors: string[]
  label: string
  onPick: (hex: string, themeKey?: string) => void
  active?: string
  colorKeyMap?: Map<string, string>
}> = ({ colors, label, onPick, active, colorKeyMap }) => {
  if (!colors.length) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, color: t.textTertiary, marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {colors.map((c) => (
          <div
            key={c}
            onClick={() => onPick(c, colorKeyMap?.get(normalizeHex(c)))}
            title={c}
            style={{
              width: 18, height: 18, borderRadius: 3, cursor: 'pointer',
              background: c,
              border: active && normalizeHex(active) === normalizeHex(c)
                ? `2px solid ${t.accent}`
                : `1px solid ${t.border}`,
              boxSizing: 'border-box',
              transition: `border-color ${t.transitionFast}`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

/* ── Main picker popover ── */
export const ColorPickerPopover: React.FC<ColorPickerPopoverProps> = ({
  value, opacity: externalOpacity, showOpacity = false, onChange, onClose,
}) => {
  const translate = useT()
  const { themeColors, documentColors, themeColorKeyMap } = usePresentationColors()

  const initHex = useMemo(() => parseColorToHex(value) || '#000000', [value])
  const initOpacity = useMemo(() => externalOpacity ?? parseOpacity(value), [value, externalOpacity])

  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(initHex))
  const [opacity, setOpacity] = useState(initOpacity)
  const [hexInput, setHexInput] = useState(initHex.replace('#', ''))
  const [rgbInputs, setRgbInputs] = useState<RGB>(() => hexToRgb(initHex))

  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const hex = parseColorToHex(value) || '#000000'
    setHsv(hexToHsv(hex))
    setHexInput(hex.replace('#', ''))
    setRgbInputs(hexToRgb(hex))
    setOpacity(externalOpacity ?? parseOpacity(value))
  }, [value, externalOpacity])

  useEffect(() => {
    if (!onClose) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const timer = setTimeout(() => document.addEventListener('pointerdown', handler, true), 10)
    return () => { clearTimeout(timer); document.removeEventListener('pointerdown', handler, true) }
  }, [onClose])

  const commit = useCallback((hex: string, alpha: number, themeKey?: string) => {
    onChange(hex, showOpacity ? alpha : undefined, themeKey)
  }, [onChange, showOpacity])

  const handleSB = useCallback((s: number, v: number) => {
    const next = { ...hsv, s, v }
    setHsv(next)
    const hex = hsvToHex(next)
    setHexInput(hex.replace('#', ''))
    setRgbInputs(hexToRgb(hex))
    commit(hex, opacity)
  }, [hsv, opacity, commit])

  const handleHue = useCallback((h: number) => {
    const next = { ...hsv, h }
    setHsv(next)
    const hex = hsvToHex(next)
    setHexInput(hex.replace('#', ''))
    setRgbInputs(hexToRgb(hex))
    commit(hex, opacity)
  }, [hsv, opacity, commit])

  const handleOpacity = useCallback((a: number) => {
    setOpacity(a)
    commit(hsvToHex(hsv), a)
  }, [hsv, commit])

  const handleHexCommit = useCallback(() => {
    const raw = hexInput.startsWith('#') ? hexInput : `#${hexInput}`
    if (isValidHex(raw)) {
      const hex = normalizeHex(raw)
      const newHsv = hexToHsv(hex)
      setHsv(newHsv)
      setRgbInputs(hexToRgb(hex))
      commit(hex, opacity)
    } else {
      setHexInput(hsvToHex(hsv).replace('#', ''))
    }
  }, [hexInput, hsv, opacity, commit])

  const handleRgbChange = useCallback((channel: 'r' | 'g' | 'b', val: string) => {
    const num = Math.max(0, Math.min(255, parseInt(val) || 0))
    const next = { ...rgbInputs, [channel]: num }
    setRgbInputs(next)
    const hex = rgbToHex(next)
    const newHsv = hexToHsv(hex)
    setHsv(newHsv)
    setHexInput(hex.replace('#', ''))
    commit(hex, opacity)
  }, [rgbInputs, opacity, commit])

  const pickPreset = useCallback((hex: string, themeKey?: string) => {
    const n = normalizeHex(hex)
    setHsv(hexToHsv(n))
    setHexInput(n.replace('#', ''))
    setRgbInputs(hexToRgb(n))
    commit(n, opacity, themeKey)
  }, [opacity, commit])

  const currentHex = hsvToHex(hsv)
  const smInput: React.CSSProperties = {
    width: '100%', border: `1px solid ${t.border}`, borderRadius: 4,
    background: t.bgSurface, color: t.textPrimary, fontSize: 11,
    padding: '3px 6px', outline: 'none', boxSizing: 'border-box',
    fontFamily: 'monospace', textAlign: 'center',
  }

  return (
    <div
      ref={rootRef}
      style={{
        width: 240, padding: 12,
        background: t.bgApp, border: `1px solid ${t.border}`,
        borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <SatBrightArea hue={hsv.h} sat={hsv.s} bright={hsv.v} onChangeSB={handleSB} />

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <HueSlider hue={hsv.h} onChangeHue={handleHue} />
        {showOpacity && <OpacitySlider hex={currentHex} opacity={opacity} onChange={handleOpacity} />}
      </div>

      {/* Preview + Hex + Opacity */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 6,
          border: `1px solid ${t.border}`,
          backgroundImage: CHECKERBOARD_BG, backgroundSize: '16px 16px',
          position: 'relative', overflow: 'hidden', flexShrink: 0,
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: showOpacity ? colorWithOpacity(currentHex, opacity) : currentHex,
          }} />
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 10, color: t.textTertiary, width: 12 }}>#</span>
            <input
              type="text" value={hexInput}
              onChange={(e) => setHexInput(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
              onBlur={handleHexCommit}
              onKeyDown={(e) => { if (e.key === 'Enter') handleHexCommit() }}
              style={{ ...smInput, textAlign: 'left' }}
            />
            {showOpacity && (
              <input
                type="number" min={0} max={100} step={1}
                value={Math.round(opacity * 100)}
                onChange={(e) => handleOpacity(Math.max(0, Math.min(100, parseInt(e.target.value) || 0)) / 100)}
                style={{ ...smInput, width: 48 }}
              />
            )}
          </div>
        </div>
      </div>

      {/* RGB inputs */}
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
        {(['r', 'g', 'b'] as const).map((ch) => (
          <div key={ch}>
            <div style={{ fontSize: 9, color: t.textTertiary, textTransform: 'uppercase', textAlign: 'center', marginBottom: 2 }}>{ch}</div>
            <input
              type="number" min={0} max={255} step={1}
              value={rgbInputs[ch]}
              onChange={(e) => handleRgbChange(ch, e.target.value)}
              style={smInput}
            />
          </div>
        ))}
      </div>

      {/* Theme colors */}
      <SwatchGrid
        colors={themeColors}
        label={translate('colorPicker.themeColors')}
        onPick={pickPreset}
        active={currentHex}
        colorKeyMap={themeColorKeyMap}
      />

      {/* Document colors */}
      <SwatchGrid
        colors={documentColors}
        label={translate('colorPicker.documentColors')}
        onPick={pickPreset}
        active={currentHex}
      />
    </div>
  )
}

/* ── ColorSwatch with popover ── */

export interface ColorSwatchProps {
  value: string
  opacity?: number
  showOpacity?: boolean
  onChange: (hex: string, opacity?: number, themeKey?: string) => void
}

export const ColorSwatch: React.FC<ColorSwatchProps> = ({ value, opacity, showOpacity, onChange }) => {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({})

  const reposition = useCallback(() => {
    const anchor = wrapRef.current
    const pop = popRef.current
    if (!anchor || !pop) return

    const anchorRect = anchor.getBoundingClientRect()
    const popRect = pop.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const gap = 8
    const margin = 8

    let left: number
    const spaceLeft = anchorRect.left - margin
    const spaceRight = vw - anchorRect.right - margin

    if (spaceLeft >= popRect.width + gap) {
      left = anchorRect.left - popRect.width - gap
    } else if (spaceRight >= popRect.width + gap) {
      left = anchorRect.right + gap
    } else {
      left = Math.max(margin, Math.min(vw - popRect.width - margin, anchorRect.left - popRect.width / 2))
    }

    let top = anchorRect.top
    if (top + popRect.height > vh - margin) {
      top = vh - popRect.height - margin
    }
    if (top < margin) top = margin

    setPopoverStyle({ position: 'fixed', left, top, zIndex: ZIndex.global, visibility: 'visible' })
  }, [])

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(reposition)
    const onScroll = () => reposition()
    const onResize = () => reposition()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, reposition])

  const displayColor = useMemo(() => {
    if (showOpacity && opacity != null) return colorWithOpacity(value, opacity)
    return value
  }, [value, opacity, showOpacity])

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          width: 20, height: 20, borderRadius: t.radiusMd,
          border: open ? `2px solid ${t.accent}` : `1px solid ${t.border}`,
          backgroundColor: displayColor, cursor: 'pointer',
          boxSizing: 'border-box',
          backgroundImage: CHECKERBOARD_BG, backgroundSize: '16px 16px',
          position: 'relative', overflow: 'hidden',
        }}
      >
        <div style={{ position: 'absolute', inset: 0, background: displayColor }} />
      </div>

      {open && (
        <div ref={popRef} style={{ position: 'fixed', visibility: 'hidden', zIndex: ZIndex.global, ...popoverStyle }}>
          <ColorPickerPopover
            value={value}
            opacity={opacity}
            showOpacity={showOpacity}
            onChange={(hex, alpha, themeKey) => onChange(hex, alpha, themeKey)}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
