import React, { useCallback, useState, useRef, useEffect } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { createElementId } from '../utils/id'
import { createTableElement } from '../utils/factory'
import { ScrollArea } from '../components/ui/ScrollArea'
import type {
  PPTTextElement,
  PPTImageElement,
  PPTShapeElement,
  PPTLineElement,
  PPTLatexElement,
  PPTChartElement,
  ChartType,
} from '../types/slides'
import { ShapePathFormulas } from '../configs/shapes'
import type { ShapePreset } from '../configs/shapes'
import { renderLatexToSvg, renderLatexSvgToPngDataUrl } from '../utils/latex'
import AlignToolbar from './AlignToolbar'
import * as t from '../theme'
import * as D from '../defaults/colors'
import { useT } from '../i18n'

import { AnimatedDropdown } from './insert-panels/shared'
import { ShapePanel } from './insert-panels/ShapePanel'
import { LinePanel } from './insert-panels/LinePanel'
import type { LineTypeOption } from './insert-panels/LinePanel'
import { TableGridPicker } from './insert-panels/TableGridPicker'
import { ChartPanel, getDefaultChartPayload } from './insert-panels/ChartPanel'
import { LatexPanel } from './insert-panels/LatexPanel'
import { FileMenu } from './insert-panels/FileMenu'
import {
  IconText, IconImage, IconShape, IconLine,
  IconTable, IconChart, IconLatex, IconPlay, IconExport,
} from './insert-panels/icons'

interface InsertToolbarProps {
  onStartSlideShow?: () => void
  onImportPPTX?: () => void
  onExportPPTX?: () => void
  onExportPDF?: () => void
  onUploadImage?: (file: File) => Promise<string>
  onOpenVersionHistory?: () => void
}

const FLOATING_SHADOW = t.shadowFloating
const CAPSULE_STYLE: React.CSSProperties = {
  background: t.bgApp,
  border: `1px solid ${t.border}`,
  borderRadius: t.radiusMd,
  boxShadow: FLOATING_SHADOW,
}
const TOOLBAR_CONTAINER_PADDING = '6px 10px 2px'
const TOOLBAR_ROW_HEIGHT = 38
const TOOLBAR_CONTROL_HEIGHT = 28
const TOOLBAR_NAME_BADGE_HEIGHT = 20

