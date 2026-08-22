import React, { useEffect, useRef, useState } from 'react'
import { RangeSlider } from '../panels/right-sidebar/shared/components'
import { keymapManager, KeyboardPriority } from '../utils/keymap-manager'
import * as theme from '../theme'
import { ZIndex } from '@tabtin/app-shell'

const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3]
const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.1
const ZOOM_MAX = 5
const ZOOM_CAPSULE_WIDTH = 40
const ZOOM_BUTTON_SIZE = 32
const FLOATING_SHADOW = theme.shadowFloating
const ZOOM_ICON = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ZoomInIcon = () => (
  <svg {...ZOOM_ICON}>
    <line x1="12" y1="6" x2="12" y2="18" />
    <line x1="6" y1="12" x2="18" y2="12" />
  </svg>
)

const ZoomOutIcon = () => (
  <svg {...ZOOM_ICON}>
    <line x1="6" y1="12" x2="18" y2="12" />
  </svg>
)

const FitIcon = () => (
  <svg {...ZOOM_ICON}>
    <path d="M9 3H3v6" />
    <path d="M15 3h6v6" />
    <path d="M21 15v6h-6" />
    <path d="M3 15v6h6" />
  </svg>
)

interface ZoomControlsProps {
  zoom: number
  onZoomChange: (z: number) => void
  onFit: () => void
  t: (key: string) => string
  right?: number
  bottom?: number
  zIndex?: number
}

export const ZoomControls: React.FC<ZoomControlsProps> = ({
  zoom,
  onZoomChange,
  onFit,
  t,
  right = 10,
  bottom = 10,
  zIndex = ZIndex.banner,
}) => {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [presetPanelOpen, setPresetPanelOpen] = useState(false)
  const zoomPercent = Math.round(zoom * 100)
  const canZoomOut = zoom > ZOOM_MIN + 0.0001
  const canZoomIn = zoom < ZOOM_MAX - 0.0001
  const isZoom100 = Math.abs(zoom - 1) < 0.001

  const zoomIn = () => {
    if (!canZoomIn) return
    onZoomChange(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))
    setPresetPanelOpen(false)
  }
  const zoomOut = () => {
    if (!canZoomOut) return
    onZoomChange(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))
    setPresetPanelOpen(false)
  }
  const fitToScreen = () => {
    onFit()
    setPresetPanelOpen(false)
  }
  const set100 = () => {
    onZoomChange(1)
    setPresetPanelOpen(false)
  }

  useEffect(() => {
    if (!presetPanelOpen) return undefined
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setPresetPanelOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    const unregisterKeymap = keymapManager.register(KeyboardPriority.OVERLAY, (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPresetPanelOpen(false)
        return true
      }
    })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      unregisterKeymap()
    }
  }, [presetPanelOpen])

  const btnStyle: React.CSSProperties = {
    width: ZOOM_BUTTON_SIZE,
    height: ZOOM_BUTTON_SIZE,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: 0,
    borderRadius: theme.radiusSm,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: theme.textSecondary,
    transition: 'background 0.12s ease, color 0.12s ease',
  }
  const disabledBtnStyle: React.CSSProperties = {
    opacity: 0.4,
    cursor: 'default',
  }

  return (
    <div
      ref={rootRef}
      data-canvas-ui="true"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        bottom,
        right,
        zIndex,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        width: ZOOM_CAPSULE_WIDTH,
        background: theme.bgApp,
        borderRadius: theme.radiusMd,
        boxShadow: FLOATING_SHADOW,
        border: `1px solid ${theme.border}`,
        padding: '6px 0',
        userSelect: 'none',
      }}
    >
      <button
        type="button"
        className={canZoomIn ? 'tabslide-panel-item' : undefined}
        onClick={zoomIn}
        disabled={!canZoomIn}
        title={t('canvas.zoomIn')}
        style={{ ...btnStyle, ...(canZoomIn ? null : disabledBtnStyle), fontSize: 16, fontWeight: 600, lineHeight: 1 }}
      >
        <ZoomInIcon />
      </button>

      <button
        type="button"
        className={canZoomOut ? 'tabslide-panel-item' : undefined}
        onClick={zoomOut}
        disabled={!canZoomOut}
        title={t('canvas.zoomOut')}
        style={{ ...btnStyle, ...(canZoomOut ? null : disabledBtnStyle), fontSize: 16, fontWeight: 600, lineHeight: 1 }}
      >
        <ZoomOutIcon />
      </button>

      <div style={{ width: 24, height: 1, background: theme.borderLight, margin: '2px 0' }} />

      <button type="button" className="tabslide-panel-item" onClick={fitToScreen} title={t('canvas.fitToScreen')} style={btnStyle}>
        <FitIcon />
      </button>

      <button
        type="button"
        className={isZoom100 ? undefined : 'tabslide-panel-item'}
        onClick={set100}
        title={t('canvas.reset100')}
        style={{
          ...btnStyle,
          fontSize: 10,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          background: isZoom100 ? theme.accentBg : 'transparent',
          color: isZoom100 ? theme.accent : theme.textSecondary,
        }}
      >
        1:1
      </button>

      <div style={{ width: 24, height: 1, background: theme.borderLight, margin: '2px 0' }} />

      <button
        type="button"
        className="tabslide-panel-item"
        onClick={() => setPresetPanelOpen((prev) => !prev)}
        title={`${zoomPercent}%`}
        style={{
          ...btnStyle,
          fontSize: 10,
          fontWeight: 600,
          color: presetPanelOpen ? theme.accent : theme.textTertiary,
          background: presetPanelOpen ? theme.accentBg : 'transparent',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {zoomPercent}%
      </button>

      {presetPanelOpen && (
        <div
          data-canvas-ui="true"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            right: ZOOM_CAPSULE_WIDTH + 8,
            bottom: -1,
            width: 164,
            background: theme.bgApp,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusMd,
            boxShadow: FLOATING_SHADOW,
            padding: '10px 10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <RangeSlider
            min={10}
            max={300}
            step={5}
            value={zoomPercent}
            onChange={(v) => onZoomChange(v / 100)}
            title={`${zoomPercent}%`}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 4 }}>
            {ZOOM_PRESETS.map((preset) => {
              const presetPercent = Math.round(preset * 100)
              const active = Math.abs(preset - zoom) < 0.001
              return (
                <button
                  key={preset}
                  type="button"
                  className={active ? undefined : 'tabslide-panel-item'}
                  onClick={() => {
                    onZoomChange(preset)
                    setPresetPanelOpen(false)
                  }}
                  style={{
                    border: 'none',
                    borderRadius: theme.radiusSm,
                    background: active ? theme.accentBg : 'transparent',
                    color: active ? theme.accent : theme.textSecondary,
                    height: 24,
                    fontSize: 10,
                    fontVariantNumeric: 'tabular-nums',
                    cursor: 'pointer',
                    transition: 'background 0.12s ease, color 0.12s ease',
                    padding: 0,
                  }}
                >
                  {presetPercent}%
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
