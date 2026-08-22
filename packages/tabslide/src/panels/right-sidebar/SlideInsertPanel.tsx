import React, { useCallback, useState, useRef } from 'react'
import { useSlideStore } from '../../store/slide'
import { createElementId } from '../../utils/id'
import { createTableElement } from '../../utils/factory'
import { validateImageFile, resolveImageSrc, createImageElement } from '../../utils/image'
import { ShapePathFormulas } from '../../configs/shapes'
import { renderLatexToSvg, renderLatexSvgToPngDataUrl } from '../../utils/latex'
import { useT } from '../../i18n'
import * as D from '../../defaults/colors'
import type {
  PPTTextElement,
  PPTShapeElement,
  PPTLineElement,
  PPTLatexElement,
  PPTChartElement,
  ChartType,
} from '../../types/slides'
import type { ShapePreset } from '../../configs/shapes'
import type { LineTypeOption } from '../../toolbar/insert-panels/LinePanel'

import { ShapePanel } from '../../toolbar/insert-panels/ShapePanel'
import { LinePanel } from '../../toolbar/insert-panels/LinePanel'
import { TableGridPicker } from '../../toolbar/insert-panels/TableGridPicker'
import { ChartPanel, getDefaultChartPayload } from '../../toolbar/insert-panels/ChartPanel'
import { LatexPanel } from '../../toolbar/insert-panels/LatexPanel'
import {
  IconText, IconImage, IconShape, IconLine,
  IconTable, IconChart, IconLatex,
} from '../../toolbar/insert-panels/icons'
import { InsertCard } from './shared/components'

const INSERT_CARD_MIN_WIDTH = 72
const INLINE_PANEL_WIDTH = '100%' as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InsertCardDef {
  id: string
  labelKey: string
  icon: React.ReactNode
}

type ExpandedPanel = 'shape' | 'line' | 'table' | 'chart' | 'latex' | null

const InsertSectionPanel: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="border-b border-border/10">
    <div className="flex h-8 select-none items-center gap-1 px-3">
      <span className="truncate text-body font-medium tracking-tight text-muted-foreground">
        {title}
      </span>
    </div>
    <div className="min-w-0 overflow-hidden px-3 pb-2">
      {children}
    </div>
  </section>
)

// ---------------------------------------------------------------------------
// Card definitions
// ---------------------------------------------------------------------------

