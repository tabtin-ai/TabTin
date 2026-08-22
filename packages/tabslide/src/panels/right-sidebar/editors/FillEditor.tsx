import React, { useState, useEffect } from 'react'
import type { Gradient, GradientStop } from '../../../types/slides'
import { useT } from '../../../i18n'
import { resolveImageSrc } from '../../../utils/image'
import {
  ColorSwatch, FieldLabel, RangeSlider,
  PanelSelect, PanelInput, PanelToggleButton, PanelButtonGroup, NumberInput,
} from '../shared/components'
import { toColorInputHex, extractColorAlpha, colorWithAlpha } from '../shared/constants'

export const FillEditor: React.FC<{
  fill?: string
  gradient?: Gradient
  pattern?: string
  modeOverride?: 'solid' | 'gradient' | 'pattern'
  opacity?: number
  onFillChange: (v: string) => void
  onGradientChange: (g: Gradient) => void
  onPatternChange: (v?: string) => void
  onOpacityChange?: (v: number) => void
  onUploadImage?: (file: File) => Promise<string>
}> = ({ fill, gradient, pattern, modeOverride, opacity, onFillChange, onGradientChange, onPatternChange, onOpacityChange, onUploadImage }) => {
  const translate = useT()
  const [mode, setMode] = useState<'solid' | 'gradient' | 'pattern'>(
    modeOverride || (pattern ? 'pattern' : gradient ? 'gradient' : 'solid'),
  )
  const [selectedStopIdx, setSelectedStopIdx] = useState(0)
  const [patternInput, setPatternInput] = useState(pattern || '')

  useEffect(() => {
    setMode(modeOverride || (pattern ? 'pattern' : gradient ? 'gradient' : 'solid'))
  }, [gradient, pattern, modeOverride])

  useEffect(() => {
    setPatternInput(pattern || '')
  }, [pattern])

  const switchMode = (m: 'solid' | 'gradient' | 'pattern') => {
    setMode(m)
    if (m === 'solid') {
      onPatternChange(undefined)
      const fallbackColor = gradient?.colors?.[0]?.color || fill || '#5b9bd5'
      onFillChange(fallbackColor)
    } else if (m === 'gradient') {
      onPatternChange(undefined)
      onGradientChange({
        type: 'linear',
        rotate: 0,
        colors: [
          { pos: 0, color: fill || '#5b9bd5' },
          { pos: 1, color: '#ffffff' },
        ],
      })
    }
  }

  const updateStop = (idx: number, patch: Partial<GradientStop>) => {
    if (!gradient) return
    const newColors = gradient.colors.map((s, i) => i === idx ? { ...s, ...patch } : s)
    onGradientChange({ ...gradient, colors: newColors })
  }

  const addStop = () => {
    if (!gradient) return
    const newStop = { pos: 0.5, color: '#888888' }
    const newColors = [...gradient.colors, newStop].sort((a, b) => a.pos - b.pos)
    onGradientChange({ ...gradient, colors: newColors })
    const idx = newColors.indexOf(newStop)
    setSelectedStopIdx(idx >= 0 ? idx : newColors.length - 1)
  }

  const removeStop = () => {
    if (!gradient || gradient.colors.length <= 2) return
    const newColors = gradient.colors.filter((_, i) => i !== selectedStopIdx)
    onGradientChange({ ...gradient, colors: newColors })
    setSelectedStopIdx(Math.max(0, selectedStopIdx - 1))
  }

  const gradientCSS = gradient
    ? gradient.type === 'radial'
      ? `radial-gradient(circle at ${typeof gradient.center?.x === 'number' ? Math.round(gradient.center.x * 100) : 50}% ${typeof gradient.center?.y === 'number' ? Math.round(gradient.center.y * 100) : 50}%, ${gradient.colors.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})`
      : `linear-gradient(${(gradient.rotate + 90) % 360}deg, ${gradient.colors.map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})`
    : undefined

  return (
    <div>
      <PanelButtonGroup className="mb-2 w-full">
        {(['solid', 'gradient', 'pattern'] as const).map((m) => (
          <PanelToggleButton
            key={m}
            active={mode === m}
            onClick={() => switchMode(m)}
          >
            {m === 'solid'
              ? translate('property.style.fill.modeSolid')
              : m === 'gradient'
                ? translate('property.style.fill.modeGradient')
                : translate('property.style.fill.modeImage')}
          </PanelToggleButton>
        ))}
      </PanelButtonGroup>

      {mode === 'solid' ? (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <ColorSwatch value={fill || '#000000'} onChange={onFillChange} />
            <span className="font-mono text-caption text-muted-foreground">
              {fill || '—'}
            </span>
          </div>
          {onOpacityChange && (
            <div>
              <FieldLabel>{translate('property.style.fill.opacity')}</FieldLabel>
              <div className="flex items-center gap-1.5">
                <RangeSlider
                  min={0} max={1} step={0.01}
                  value={opacity ?? 1}
                  onChange={(v) => onOpacityChange(v)}
                  style={{ flex: 1 }}
                />
                <span className="min-w-[28px] text-right text-caption tabular-nums text-muted-foreground">
                  {Math.round((opacity ?? 1) * 100)}%
                </span>
              </div>
            </div>
          )}
        </div>
      ) : mode === 'gradient' && gradient ? (
        <div>
          <div className="mb-1.5 grid grid-cols-2 gap-1">
            <div>
              <FieldLabel>{translate('property.style.fill.gradientType')}</FieldLabel>
              <PanelSelect
                value={gradient.type}
                onChange={(e) => onGradientChange({ ...gradient, type: e.target.value as 'linear' | 'radial' })}
              >
                <option value="linear">{translate('property.style.fill.gradientTypeLinear')}</option>
                <option value="radial">{translate('property.style.fill.gradientTypeRadial')}</option>
              </PanelSelect>
            </div>
            {gradient.type === 'linear' && (
              <div>
                <FieldLabel>{translate('property.style.fill.angle')}</FieldLabel>
                <NumberInput
                  value={gradient.rotate}
                  onChange={(v) => onGradientChange({ ...gradient, rotate: v })}
                  min={0} max={360} step={15} suffix="°"
                  fullWidth
                />
              </div>
            )}
          </div>

          <div
            className="relative mb-1.5 h-5 cursor-crosshair rounded"
            style={{ background: gradientCSS }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pos = (e.clientX - rect.left) / rect.width
              const newStop = { pos, color: '#888888' }
              const newColors = [...gradient.colors, newStop].sort((a, b) => a.pos - b.pos)
              onGradientChange({ ...gradient, colors: newColors })
              const idx = newColors.indexOf(newStop)
              setSelectedStopIdx(idx >= 0 ? idx : newColors.length - 1)
            }}
          >
            {gradient.colors.map((stop, idx) => (
              <div
                key={idx}
                onClick={(e) => { e.stopPropagation(); setSelectedStopIdx(idx) }}
                className="absolute -top-0.5 cursor-pointer"
                style={{
                  left: `${stop.pos * 100}%`,
                  transform: 'translateX(-50%)',
                  width: 8, height: 24,
                  borderRadius: 2,
                  border: `2px solid ${selectedStopIdx === idx ? 'hsl(var(--accent))' : '#fff'}`,
                  background: stop.color,
                  boxShadow: '0 0 2px rgba(0,0,0,0.3)',
                  zIndex: selectedStopIdx === idx ? 2 : 1,
                }}
              />
            ))}
          </div>

          {gradient.colors[selectedStopIdx] && (
            <div className="grid grid-cols-2 gap-1">
              <div>
                <FieldLabel>{translate('property.color')}</FieldLabel>
                <ColorSwatch
                  value={toColorInputHex(gradient.colors[selectedStopIdx].color)}
                  opacity={extractColorAlpha(gradient.colors[selectedStopIdx].color)}
                  showOpacity
                  onChange={(hex, op) => updateStop(selectedStopIdx, {
                    color: colorWithAlpha(hex, op ?? extractColorAlpha(gradient.colors[selectedStopIdx].color)),
                  })}
                />
              </div>
              <div>
                <FieldLabel>{translate('property.style.fill.positionPercent')}</FieldLabel>
                <NumberInput
                  value={Math.round(gradient.colors[selectedStopIdx].pos * 100)}
                  onChange={(v) => updateStop(selectedStopIdx, { pos: v / 100 })}
                  min={0} max={100} step={1} suffix="%"
                  fullWidth
                />
              </div>
            </div>
          )}

          <div className="mt-1 flex gap-1">
            <button
              onClick={addStop}
              className="flex-1 rounded bg-muted/40 py-1 text-body text-muted-foreground transition-colors hover:bg-muted/60"
            >
              {translate('property.style.fill.addStop')}
            </button>
            <button
              onClick={removeStop}
              disabled={gradient.colors.length <= 2}
              className="flex-1 rounded bg-muted/40 py-1 text-body text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-40"
            >
              {translate('property.style.fill.removeStop')}
            </button>
          </div>
        </div>
      ) : mode === 'pattern' ? (
        <div className="grid gap-1.5">
          <div>
            <FieldLabel>{translate('property.style.fill.selectImage')}</FieldLabel>
            <div className="flex gap-1">
              <button
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/*'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (!file) return
                    resolveImageSrc(file, onUploadImage).then(({ src }) => {
                      setPatternInput(src)
                      onPatternChange(src)
                    })
                  }
                  input.click()
                }}
                className="flex-1 rounded bg-accent/10 py-1.5 text-body font-medium text-accent transition-colors hover:bg-accent/20"
              >
                {translate('property.style.fill.uploadLocalImage')}
              </button>
              <button
                onClick={() => { setPatternInput(''); onPatternChange(undefined) }}
                className="rounded bg-muted/40 px-2 py-1.5 text-body text-muted-foreground transition-colors hover:bg-muted/60"
              >
                {translate('property.clear')}
              </button>
            </div>
          </div>
          {patternInput && (
            <div
              className="h-14 rounded-md bg-cover bg-center"
              style={{ backgroundImage: `url(${patternInput})` }}
            />
          )}
          <div>
            <FieldLabel>{translate('property.style.fill.inputImageUrl')}</FieldLabel>
            <PanelInput
              type="text"
              value={patternInput.startsWith('data:') ? '' : patternInput}
              onChange={(e) => {
                const next = e.target.value
                setPatternInput(next)
                onPatternChange(next.trim() ? next.trim() : undefined)
              }}
              placeholder={translate('property.style.link.placeholder.web')}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