const InsertToolbar: React.FC<InsertToolbarProps> = ({
  onStartSlideShow,
  onImportPPTX, onExportPPTX, onExportPDF, onUploadImage,
  onOpenVersionHistory,
}) => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const _addElement = useSlideStore((s) => s.addElement)
  const saveStatus = useSlideStore((s) => s.saveStatus)
  const addElement = useCallback(
    (...args: Parameters<typeof _addElement>) => {
      const s = useSlideStore.getState()
      if (s.presentation) {
        useHistoryStore.getState().pushSnapshot(s.presentation.pages)
      }
      _addElement(...args)
    },
    [_addElement],
  )
  const updatePresentationMeta = useSlideStore((s) => s.updatePresentationMeta)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [isEditingName, setIsEditingName] = useState(false)
  const [editingName, setEditingName] = useState('')

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
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      e.target.value = ''

      const insertWithSrc = (src: string, imgFile: File) => {
        const img = new Image()
        img.onload = () => {
          const maxW = 800
          const maxH = 600
          let w = img.naturalWidth
          let h = img.naturalHeight

          if (w > maxW) {
            const ratio = maxW / w
            w = maxW
            h = Math.round(h * ratio)
          }
          if (h > maxH) {
            const ratio = maxH / h
            h = maxH
            w = Math.round(w * ratio)
          }

          const el: PPTImageElement = {
            id: createElementId(),
            type: 'image',
            x: 300, y: 200, width: w, height: h,
            rotate: 0, opacity: 1, locked: false,
            fixedRatio: true,
            src,
          }
          addElement(el)
        }
        img.src = src
      }

      const fallbackBase64 = (f: File) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          insertWithSrc(dataUrl, f)
        }
        reader.readAsDataURL(f)
      }

      if (onUploadImage) {
        onUploadImage(file)
          .then((url) => insertWithSrc(url, file))
          .catch((err) => {
            console.warn('[InsertToolbar] 图片上传失败，降级 base64:', err)
            fallbackBase64(file)
          })
      } else {
        fallbackBase64(file)
      }
    },
    [addElement, onUploadImage],
  )

  const insertImage = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const insertShape = useCallback(
    (preset: ShapePreset) => {
      const vbW = preset.viewBox[0]
      const vbH = preset.viewBox[1]

      const MAX_SHAPE_SIZE = 300
      const ratio = vbW > 0 && vbH > 0 ? vbW / vbH : 1
      let w: number, h: number
      if (vbW >= vbH) {
        w = Math.min(vbW, MAX_SHAPE_SIZE)
        h = Math.round(w / ratio)
      } else {
        h = Math.min(vbH, MAX_SHAPE_SIZE)
        w = Math.round(h * ratio)
      }

      const formula = preset.pathFormula ? ShapePathFormulas[preset.pathFormula] : undefined
      const path = formula
        ? formula.formula(vbW, vbH, preset.keypoints ?? formula.defaultValue)
        : preset.path

      const canvasW = presentation?.canvasWidth || 1280
      const canvasH = presentation?.canvasHeight || 720
      const x = Math.max(0, Math.round((canvasW - w) / 2))
      const y = Math.max(0, Math.round((canvasH - h) / 2))

      const el: PPTShapeElement = {
        id: createElementId(),
        type: 'shape',
        x, y, width: w, height: h,
        rotate: 0, opacity: 1, locked: false,
        viewBox: [vbW, vbH],
        path,
        fixedRatio: preset.fixedRatio ?? false,
        fill: D.BRAND_COLOR,
        pathFormula: preset.pathFormula,
        keypoints: preset.keypoints ? [...preset.keypoints] : undefined,
        pptxShapeType: preset.pptxShapeType,
      }
      addElement(el)
    },
    [addElement, presentation],
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
    },
    [addElement],
  )

  const insertTable = useCallback(
    (rows: number, cols: number) => {
      const el = createTableElement(rows, cols)
      addElement(el)
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
    },
    [addElement, presentation],
  )

  const insertLatex = useCallback(
    async (payload: { latex: string; color: string }) => {
      const targetPageIndex = useSlideStore.getState().currentPageIndex

      const rendered = renderLatexToSvg(payload.latex, {
        display: true,
        color: payload.color,
      })

      const [vbW, vbH] = rendered.viewBox
      const ratio = vbH > 0 ? vbW / vbH : 3
      const maxW = 680
      const maxH = 240
      const minW = 120
      const minH = 40

      let width = Math.round(90 * ratio)
      let height = 90

      if (width > maxW) { const r = maxW / width; width = maxW; height = Math.round(height * r) }
      if (height > maxH) { const r = maxH / height; height = maxH; width = Math.round(width * r) }
      if (width < minW) { width = minW; height = Math.round(width / ratio) }
      if (height < minH) { height = minH; width = Math.round(height * ratio) }

      const canvasW = presentation?.canvasWidth || 1280
      const canvasH = presentation?.canvasHeight || 720
      const x = Math.max(0, Math.round((canvasW - width) / 2))
      const y = Math.max(0, Math.round((canvasH - height) / 2))

      let rasterSrc: string | undefined
      try {
        rasterSrc = await renderLatexSvgToPngDataUrl(rendered.svg, width, height, 3)
      } catch (err) {
        console.warn('[InsertToolbar] 公式位图兜底生成失败:', err)
      }

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

      addElement(el, targetPageIndex)
    },
    [addElement, presentation],
  )

  const name = presentation?.name || translate('untitled')

  const startEditName = useCallback(() => {
    if (!presentation) return
    setEditingName(name)
    setIsEditingName(true)
  }, [name, presentation])

  const commitNameEdit = useCallback(() => {
    if (!presentation) {
      setIsEditingName(false)
      return
    }
    const nextName = editingName.trim() || translate('untitled')
    if (nextName !== presentation.name) {
      updatePresentationMeta({ name: nextName })
    }
    setIsEditingName(false)
  }, [editingName, presentation, updatePresentationMeta])

  const cancelNameEdit = useCallback(() => {
    setEditingName(name)
    setIsEditingName(false)
  }, [name])

  useEffect(() => {
    if (!isEditingName) return
    const timer = setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
    return () => clearTimeout(timer)
  }, [isEditingName])

  return (
    <div
      style={{
        padding: TOOLBAR_CONTAINER_PADDING,
        background: 'transparent',
        flexShrink: 0,
        position: 'relative',
        zIndex: 6,
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageFileChange}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          alignItems: 'center',
          columnGap: 6,
          minWidth: 0,
        }}
      >
        {/* ── 左：文件名（无底背景） ── */}
        <div style={{
          height: TOOLBAR_ROW_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 2px',
          minWidth: 170,
          maxWidth: 280,
          flexShrink: 0,
          justifySelf: 'start',
        }}>
          {isEditingName ? (
            <input
              ref={nameInputRef}
              className="tabslide-panel-input"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={commitNameEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitNameEdit() }
                else if (e.key === 'Escape') { e.preventDefault(); cancelNameEdit() }
              }}
              style={{
                fontSize: 13, fontWeight: 600, color: t.textPrimary,
                width: 190, maxWidth: 190,
                height: TOOLBAR_CONTROL_HEIGHT,
                boxSizing: 'border-box',
                lineHeight: `${TOOLBAR_CONTROL_HEIGHT - 2}px`,
                border: `1px solid ${t.border}`,
                borderRadius: t.radiusSm,
                padding: '0 8px',
                background: t.bgSurface,
                outline: 'none',
              }}
            />
          ) : (
            <span
              onClick={startEditName}
              onDoubleClick={startEditName}
              title={translate('name.editHint')}
              style={{
                fontSize: 13, fontWeight: 600, color: t.textPrimary,
                maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: TOOLBAR_CONTROL_HEIGHT,
                lineHeight: `${TOOLBAR_CONTROL_HEIGHT}px`,
                cursor: 'text', userSelect: 'none',
              }}
            >
              {name}
            </span>
          )}
          {saveStatus === 'unsaved' && (
            <span style={{
              fontSize: 11, color: t.textSecondary, flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: TOOLBAR_NAME_BADGE_HEIGHT,
              fontWeight: 400, padding: '2px 6px',
              borderRadius: t.radiusSm, background: t.bgMuted,
              lineHeight: 1,
            }}>
              {translate('message.editing')}
            </span>
          )}
        </div>

        {/* ── 中：插入工具胶囊 ── */}
        <div style={{ minWidth: 0, display: 'flex', justifyContent: 'center' }}>
          <ScrollArea
            style={{
              ...CAPSULE_STYLE,
              display: 'inline-flex',
              alignItems: 'center',
              height: TOOLBAR_ROW_HEIGHT,
              width: 'fit-content',
              maxWidth: '100%',
            }}
            scrollBar="horizontal"
            viewportStyle={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              overflowY: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '0 6px',
                height: TOOLBAR_CONTROL_HEIGHT,
                minWidth: 'max-content',
                whiteSpace: 'nowrap',
              }}
            >
              <ToolBtn label={translate('insert.text')} icon={<IconText />} onClick={insertText} />
              <ToolBtn label={translate('insert.image')} icon={<IconImage />} onClick={insertImage} />

              <DropdownToolBtn label={translate('insert.shape')} icon={<IconShape />}>
                {(close) => (
                  <ShapePanel onInsert={(preset) => { insertShape(preset); close() }} translate={translate} />
                )}
              </DropdownToolBtn>

              <DropdownToolBtn label={translate('insert.line.title')} icon={<IconLine />}>
                {(close) => (
                  <LinePanel onInsert={(opt) => { insertLine(opt); close() }} translate={translate} />
                )}
              </DropdownToolBtn>

              <DropdownToolBtn label={translate('insert.table.title')} icon={<IconTable />}>
                {(close) => (
                  <TableGridPicker onInsert={(r, c) => { insertTable(r, c); close() }} translate={translate} />
                )}
              </DropdownToolBtn>

              <DropdownToolBtn label={translate('insert.chart.title')} icon={<IconChart />}>
                {(close) => (
                  <ChartPanel onInsert={(type) => { insertChart(type); close() }} translate={translate} />
                )}
              </DropdownToolBtn>

              <DropdownToolBtn label={translate('insert.latex.title')} icon={<IconLatex />}>
                {(close) => (
                  <LatexPanel onInsert={async (payload) => { await insertLatex(payload); close() }} translate={translate} />
                )}
              </DropdownToolBtn>

              <AlignToolbar />
            </div>
          </ScrollArea>
        </div>

        {/* ── 右：导出 + 放映 ── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          flexShrink: 0,
          justifySelf: 'end',
        }}>
          {(onImportPPTX || onExportPPTX || onExportPDF) && (
            <DropdownToolBtn
              label={translate('export.title')}
              icon={<IconExport />}
              align="right"
              buttonStyle={ACTION_BTN}
            >
              {(close) => (
                <FileMenu
                  onImportPPTX={onImportPPTX ? () => { onImportPPTX(); close() } : undefined}
                  onExportPPTX={onExportPPTX ? () => { onExportPPTX(); close() } : undefined}
                  onExportPDF={onExportPDF ? () => { onExportPDF(); close() } : undefined}
                  onOpenVersionHistory={onOpenVersionHistory ? () => { onOpenVersionHistory(); close() } : undefined}
                  translate={translate}
                />
              )}
            </DropdownToolBtn>
          )}

          {onStartSlideShow && (
            <button
              onClick={onStartSlideShow}
              style={{
                ...ACTION_PRIMARY_BTN,
                background: t.accent,
                color: t.accentForeground,
                transition: 'opacity 0.12s ease',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.88' }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
            >
              <span style={TOOLBAR_ICON_WRAPPER}><IconPlay /></span>
              <span style={TOOLBAR_LABEL_WRAPPER}>{translate('slideshow.start')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const TOOLBAR_BTN: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: '0 9px',
  height: TOOLBAR_CONTROL_HEIGHT,
  borderRadius: t.radiusMd,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  color: t.textSecondary,
  fontSize: 13,
  fontWeight: 400,
  lineHeight: 1,
  whiteSpace: 'nowrap',
  transition: 'background 0.12s ease, color 0.12s ease',
}

const ACTION_BTN: React.CSSProperties = {
  ...TOOLBAR_BTN,
  height: TOOLBAR_CONTROL_HEIGHT,
  padding: '0 11px',
  border: `1px solid ${t.border}`,
  background: t.bgApp,
  fontWeight: 500,
}

const ACTION_PRIMARY_BTN: React.CSSProperties = {
  ...ACTION_BTN,
  border: 'none',
}

const TOOLBAR_ICON_WRAPPER: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  flexShrink: 0,
}

const TOOLBAR_LABEL_WRAPPER: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  lineHeight: 1,
}

const ToolBtn: React.FC<{ label: string; icon: React.ReactNode; onClick: () => void }> = ({ label, icon, onClick }) => (
  <button
    onClick={onClick}
    title={label}
    className="tabslide-panel-item"
    style={TOOLBAR_BTN}
  >
    <span style={TOOLBAR_ICON_WRAPPER}>{icon}</span>
    <span style={TOOLBAR_LABEL_WRAPPER}>{label}</span>
  </button>
)

const DropdownToolBtn: React.FC<{
  label: string
  icon: React.ReactNode
  children: (close: () => void) => React.ReactNode
  align?: 'center' | 'left' | 'right'
  buttonStyle?: React.CSSProperties
}> = ({ label, icon, children, align = 'center', buttonStyle }) => {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  const baseColor = buttonStyle?.color || t.textSecondary
  const baseBg = buttonStyle?.background || 'transparent'

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        title={label}
        className="tabslide-panel-item"
        style={{
          ...TOOLBAR_BTN,
          ...buttonStyle,
          background: open ? t.bgMuted : baseBg,
          color: open ? t.textPrimary : baseColor,
        }}
      >
        <span style={TOOLBAR_ICON_WRAPPER}>{icon}</span>
        <span style={TOOLBAR_LABEL_WRAPPER}>{label}</span>
        <svg
          width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          style={{
            display: 'block',
            marginLeft: -2,
            transition: 'transform 0.15s ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <AnimatedDropdown open={open} onClose={close} align={align} anchorRef={anchorRef}>
        {children(close)}
      </AnimatedDropdown>
    </div>
  )
}

export default InsertToolbar
