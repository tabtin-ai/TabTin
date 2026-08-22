import React, { useCallback, useState, useRef, useEffect } from 'react'
import { renderLatexToSvg } from '../../utils/latex'
import * as t from '../../theme'
import { PanelWrapper, PanelSection } from './shared'
import { ColorSwatch } from '../../panels/right-sidebar/shared/components'

type Translate = (key: string, options?: Record<string, unknown>) => string

const MAX_LATEX_INPUT = 4096
const PREVIEW_DEBOUNCE_MS = 300
const LATEX_PANEL_WIDTH = 340

const LATEX_PRESETS: Array<{ key: string; latex: string }> = [
  { key: 'insert.latex.presets.quadratic', latex: String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}` },
  { key: 'insert.latex.presets.gaussian', latex: String.raw`f(x)=\frac{1}{\sigma\sqrt{2\pi}}e^{-\frac{(x-\mu)^2}{2\sigma^2}}` },
  { key: 'insert.latex.presets.euler', latex: String.raw`e^{i\pi}+1=0` },
]

function normalizeSvgForPreview(svgString: string): string {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgString, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) return svgString
    svg.removeAttribute('width')
    svg.removeAttribute('height')
    svg.removeAttribute('preserveAspectRatio')
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', '100%')
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return svgString
  }
}

export const LatexPanel: React.FC<{
  onInsert: (payload: { latex: string; color: string }) => Promise<void>
  translate: Translate
  width?: React.CSSProperties['width']
}> = ({ onInsert, translate, width = LATEX_PANEL_WIDTH }) => {
  const [latex, setLatex] = useState(String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`)
  const [color, setColor] = useState('#111827')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      try {
        const rendered = renderLatexToSvg(latex, { display: true, color })
        setPreview(rendered.svg)
      } catch {
        setPreview(null)
      }
    }, PREVIEW_DEBOUNCE_MS)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [latex, color])

  const handleInsert = useCallback(async () => {
    const trimmed = latex.trim()
    if (!trimmed) {
      setError(translate('insert.latex.errors.empty'))
      return
    }

    try {
      setBusy(true)
      setError(null)
      renderLatexToSvg(trimmed, { display: true, color })
      await onInsert({ latex: trimmed, color })
    } catch (err) {
      setError((err as Error).message || translate('insert.latex.errors.renderFailed'))
    } finally {
      setBusy(false)
    }
  }, [latex, color, onInsert, translate])

  return (
    <PanelWrapper width={width} style={{ padding: '4px 0' }}>
      <PanelSection title={translate('insert.latex.title')}>
        <textarea
          className="tabslide-panel-input"
          value={latex}
          maxLength={MAX_LATEX_INPUT}
          onChange={(e) => {
            setLatex(e.target.value)
            setError(null)
          }}
          placeholder={translate('insert.latex.placeholder')}
          style={{
            width: '100%',
            minHeight: 76,
            resize: 'vertical',
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusMd,
            padding: '8px 12px',
            fontSize: 13,
            lineHeight: 1.5,
            fontFamily: 'Menlo, Consolas, "SF Mono", monospace',
            boxSizing: 'border-box',
            outline: 'none',
            color: t.textPrimary,
            background: t.bgSurface,
            transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          }}
        />
        {latex.length > MAX_LATEX_INPUT * 0.8 && (
          <div style={{ fontSize: 11, color: latex.length >= MAX_LATEX_INPUT ? t.danger : t.textTertiary, textAlign: 'right', marginTop: 2 }}>
            {latex.length} / {MAX_LATEX_INPUT}
          </div>
        )}

        {/* Preview area */}
        <div style={{
          height: 72,
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusMd,
          background: t.bgSurface,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          marginTop: 8,
        }}>
          {preview ? (
            <div
              style={{ width: '100%', height: '100%', color }}
              dangerouslySetInnerHTML={{ __html: normalizeSvgForPreview(preview) }}
            />
          ) : (
            <span style={{ fontSize: 12, color: t.textSecondary }}>{translate('insert.latex.previewUnavailable')}</span>
          )}
        </div>

        {/* Error message */}
        {error && (
          <div style={{
            marginTop: 8,
            fontSize: 12,
            color: t.danger,
            padding: '6px 10px',
            background: t.dangerBg,
            borderRadius: t.radiusSm,
            lineHeight: 1.4,
          }}>
            {error}
          </div>
        )}

        {/* Quick presets */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {LATEX_PRESETS.map((item) => (
            <button
              key={item.key}
              className="tabslide-tag-btn"
              onClick={() => setLatex(item.latex)}
              style={{
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusSm,
                padding: '4px 10px',
                background: t.bgSurface,
                color: t.textSecondary,
                fontSize: 12,
                cursor: 'pointer',
                transition: 'border-color 0.12s ease, color 0.12s ease, background 0.12s ease',
              }}
            >
              {translate(item.key)}
            </button>
          ))}
        </div>
      </PanelSection>

      {/* Footer — 对齐 TabData: border-t px-4 py-3 */}
      <div style={{
        borderTop: `1px solid ${t.border}`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, color: t.textSecondary }}>{translate('insert.latex.color')}</span>
          <ColorSwatch value={color} onChange={(v) => setColor(v)} />
        </div>
        <button
          onClick={handleInsert}
          disabled={busy}
          style={{
            marginLeft: 'auto',
            border: 'none',
            borderRadius: t.radiusMd,
            padding: '6px 16px',
            fontSize: 13,
            fontWeight: 500,
            cursor: busy ? 'not-allowed' : 'pointer',
            color: '#fff',
            background: busy ? t.textTertiary : t.accent,
            opacity: busy ? 0.6 : 1,
            transition: 'opacity 0.12s ease, background 0.12s ease',
          }}
        >
          {busy ? translate('insert.latex.processing') : translate('insert.latex.submit')}
        </button>
      </div>
    </PanelWrapper>
  )
}