const CARDS: InsertCardDef[] = [
  { id: 'text', labelKey: 'insert.text', icon: <IconText /> },
  { id: 'image', labelKey: 'insert.image', icon: <IconImage /> },
  { id: 'shape', labelKey: 'insert.shape', icon: <IconShape /> },
  { id: 'line', labelKey: 'insert.line.title', icon: <IconLine /> },
  { id: 'table', labelKey: 'insert.table.title', icon: <IconTable /> },
  { id: 'chart', labelKey: 'insert.chart.title', icon: <IconChart /> },
  { id: 'latex', labelKey: 'insert.latex.title', icon: <IconLatex /> },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SlideInsertPanelProps {
  onUploadImage?: (file: File) => Promise<string>
  onError?: (type: 'validation' | 'upload' | 'load', message: string) => void
}

export const SlideInsertPanel: React.FC<SlideInsertPanelProps> = ({ onUploadImage, onError }) => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const addElement = useSlideStore((s) => s.addElement)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState<ExpandedPanel>(null)

  // ── Insert handlers ──

  const insertText = useCallback(() => {
    const el: PPTTextElement = {
      id: createElementId(),
      type: 'text',
      x: 300, y: 300, width: 400, height: 80,
      rotate: 0, opacity: 1, locked: false,
      content: `<p><span style="font-size:24px">${translate('insert.defaultText')}</span></p>`,
      defaultFontName: D.FONT_NAME,
      defaultFontSize: 24,
      defaultColor: D.TEXT_COLOR,
    }
    addElement(el)
  }, [addElement, translate])

  const handleImageFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''

      const validation = validateImageFile(file)
      if (!validation.valid) {
        onError?.('validation', validation.reason ?? 'invalid')
        return
      }

      try {
        const { src, fallback } = await resolveImageSrc(file, onUploadImage)
        if (fallback) onError?.('upload', 'fallback_base64')
        const el = await createImageElement(src, { x: 300, y: 200, offlinePendingUpload: fallback })
        addElement(el)
      } catch (err) {
        onError?.('load', err instanceof Error ? err.message : 'unknown')
      }
    },
    [addElement, onUploadImage, onError],
  )

  const insertImage = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const insertShape = useCallback(
    (preset: ShapePreset) => {
      const w = preset.viewBox[0]
      const h = preset.viewBox[1]
      const formula = preset.pathFormula ? ShapePathFormulas[preset.pathFormula] : undefined
      const path = formula ? formula.formula(w, h, preset.keypoints ?? formula.defaultValue) : preset.path
      const el: PPTShapeElement = {
        id: createElementId(),
        type: 'shape',
        x: 400, y: 250, width: w, height: h,
        rotate: 0, opacity: 1, locked: false,
        viewBox: [w, h],
        path,
        fixedRatio: preset.fixedRatio ?? false,
        fill: D.BRAND_COLOR,
        pathFormula: preset.pathFormula,
        keypoints: preset.keypoints ? [...preset.keypoints] : undefined,
        pptxShapeType: preset.pptxShapeType,
      }
      addElement(el)
      setExpanded(null)
    },
    [addElement],
  )

  const insertLine = useCallback(
    (lineType: LineTypeOption) => {
      const el: PPTLineElement = {
        id: createElementId(),
        type: 'line',
        x: 300, y: 400, width: 400,
        opacity: 1, locked: false,
        start: [0, lineType.startY ?? 0],
        end: [400, lineType.endY ?? 0],
        style: lineType.style || 'solid',
        color: D.TEXT_COLOR,
        lineWidth: 2,
        points: [lineType.startPoint || '', lineType.endPoint || ''],
        ...(lineType.curve ? { curve: lineType.curve } : {}),
        ...(lineType.broken ? { broken: lineType.broken } : {}),
        ...(lineType.broken2 ? { broken2: lineType.broken2 } : {}),
        ...(lineType.cubic ? { cubic: lineType.cubic } : {}),
      }
      addElement(el)
      setExpanded(null)
    },
    [addElement],
  )

  const insertTable = useCallback(
    (rows: number, cols: number) => {
      addElement(createTableElement(rows, cols))
      setExpanded(null)
    },
    [addElement],
  )

  const insertChart = useCallback(
    (chartType: ChartType) => {
      const defaults = getDefaultChartPayload(chartType, translate)
      const themeColors = presentation?.theme?.themeColors?.length
        ? [...presentation.theme.themeColors]
        : ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47']
      const el: PPTChartElement = {
        id: createElementId(),
        type: 'chart',
        x: 260, y: 180, width: 560, height: 320,
        rotate: 0, opacity: 1, locked: false,
        chartType,
        data: defaults.data,
        options: defaults.options,
        chartTitle: defaults.chartTitle,
        themeColors,
      }
      addElement(el)
      setExpanded(null)
    },
    [addElement, presentation, translate],
  )

  const insertLatex = useCallback(
    async (payload: { latex: string; color: string }) => {
      const rendered = renderLatexToSvg(payload.latex, { display: true, color: payload.color })
      const [vbW, vbH] = rendered.viewBox
      const ratio = vbH > 0 ? vbW / vbH : 3
      let width = Math.round(90 * ratio)
      let height = 90
      if (width > 680) { const r = 680 / width; width = 680; height = Math.round(height * r) }
      if (height > 240) { const r = 240 / height; height = 240; width = Math.round(width * r) }
      if (width < 120) { width = 120; height = Math.round(width / ratio) }
      if (height < 40) { height = 40; width = Math.round(height * ratio) }
      const canvasW = presentation?.canvasWidth || 1280
      const canvasH = presentation?.canvasHeight || 720
      const x = Math.max(0, Math.round((canvasW - width) / 2))
      const y = Math.max(0, Math.round((canvasH - height) / 2))
      let rasterSrc: string | undefined
      try { rasterSrc = await renderLatexSvgToPngDataUrl(rendered.svg, width, height, 3) } catch {}
      const el: PPTLatexElement = {
        id: createElementId(),
        type: 'latex',
        x, y, width, height,
        rotate: 0, opacity: 1, locked: false,
        latex: payload.latex,
        svg: rendered.svg,
        path: rendered.path,
        viewBox: rendered.viewBox,
        color: payload.color,
        strokeWidth: 0,
        fixedRatio: true,
        ...(rasterSrc ? { rasterSrc } : {}),
      }
      addElement(el)
      setExpanded(null)
    },
    [addElement, presentation],
  )

  // ── Card click handler ──

  const handleCardClick = useCallback((id: string) => {
    switch (id) {
      case 'text': insertText(); break
      case 'image': insertImage(); break
      case 'shape': setExpanded((p) => p === 'shape' ? null : 'shape'); break
      case 'line': setExpanded((p) => p === 'line' ? null : 'line'); break
      case 'table': setExpanded((p) => p === 'table' ? null : 'table'); break
      case 'chart': setExpanded((p) => p === 'chart' ? null : 'chart'); break
      case 'latex': setExpanded((p) => p === 'latex' ? null : 'latex'); break
    }
  }, [insertText, insertImage])

  return (
    <InsertSectionPanel title={translate('insert.title')}>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${INSERT_CARD_MIN_WIDTH}px, 1fr))` }}
        >
          {CARDS.map((card) => (
            <InsertCard
              key={card.id}
              active={expanded === card.id}
              icon={card.icon}
              label={translate(card.labelKey as any)}
              title={translate(card.labelKey as any)}
              onClick={() => handleCardClick(card.id)}
            />
          ))}
        </div>

        {expanded === 'shape' && (
          <div className="min-w-0 overflow-hidden rounded-md bg-muted/40 p-2">
            <ShapePanel width={INLINE_PANEL_WIDTH} onInsert={insertShape} translate={translate} />
          </div>
        )}
        {expanded === 'line' && (
          <div className="min-w-0 overflow-hidden rounded-md bg-muted/40 p-2">
            <LinePanel width={INLINE_PANEL_WIDTH} onInsert={insertLine} translate={translate} />
          </div>
        )}
        {expanded === 'table' && (
          <div className="min-w-0 overflow-hidden rounded-md bg-muted/40 p-2">
            <TableGridPicker width={INLINE_PANEL_WIDTH} onInsert={insertTable} translate={translate} />
          </div>
        )}
        {expanded === 'chart' && (
          <div className="min-w-0 overflow-hidden rounded-md bg-muted/40 p-2">
            <ChartPanel width={INLINE_PANEL_WIDTH} onInsert={insertChart} translate={translate} />
          </div>
        )}
        {expanded === 'latex' && (
          <div className="min-w-0 overflow-hidden rounded-md bg-muted/40 p-2">
            <LatexPanel width={INLINE_PANEL_WIDTH} onInsert={insertLatex} translate={translate} />
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageFileChange}
      />
    </InsertSectionPanel>
  )
}
