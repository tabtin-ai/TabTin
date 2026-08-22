import React, { useCallback, useEffect, useState } from 'react'
import type { PPTElement, PPTLatexElement } from '../../../../types/slides'
import {
  applyColorToLatexSvg,
  applyStrokeWidthToLatexSvg,
  buildLatexSvgFromPath,
  renderLatexSvgToPngDataUrl,
  renderLatexToSvg,
} from '../../../../utils/latex'
import { useT } from '../../../../i18n'
import { ColorSwatch, FieldLabel, PanelInput, PanelTextarea } from '../../shared/components'

export const LatexEditor: React.FC<{
  element: PPTLatexElement
  onUpdate: (id: string, updates: Partial<PPTElement>) => void
}> = ({ element, onUpdate }) => {
  const translate = useT()
  const [draft, setDraft] = useState(element.latex)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(element.latex)
    setError(null)
  }, [element.id, element.latex])

  const buildSvgWithCurrentGeometry = useCallback((): string => {
    if (element.svg) return element.svg
    if (element.path && element.viewBox) {
      return buildLatexSvgFromPath(
        element.path,
        element.viewBox,
        element.color || '#111827',
        element.strokeWidth || 0,
      )
    }
    return ''
  }, [element.color, element.path, element.strokeWidth, element.svg, element.viewBox])

  const refreshRaster = useCallback(
    async (svgMarkup: string) => {
      try {
        const raster = await renderLatexSvgToPngDataUrl(
          svgMarkup,
          Math.max(1, element.width),
          Math.max(1, element.height),
          3,
        )
        onUpdate(element.id, { rasterSrc: raster } as Partial<PPTElement>)
      } catch (err) {
        console.warn('[PropertyPanel] 公式位图更新失败:', err)
      }
    },
    [element.id, element.width, element.height, onUpdate],
  )

  const applyFormula = useCallback(async () => {
    const source = draft.trim()
    if (!source) {
      setError(translate('property.style.latex.errorEmpty'))
      return
    }

    try {
      setBusy(true)
      setError(null)
      const rendered = renderLatexToSvg(source, {
        display: true,
        color: element.color || '#111827',
      })
      const strokeWidth = Math.max(0, element.strokeWidth || 0)
      const nextSvg = applyStrokeWidthToLatexSvg(rendered.svg, strokeWidth)

      const updates: Partial<PPTLatexElement> = {
        latex: source,
        svg: nextSvg,
        path: rendered.path,
        viewBox: rendered.viewBox,
        fixedRatio: true,
      }

      onUpdate(element.id, updates as Partial<PPTElement>)
      await refreshRaster(nextSvg)
    } catch (err) {
      setError((err as Error).message || translate('property.style.latex.errorRenderFailed'))
    } finally {
      setBusy(false)
    }
  }, [draft, element.color, element.id, element.strokeWidth, onUpdate, refreshRaster, translate])

  const handleColorChange = useCallback((nextColor: string) => {
    const updates: Partial<PPTLatexElement> = { color: nextColor }
    const baseSvg = buildSvgWithCurrentGeometry()
    if (baseSvg) {
      let nextSvg = applyColorToLatexSvg(baseSvg, nextColor)
      nextSvg = applyStrokeWidthToLatexSvg(nextSvg, Math.max(0, element.strokeWidth || 0))
      updates.svg = nextSvg
      void refreshRaster(nextSvg)
    }
    onUpdate(element.id, updates as Partial<PPTElement>)
  }, [buildSvgWithCurrentGeometry, element.id, element.strokeWidth, onUpdate, refreshRaster])

  const handleStrokeWidthChange = useCallback((raw: string) => {
    const parsed = Number(raw)
    const nextStroke = Number.isFinite(parsed) ? Math.max(0, parsed) : 0
    const updates: Partial<PPTLatexElement> = { strokeWidth: nextStroke }

    const baseSvg = buildSvgWithCurrentGeometry()
    if (baseSvg) {
      let nextSvg = applyColorToLatexSvg(baseSvg, element.color || '#111827')
      nextSvg = applyStrokeWidthToLatexSvg(nextSvg, nextStroke)
      updates.svg = nextSvg
      void refreshRaster(nextSvg)
    }

    onUpdate(element.id, updates as Partial<PPTElement>)
  }, [buildSvgWithCurrentGeometry, element.color, element.id, onUpdate, refreshRaster])

  return (
    <div className="grid gap-1.5">
      <PanelTextarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void applyFormula()
          }
        }}
        placeholder={translate('property.style.latex.placeholder')}
        style={{
          minHeight: 64,
          resize: 'vertical',
          lineHeight: 1.5,
          fontFamily: 'Menlo, Consolas, monospace',
        }}
      />

      <div className="grid grid-cols-2 gap-1">
        <div>
          <FieldLabel>{translate('property.color')}</FieldLabel>
          <div className="flex items-center gap-1.5">
            <ColorSwatch value={element.color || '#111827'} onChange={handleColorChange} />
            <span className="text-body text-muted-foreground/60 font-mono">
              {element.color || '#111827'}
            </span>
          </div>
        </div>
        <div>
          <FieldLabel>{translate('property.style.latex.stroke')}</FieldLabel>
          <PanelInput
            type="number"
            min="0"
            max="8"
            step="0.2"
            value={element.strokeWidth || 0}
            onChange={(e) => handleStrokeWidthChange(e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-between items-center">
        <span className="text-caption text-muted-foreground/60">
          {translate('property.style.latex.hintApply')}
        </span>
        <button
          onClick={() => { void applyFormula() }}
          disabled={busy}
          className={`border-none rounded px-2.5 py-1 text-body font-medium text-white ${busy ? 'bg-muted-foreground/60 opacity-65 cursor-not-allowed' : 'bg-accent cursor-pointer'}`}
        >
          {busy ? translate('property.style.latex.rendering') : translate('property.apply')}
        </button>
      </div>

      {error && (
        <div className="text-body text-destructive">{error}</div>
      )}
    </div>
  )
}
