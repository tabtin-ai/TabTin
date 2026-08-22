import React from 'react'
import type { PPTElementOutline, PPTElementShadow } from '../../../../types/slides'
import { useT } from '../../../../i18n'
import { colorWithAlpha, extractColorAlpha, toColorInputHex } from '../../shared/constants'
import { ColorSwatch, FieldLabel, PanelInput, PanelSelect, RangeSlider } from '../../shared/components'

export const OutlineEditor: React.FC<{
  outline?: PPTElementOutline
  onChange: (v: PPTElementOutline | undefined) => void
  themePalette?: Array<{ key: string; label: string; color: string }>
}> = ({ outline, onChange, themePalette }) => {
  const translate = useT()
  const hasOutline = !!outline
  const toggle = () => {
    if (hasOutline) { onChange(undefined) }
    else { onChange({ style: 'solid', width: 1, color: '#000000' }) }
  }

  return (
    <div>
      <div className={`flex items-center gap-1.5 ${hasOutline ? 'mb-1.5' : ''}`}>
        <input type="checkbox" checked={hasOutline} onChange={toggle} className="accent-[hsl(var(--accent))]" />
        <span className="text-body text-muted-foreground">
          {hasOutline ? translate('property.enabled') : translate('property.style.outline.none')}
        </span>
      </div>
      {hasOutline && outline && (
        <div className="grid grid-cols-2 gap-1">
          <div>
            <FieldLabel>{translate('property.color')}</FieldLabel>
            <ColorSwatch
              value={toColorInputHex(outline.color)}
              onChange={(v) => {
                const alpha = extractColorAlpha(outline.color)
                onChange({ ...outline, color: colorWithAlpha(v, alpha), themeKey: undefined })
              }}
            />
          </div>
          <div>
            <FieldLabel>{translate('property.style.outline.width')}</FieldLabel>
            <PanelInput
              type="number" min="0.5" max="20" step="0.5"
              value={outline.width}
              onChange={(e) => onChange({ ...outline, width: +e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <FieldLabel>{translate('property.style.outline.style')}</FieldLabel>
            <PanelSelect
              value={outline.style}
              onChange={(e) => onChange({ ...outline, style: e.target.value as PPTElementOutline['style'] })}
            >
              <option value="solid">{translate('property.style.line.styleOptions.solid')}</option>
              <option value="dashed">{translate('property.style.line.styleOptions.dashed')}</option>
              <option value="dotted">{translate('property.style.line.styleOptions.dotted')}</option>
              <option value="dashDot">{translate('property.style.line.styleOptions.dashDot')}</option>
              <option value="longDash">{translate('property.style.line.styleOptions.longDash')}</option>
              <option value="longDashDot">{translate('property.style.line.styleOptions.longDashDot')}</option>
            </PanelSelect>
          </div>
          <div className="col-span-2">
            <FieldLabel>{translate('property.style.fill.opacity')}</FieldLabel>
            <div className="flex items-center gap-1.5">
              <RangeSlider
                min={0} max={1} step={0.01}
                value={extractColorAlpha(outline.color)}
                onChange={(v) => onChange({
                  ...outline,
                  color: colorWithAlpha(outline.color, v),
                  themeKey: undefined,
                })}
                className="flex-1"
              />
              <span className="text-body text-muted-foreground/60 min-w-7 text-right">
                {Math.round(extractColorAlpha(outline.color) * 100)}%
              </span>
            </div>
          </div>
          {themePalette && themePalette.length > 0 && (
            <div className="col-span-2 mt-0.5">
              <FieldLabel>{translate('property.style.themeColor')}</FieldLabel>
              <div className="grid grid-cols-7 gap-1">
                {themePalette.slice(0, 14).map((item) => {
                  const isActive = outline.themeKey === item.key
                  return (
                    <button
                      key={item.key}
                      title={`${item.label} · ${item.color}`}
                      onClick={() => {
                        const alpha = extractColorAlpha(outline.color)
                        onChange({ ...outline, color: colorWithAlpha(item.color, alpha), themeKey: item.key })
                      }}
                      className="flex flex-col items-center gap-0.5 bg-transparent border-none p-0.5 cursor-pointer"
                    >
                      <span
                        className={`w-3.5 h-3.5 rounded-full box-border ${isActive ? 'border-2 border-accent' : 'border border-border/30'}`}
                        style={{ background: item.color }}
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const ShadowEditor: React.FC<{
  shadow?: PPTElementShadow
  onChange: (v: PPTElementShadow | undefined) => void
}> = ({ shadow, onChange }) => {
  const translate = useT()
  const hasShadow = !!shadow
  const toggle = () => {
    if (hasShadow) { onChange(undefined) }
    else { onChange({ h: 2, v: 2, blur: 8, color: 'rgba(0,0,0,0.15)' }) }
  }

  return (
    <div>
      <div className={`flex items-center gap-1.5 ${hasShadow ? 'mb-1.5' : ''}`}>
        <input type="checkbox" checked={hasShadow} onChange={toggle} className="accent-[hsl(var(--accent))]" />
        <span className="text-body text-muted-foreground">
          {hasShadow ? translate('property.enabled') : translate('property.style.shadow.none')}
        </span>
      </div>
      {hasShadow && shadow && (
        <div className="grid grid-cols-2 gap-1">
          <div>
            <FieldLabel>{translate('property.style.shadow.offsetX')}</FieldLabel>
            <PanelInput type="number" value={shadow.h} onChange={(e) => onChange({ ...shadow, h: +e.target.value })} />
          </div>
          <div>
            <FieldLabel>{translate('property.style.shadow.offsetY')}</FieldLabel>
            <PanelInput type="number" value={shadow.v} onChange={(e) => onChange({ ...shadow, v: +e.target.value })} />
          </div>
          <div>
            <FieldLabel>{translate('property.style.shadow.blur')}</FieldLabel>
            <PanelInput type="number" min="0" max="100" value={shadow.blur} onChange={(e) => onChange({ ...shadow, blur: +e.target.value })} />
          </div>
          <div>
            <FieldLabel>{translate('property.color')}</FieldLabel>
            <div className="flex items-center gap-1.5">
              <ColorSwatch
                value={toColorInputHex(shadow.color)}
                opacity={extractColorAlpha(shadow.color)}
                showOpacity
                onChange={(hex, op) => onChange({ ...shadow, color: colorWithAlpha(hex, op ?? extractColorAlpha(shadow.color)) })}
              />
              <PanelInput type="text" value={shadow.color} onChange={(e) => onChange({ ...shadow, color: e.target.value })} className="flex-1"
                placeholder={translate('property.style.shadow.colorPlaceholder')} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
