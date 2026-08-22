import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { useSlideStore } from '../../../../store/slide'
import type {
  PPTElement, PPTTextElement, PPTImageElement, PPTShapeElement, PPTLineElement,
  PPTChartElement, ChartType, ChartData, ChartOptions,
  PPTTableElement, PPTLatexElement, PPTVideoElement, PPTAudioElement,
  PPTElementLink, PPTElementOutline, PPTElementShadow,
  Slide,
} from '../../../../types/slides'

const EMPTY_PAGES: Slide[] = []
import { resolveImageSrc } from '../../../../utils/image'
import { resolveBackgroundColor } from '../../../../utils/background'
import {
  TABLE_RICH_TEXT_SELECTION_EVENT, DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE,
  emitTableRichTextCommand,
  type TableRichTextSelectionState, type TableRichTextSelectionEventDetail,
  type TableRichTextCommand,
} from '../../../../utils/tableRichTextBridge'
import { inferElementLinkType, normalizeRichTextHyperlinkInput, normalizeSlideLinkTarget, normalizeWebHyperlinkInput } from '../../../../utils/hyperlink'
import { useT } from '../../../../i18n'
import { getShapePath } from '../../../../configs/shapes'
import {
  BG_THEME_KEYS, CHART_PRIMARY_THEME_KEYS, CHART_TYPE_OPTIONS,
  ROUND_RECT_PPTX_TYPES, clampRoundRectRatio, resolveRoundRectCorners,
  toColorInputHex, extractColorAlpha, colorWithAlpha, normalizeChartThemeKey,
  supportsStack, supportsSmooth, parseChartTokens, parseSeriesMatrix, formatSeriesMatrix, normalizeChartData, getThemeKeyLabel,
} from '../../shared/constants'
import { FieldLabel, FieldRow, FieldGrid, IconField, SegmentedControl, ColorField, RangeField, RangeSlider, ColorSwatch, PanelInput, PanelSelect, PanelTextarea } from '../../shared/components'
import {
  FontSizeIcon, LineHeightIcon, LetterSpacingIcon, ParagraphSpacingIcon,
  VAlignTopIcon, VAlignMiddleIcon, VAlignBottomIcon, VerticalTextIcon,
  TextColorIcon, HighlightIcon,
} from '../../shared/field-icons'
import { SectionPanel } from '@tabtin/smartsheet-ui'
import { FillEditor } from '../FillEditor'
import { FontSelect } from '../FontSelect'
import { LatexEditor } from './LatexEditor'
import { NumberComboBox, FONT_SIZE_PRESETS, LINE_HEIGHT_PRESETS, LETTER_SPACING_PRESETS } from '../NumberComboBox'
import { OutlineEditor, ShadowEditor } from './OutlineShadowEditors'
import {
  stripTextContentColorMarks,
  stripTextContentFontFamilyMarks,
  stripTextContentFontSizeMarks,
  stripTextContentLetterSpacingMarks,
  stripTextContentLineHeightMarks,
  stripTextContentParagraphSpacingMarks,
} from './text-style-cleanup'

export const StyleEditor: React.FC<{
  element: PPTElement
  onUpdate: (id: string, updates: Partial<PPTElement>) => void
  editingElementId: string | null
  onUploadImage?: (file: File) => Promise<string>
}> = ({ element, onUpdate, editingElementId, onUploadImage }) => {
  const el = element
  const translate = useT()
  const up = (u: Record<string, unknown>) => onUpdate(el.id, u as Partial<PPTElement>)

  const isChart = el.type === 'chart'
  const hasOutline = el.type === 'text' || el.type === 'shape' || el.type === 'image' || el.type === 'table' || el.type === 'chart'
  const hasShadow = el.type === 'text' || el.type === 'shape' || el.type === 'image' || el.type === 'line'
  const hasFill = el.type === 'shape'
  const hasRadius = el.type === 'image'
  const hasLineStyle = el.type === 'line'
  const hasLatex = el.type === 'latex'
  const isVideo = el.type === 'video'
  const isAudio = el.type === 'audio'
  const shapeEl = el.type === 'shape' ? (el as PPTShapeElement) : null
  const isRoundRectShape = !!shapeEl
    && (
      shapeEl.pathFormula === 'roundRect'
      || shapeEl.pathFormula === 'roundRectSingle'
      || ROUND_RECT_PPTX_TYPES.has(shapeEl.pptxShapeType || '')
    )
  const roundRectCorners = isRoundRectShape && shapeEl
    ? resolveRoundRectCorners(shapeEl)
    : null
  const isTable = el.type === 'table'
  const isTableRichTextEditing = isTable && editingElementId === el.id
  const hasElementLink = el.type === 'shape' || el.type === 'image' || el.type === 'text' || el.type === 'line' || el.type === 'video' || el.type === 'audio'
  const elementLink = (el as { link?: PPTElementLink }).link
  const [elementLinkInput, setElementLinkInput] = useState<string>('')
  const [elementLinkType, setElementLinkType] = useState<PPTElementLink['type']>('web')

  useEffect(() => {
    if (!hasElementLink) return
    const nextTarget = elementLink?.target || ''
    setElementLinkInput(nextTarget)
    if (elementLink?.type === 'slide') {
      setElementLinkType('slide')
      return
    }
    setElementLinkType(inferElementLinkType(nextTarget, 'web'))
  }, [el.id, hasElementLink, elementLink?.target, elementLink?.type])

  const outline: PPTElementOutline | undefined = (el as PPTShapeElement).outline
  const shadow: PPTElementShadow | undefined = (el as PPTShapeElement).shadow

  const linkPages = useSlideStore((s) => s.presentation?.pages ?? EMPTY_PAGES)

  // 主题色预览（用于填充 / 文本 / 边框的主题色快选）
  const styleEditorTheme = useSlideStore((s) => s.presentation?.theme)
  const themePalettePreview = useMemo(
    () => BG_THEME_KEYS.map((item) => ({
      ...item,
      label: getThemeKeyLabel(item, translate),
      color: resolveBackgroundColor(
        { type: 'theme', theme: { key: item.key } },
        styleEditorTheme,
      ),
    })),
    [styleEditorTheme, translate],
  )

  const lineEl = el.type === 'line' ? (el as PPTLineElement) : null
  const lineType = lineEl?.cubic
    ? 'cubic'
    : lineEl?.curve
      ? 'curve'
      : lineEl?.broken2
        ? 'broken2'
        : lineEl?.broken
          ? 'broken'
          : 'straight'
  const startPointValue = lineEl?.points?.[0] || ''
  const endPointValue = lineEl?.points?.[1] || ''

  const [tableSelection, setTableSelection] = useState<TableRichTextSelectionState>(
    DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE,
  )
  const [tableFontSizeInput, setTableFontSizeInput] = useState<string>('')
  const [tableFontFamilyInput, setTableFontFamilyInput] = useState<string>('')
  const [tableFontColorInput, setTableFontColorInput] = useState<string>('#333333')
  const [tableLinkEditing, setTableLinkEditing] = useState(false)
  const [tableLinkInput, setTableLinkInput] = useState('')

  useEffect(() => {
    if (!isTableRichTextEditing || typeof window === 'undefined') {
      setTableSelection(DEFAULT_TABLE_RICH_TEXT_SELECTION_STATE)
      return
    }

    const handleSelection = (evt: Event) => {
      const detail = (evt as CustomEvent<TableRichTextSelectionEventDetail>).detail
      if (!detail || detail.elementId !== el.id) return
      setTableSelection(detail.state)
    }

    window.addEventListener(TABLE_RICH_TEXT_SELECTION_EVENT, handleSelection as EventListener)
    return () => {
      window.removeEventListener(TABLE_RICH_TEXT_SELECTION_EVENT, handleSelection as EventListener)
    }
  }, [el.id, isTableRichTextEditing])

  useEffect(() => {
    setTableFontSizeInput(tableSelection.fontSizePt ? String(tableSelection.fontSizePt) : '')
    setTableFontFamilyInput(tableSelection.fontFamily || '')
    setTableFontColorInput(tableSelection.color || '#333333')
  }, [tableSelection])

  const sendTableCommand = useCallback((command: TableRichTextCommand, value?: string) => {
    if (!isTableRichTextEditing) return
    emitTableRichTextCommand({ elementId: el.id, command, value })
  }, [el.id, isTableRichTextEditing])

  const applyTableFontSize = useCallback(() => {
    const next = Number(tableFontSizeInput)
    if (!Number.isFinite(next) || next <= 0) return
    sendTableCommand('fontSize', String(next))
  }, [sendTableCommand, tableFontSizeInput])

  const applyTableFontColor = useCallback(() => {
    sendTableCommand('fontColor', tableFontColorInput)
  }, [sendTableCommand, tableFontColorInput])

  const applyTableFontFamily = useCallback(() => {
    sendTableCommand('fontFamily', tableFontFamilyInput)
  }, [sendTableCommand, tableFontFamilyInput])

  const applyElementLink = useCallback(() => {
    if (!hasElementLink) return
    const raw = elementLinkInput.trim()
    if (!raw) {
      up({ link: undefined })
      return
    }
    if (elementLinkType === 'slide') {
      const target = normalizeSlideLinkTarget(raw)
      if (!target) return
      up({
        link: {
          type: 'slide',
          target,
        },
      })
      return
    }
    const target = normalizeWebHyperlinkInput(raw)
    if (!target) return
    up({
      link: {
        type: 'web',
        target,
      },
    })
  }, [elementLinkInput, elementLinkType, hasElementLink, up])

  const removeElementLink = useCallback(() => {
    if (!hasElementLink) return
    setElementLinkInput('')
    up({ link: undefined })
  }, [hasElementLink, up])

  const imageEl = el.type === 'image' ? (el as PPTImageElement) : null
  const imageFilters = imageEl?.filters

  const updateImageFilters = useCallback((patch: Partial<NonNullable<PPTImageElement['filters']>>) => {
    if (!imageEl) return

    const merged = {
      ...(imageEl.filters || {}),
      ...patch,
    }

    const normalized: NonNullable<PPTImageElement['filters']> = {}
    const setIfNonDefault = (
      key: keyof NonNullable<PPTImageElement['filters']>,
      value: unknown,
      defaultValue: number,
      epsilon = 1e-3,
    ) => {
      if (value == null) return
      const num = Number(value)
      if (!Number.isFinite(num)) return
      if (Math.abs(num - defaultValue) > epsilon) {
        normalized[key] = num
      }
    }

    setIfNonDefault('brightness', merged.brightness, 1)
    setIfNonDefault('contrast', merged.contrast, 1)
    setIfNonDefault('saturate', merged.saturate, 1)
    setIfNonDefault('blur', merged.blur, 0)
    setIfNonDefault('grayscale', merged.grayscale, 0)
    setIfNonDefault('invert', merged.invert, 0)
    setIfNonDefault('hueRotate', merged.hueRotate, 0)
    setIfNonDefault('sepia', merged.sepia, 0)

    up({ filters: Object.keys(normalized).length ? normalized : undefined })
  }, [imageEl, up])

  const updateLineType = (nextType: 'straight' | 'broken' | 'broken2' | 'curve' | 'cubic') => {
    if (!lineEl) return
    const [sx, sy] = lineEl.start
    const [ex, ey] = lineEl.end
    const midX = (sx + ex) / 2
    const midY = (sy + ey) / 2

    if (nextType === 'straight') {
      up({ broken: undefined, broken2: undefined, curve: undefined, cubic: undefined })
      return
    }
    if (nextType === 'broken') {
      up({
        broken: lineEl.broken || [midX, midY],
        broken2: undefined,
        curve: undefined,
        cubic: undefined,
      })
      return
    }
    if (nextType === 'broken2') {
      up({
        broken: undefined,
        broken2: lineEl.broken2 || [midX, midY],
        curve: undefined,
        cubic: undefined,
      })
      return
    }
    if (nextType === 'curve') {
      up({
        broken: undefined,
        broken2: undefined,
        curve: lineEl.curve || [midX, midY - Math.max(40, Math.abs(ex - sx) * 0.2)],
        cubic: undefined,
      })
      return
    }
    up({
      broken: undefined,
      broken2: undefined,
      curve: undefined,
      cubic: lineEl.cubic || [[midX - 40, midY - 40], [midX + 40, midY + 40]],
    })
  }

  const updateLinePoint = (index: 0 | 1, value: string) => {
    if (!lineEl) return
    const next = [...lineEl.points] as PPTLineElement['points']
    const normalized = value === 'none' ? '' : value
    next[index] = normalized as PPTLineElement['points'][number]
    up({ points: next })
  }

  const updateRoundRectCorner = (index: 0 | 1 | 2 | 3, nextRatio: number) => {
    if (!shapeEl || !isRoundRectShape) return
    const current = resolveRoundRectCorners(shapeEl)
    const next: [number, number, number, number] = [...current] as [number, number, number, number]
    next[index] = clampRoundRectRatio(nextRatio)
    const nextPath = getShapePath('roundRect', shapeEl.path, shapeEl.width, shapeEl.height, next)
    up({
      pathFormula: 'roundRect',
      pptxShapeType: 'roundRect',
      keypoints: next,
      path: nextPath,
    })
  }

  return (
    <>
      {/* ── 图表配置 ── */}
      {isChart && (
        <>
          <SectionPanel title={translate('property.style.chart.title')} storageKey="slide.style.chart">
            <ChartEditor
              chart={el as PPTChartElement}
              onChange={(u) => up(u as Record<string, unknown>)}
            />
          </SectionPanel>
        </>
      )}

      {/* ── 填充 (shape) — 纯色 / 渐变 ── */}
      {hasFill && (
        <SectionPanel title={translate('property.style.fill.title')} storageKey="slide.style.fill">
          <FillEditor
            key={el.id}
            fill={toColorInputHex((el as PPTShapeElement).fill)}
            gradient={(el as PPTShapeElement).gradient}
            pattern={(el as PPTShapeElement).pattern}
            opacity={extractColorAlpha((el as PPTShapeElement).fill)}
            onFillChange={(v) => {
              const alpha = extractColorAlpha((el as PPTShapeElement).fill)
              up({ fill: colorWithAlpha(v, alpha), gradient: undefined, pattern: undefined, fillThemeKey: undefined })
            }}
            onOpacityChange={(a) => {
              const currentFill = (el as PPTShapeElement).fill || '#000000'
              up({ fill: colorWithAlpha(currentFill, a), gradient: undefined, pattern: undefined })
            }}
            onGradientChange={(g) => up({ gradient: g, fill: undefined, pattern: undefined, fillThemeKey: undefined })}
            onPatternChange={(p) => up(p ? { pattern: p, gradient: undefined, fillThemeKey: undefined } : { pattern: undefined, fillThemeKey: undefined })}
            onUploadImage={onUploadImage}
          />
          {/* 主题色快选 */}
          <div className="mt-1.5">
            <FieldLabel>{translate('property.style.themeColor')}</FieldLabel>
            <div className="grid grid-cols-7 gap-1">
              {themePalettePreview.slice(0, 14).map((item) => {
                const isActive = (el as PPTShapeElement).fillThemeKey === item.key
                return (
                  <button
                    key={item.key}
                    title={`${item.label} · ${item.color}`}
                    onClick={() => {
                      const alpha = extractColorAlpha((el as PPTShapeElement).fill)
                      up({
                        fill: colorWithAlpha(item.color, alpha),
                        fillThemeKey: item.key,
                        gradient: undefined,
                        pattern: undefined,
                      })
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
        </SectionPanel>
      )}

      {/* ── 形状内文本 ── */}
      {shapeEl && (() => {
        const sText = shapeEl.text
        const updateShapeText = (patch: Record<string, unknown>) =>
          up({ text: { ...(sText || { content: '' }), ...patch } })
        return (
          <SectionPanel title={translate('property.style.shapeText.title')} storageKey="slide.style.shapeText">
            <div className="grid gap-1.5">
              <div>
                <FieldLabel>{translate('property.style.shapeText.content')}</FieldLabel>
                <PanelInput
                  type="text"
                  value={(sText?.content || '').replace(/<[^>]+>/g, '')}
                  onChange={(e) => {
                    const plain = e.target.value
                    updateShapeText({ content: plain ? `<p>${plain}</p>` : '' })
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <FieldLabel>{translate('property.style.shapeText.fontFamily')}</FieldLabel>
                  <FontSelect
                    value={sText?.defaultFontName || ''}
                    onChange={(v) => updateShapeText({ defaultFontName: v || undefined })}
                    placeholder={translate('property.style.shapeText.fontFamilyPlaceholder')}
                  />
                </div>
                <div>
                  <FieldLabel>{translate('property.style.shapeText.fontSize')}</FieldLabel>
                  <NumberComboBox
                    value={sText?.defaultFontSize}
                    onChange={(v) => updateShapeText({ defaultFontSize: v })}
                    presets={FONT_SIZE_PRESETS}
                    min={1} max={400} step={1}
                    placeholder="14"
                    suffix="pt"
                  />
                </div>
              </div>
                <div>
                  <FieldLabel>{translate('property.style.shapeText.color')}</FieldLabel>
                  <div className="flex items-center gap-1.5">
                    <ColorSwatch
                      value={sText?.defaultColor || '#333333'}
                      onChange={(v) => updateShapeText({ defaultColor: v, defaultColorThemeKey: undefined })}
                    />
                    <span className="text-body text-muted-foreground/60 font-mono">
                      {sText?.defaultColor || '#333333'}
                    </span>
                  </div>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <div>
                  <FieldLabel>{translate('property.style.shapeText.align')}</FieldLabel>
                  <div className="grid grid-cols-3 gap-0.5">
                    {(['left', 'center', 'right'] as const).map((a) => {
                      const active = (sText?.align || 'center') === a
                      return (
                        <button
                          key={a}
                          type="button"
                          onClick={() => updateShapeText({ align: a })}
                          className={`border-none rounded py-1 text-body cursor-pointer ${active ? 'bg-accent/10 text-accent' : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'}`}
                        >
                          {translate(`property.style.shapeText.align${a.charAt(0).toUpperCase() + a.slice(1)}`)}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <FieldLabel>{translate('property.style.shapeText.verticalAlign')}</FieldLabel>
                  <div className="grid grid-cols-3 gap-0.5">
                    {(['top', 'middle', 'bottom'] as const).map((va) => {
                      const active = (sText?.verticalAlign || 'middle') === va
                      return (
                        <button
                          key={va}
                          type="button"
                          onClick={() => updateShapeText({ verticalAlign: va })}
                          className={`border-none rounded py-1 text-body cursor-pointer ${active ? 'bg-accent/10 text-accent' : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'}`}
                        >
                          {translate(`property.style.shapeText.verticalAlign${va.charAt(0).toUpperCase() + va.slice(1)}`)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          </SectionPanel>
        )
      })()}

      {/* ── 圆角 (shape) ── */}
      {roundRectCorners && (
        <SectionPanel title={translate('property.style.corners.title')} storageKey="slide.style.corners">
          <div className="grid gap-1.5">
            <RangeField
              label={translate('property.style.corners.topLeft')}
              value={roundRectCorners[0] * 100}
              min={0}
              max={50}
              step={1}
              suffix="%"
              onChange={(v) => updateRoundRectCorner(0, v / 100)}
            />
            <RangeField
              label={translate('property.style.corners.topRight')}
              value={roundRectCorners[1] * 100}
              min={0}
              max={50}
              step={1}
              suffix="%"
              onChange={(v) => updateRoundRectCorner(1, v / 100)}
            />
            <RangeField
              label={translate('property.style.corners.bottomRight')}
              value={roundRectCorners[2] * 100}
              min={0}
              max={50}
              step={1}
              suffix="%"
              onChange={(v) => updateRoundRectCorner(2, v / 100)}
            />
            <RangeField
              label={translate('property.style.corners.bottomLeft')}
              value={roundRectCorners[3] * 100}
              min={0}
              max={50}
              step={1}
              suffix="%"
              onChange={(v) => updateRoundRectCorner(3, v / 100)}
            />
          </div>
        </SectionPanel>
      )}

      {/* ── 图片 src & altText ── */}
      {el.type === 'image' && (
        <SectionPanel title={translate('property.style.image.src')} storageKey="slide.style.imageSrc">
          <div className="grid gap-1.5">
            <div className="flex gap-1">
              <PanelInput
                type="text"
                value={(el as PPTImageElement).src}
                onChange={(e) => up({ src: e.target.value })}
                placeholder={translate('property.style.link.placeholder.web')}
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'image/*'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (!file) return
                    resolveImageSrc(file, onUploadImage).then(({ src }) => {
                      up({ src })
                    })
                  }
                  input.click()
                }}
                className="border-none bg-accent/10 text-accent rounded px-2.5 text-body cursor-pointer font-medium whitespace-nowrap shrink-0"
              >
                {translate('property.style.fill.uploadLocalImage')}
              </button>
            </div>
            <div>
              <FieldLabel>{translate('property.style.image.altText')}</FieldLabel>
              <PanelInput
                type="text"
                value={(el as PPTImageElement).altText || ''}
                onChange={(e) => up({ altText: e.target.value || undefined })}
                placeholder={translate('property.style.image.altTextPlaceholder')}
              />
            </div>
          </div>
        </SectionPanel>
      )}

      {el.type === 'image' && (
        <SectionPanel title={translate('property.style.image.effects.title')} storageKey="slide.style.imageEffects">
          <div className="grid gap-2">
            <div>
              <FieldLabel>{translate('property.style.image.effects.fitMode')}</FieldLabel>
              <PanelSelect
                value={imageEl?.objectFit || 'cover'}
                onChange={(e) => up({ objectFit: e.target.value as PPTImageElement['objectFit'] })}
              >
                <option value="cover">{translate('property.style.image.effects.fit.cover')}</option>
                <option value="contain">{translate('property.style.image.effects.fit.contain')}</option>
                <option value="fill">{translate('property.style.image.effects.fit.fill')}</option>
              </PanelSelect>
            </div>

            <div>
              <FieldLabel>{translate('property.style.image.effects.colorMask')}</FieldLabel>
              <div className="grid gap-1.5">
                <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
                  <input
                    type="checkbox"
                    checked={!!imageEl?.colorMask}
                    onChange={(e) => {
                      if (e.target.checked) {
                        up({ colorMask: imageEl?.colorMask || 'rgba(0,0,0,0.2)' })
                      } else {
                        up({ colorMask: undefined })
                      }
                    }}
                    className="accent-[hsl(var(--accent))]"
                  />
                  {translate('property.style.image.effects.enableMask')}
                </label>
                {imageEl?.colorMask && (
                  <div className="flex items-center gap-1.5">
                    <ColorSwatch
                      value={toColorInputHex(imageEl.colorMask)}
                      opacity={extractColorAlpha(imageEl.colorMask)}
                      showOpacity
                      onChange={(hex, op) => up({ colorMask: colorWithAlpha(hex, op ?? extractColorAlpha(imageEl.colorMask)) })}
                    />
                    <PanelInput
                      type="text"
                      value={imageEl.colorMask}
                      onChange={(e) => up({ colorMask: e.target.value })}
                      className="flex-1"
                    />
                  </div>
                )}
              </div>
            </div>

            <div>
              <FieldLabel>{translate('property.style.image.effects.filters')}</FieldLabel>
              <div className="grid gap-1.5">
                <RangeField
                  label={translate('property.style.image.effects.filterBrightness')}
                  value={imageFilters?.brightness ?? 1}
                  min={0}
                  max={2}
                  step={0.05}
                  suffix=""
                  onChange={(v) => updateImageFilters({ brightness: v })}
                />
                <RangeField
                  label={translate('property.style.image.effects.filterContrast')}
                  value={imageFilters?.contrast ?? 1}
                  min={0}
                  max={2}
                  step={0.05}
                  suffix=""
                  onChange={(v) => updateImageFilters({ contrast: v })}
                />
                <RangeField
                  label={translate('property.style.image.effects.filterSaturation')}
                  value={imageFilters?.saturate ?? 1}
                  min={0}
                  max={3}
                  step={0.05}
                  suffix=""
                  onChange={(v) => updateImageFilters({ saturate: v })}
                />
                <RangeField
                  label={translate('property.style.image.effects.filterBlur')}
                  value={imageFilters?.blur ?? 0}
                  min={0}
                  max={20}
                  step={0.5}
                  suffix="px"
                  onChange={(v) => updateImageFilters({ blur: v })}
                />
                <RangeField
                  label={translate('property.style.image.effects.filterGrayscale')}
                  value={imageFilters?.grayscale ?? 0}
                  min={0}
                  max={1}
                  step={0.05}
                  suffix=""
                  onChange={(v) => updateImageFilters({ grayscale: v })}
                />
              </div>
              <div className="mt-1.5 flex justify-between items-center">
                <span className="text-caption text-muted-foreground/60">
                  {translate('property.style.image.effects.cropHint')}
                </span>
                <button
                  type="button"
                  onClick={() => up({ filters: undefined })}
                  className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded px-2 py-0.5 text-body cursor-pointer"
                >
                  {translate('property.style.image.effects.resetFilters')}
                </button>
              </div>
            </div>
          </div>
        </SectionPanel>
      )}

      {/* ── 圆角 (image) ── */}
      {hasRadius && (
        <SectionPanel title={translate('property.style.image.radius')} storageKey="slide.style.imageRadius">
          <div className="flex items-center gap-1.5">
            <RangeSlider
              min={0} max={100} step={1}
              value={(el as PPTImageElement).radius || 0}
              onChange={(v) => up({ radius: v || undefined })}
              className="flex-1"
            />
            <span className="text-body text-muted-foreground/60 min-w-7 text-right">
              {(el as PPTImageElement).radius || 0}px
            </span>
          </div>
        </SectionPanel>
      )}

      {/* ── 文本样式 ── */}
      {el.type === 'text' && (() => {
        const textEl = el as PPTTextElement
        return (
          <SectionPanel title={translate('property.style.textDefault.title')} storageKey="slide.style.text">
            <div className="flex flex-col gap-2">
              {/* 字体 */}
              <FontSelect
                value={textEl.defaultFontName}
                onChange={(v) => up({
                  defaultFontName: v || textEl.defaultFontName,
                  content: stripTextContentFontFamilyMarks(textEl.content),
                })}
                placeholder={translate('property.style.textDefault.fontFamilyPlaceholder')}
              />

              {/* 字号 / 行高 / 字间距 / 段间距 — 图标化紧凑数值簇 */}
              <FieldGrid cols={2}>
                <IconField icon={<FontSizeIcon />} title={translate('property.style.textDefault.fontSize')}>
                  <NumberComboBox
                    value={textEl.defaultFontSize}
                    onChange={(v) => up({
                      defaultFontSize: v,
                      content: stripTextContentFontSizeMarks(textEl.content),
                    })}
                    presets={FONT_SIZE_PRESETS}
                    min={1} max={400} step={1}
                    placeholder="14"
                    suffix="pt"
                  />
                </IconField>
                <IconField icon={<LineHeightIcon />} title={translate('property.style.textDefault.lineHeight')}>
                  <NumberComboBox
                    value={textEl.lineHeight}
                    onChange={(v) => up({
                      lineHeight: v,
                      content: stripTextContentLineHeightMarks(textEl.content),
                    })}
                    presets={LINE_HEIGHT_PRESETS}
                    min={0.5} max={5} step={0.1}
                    placeholder="1.5"
                  />
                </IconField>
                <IconField icon={<LetterSpacingIcon />} title={translate('property.style.textDefault.wordSpace')}>
                  <NumberComboBox
                    value={textEl.wordSpace}
                    onChange={(v) => up({
                      wordSpace: v,
                      content: stripTextContentLetterSpacingMarks(textEl.content),
                    })}
                    presets={LETTER_SPACING_PRESETS}
                    min={-10} max={50} step={0.5}
                    placeholder="0"
                    suffix="px"
                  />
                </IconField>
                <IconField icon={<ParagraphSpacingIcon />} title={translate('property.style.textDefault.paragraphSpace')}>
                  <NumberComboBox
                    value={textEl.paragraphSpace}
                    onChange={(v) => up({
                      paragraphSpace: v != null && v >= 0 ? v : undefined,
                      content: stripTextContentParagraphSpacingMarks(textEl.content),
                    })}
                    presets={[0, 5, 10, 15, 20, 30, 40, 60].map((v) => ({ label: String(v), value: v }))}
                    min={0} max={200} step={1}
                    placeholder="0"
                    suffix="pt"
                  />
                </IconField>
              </FieldGrid>

              {/* 文本颜色 / 背景 — 前置图标区分，去掉文字标签 */}
              <FieldGrid cols={2}>
                <ColorField
                  icon={<TextColorIcon />}
                  title={translate('property.style.textDefault.defaultColor')}
                  value={textEl.defaultColor}
                  displayValue={textEl.defaultColor}
                  onChange={(v) => up({
                    defaultColor: v,
                    defaultColorThemeKey: undefined,
                    content: stripTextContentColorMarks(textEl.content),
                  })}
                />
                <ColorField
                  icon={<HighlightIcon />}
                  title={translate('property.style.textDefault.background')}
                  value={textEl.fill || '#ffffff'}
                  displayValue={textEl.fill || translate('property.none')}
                  onChange={(v) => up({ fill: v === '#ffffff' ? undefined : v })}
                />
              </FieldGrid>

              {/* 垂直对齐（分段图标）+ 竖排文本（切换） */}
              <div className="flex items-center gap-2">
                <SegmentedControl
                  className="flex-1"
                  value={textEl.verticalAlign || 'top'}
                  onChange={(v) => up({ verticalAlign: v as PPTTextElement['verticalAlign'] })}
                  options={[
                    { value: 'top', icon: <VAlignTopIcon />, title: translate('property.style.textDefault.verticalAlignTop') },
                    { value: 'middle', icon: <VAlignMiddleIcon />, title: translate('property.style.textDefault.verticalAlignMiddle') },
                    { value: 'bottom', icon: <VAlignBottomIcon />, title: translate('property.style.textDefault.verticalAlignBottom') },
                  ]}
                />
                <button
                  type="button"
                  title={translate('property.style.textDefault.verticalText')}
                  aria-pressed={!!textEl.vertical}
                  onClick={() => up({ vertical: !textEl.vertical || undefined })}
                  className={`flex h-7 w-8 shrink-0 items-center justify-center rounded transition-colors ${
                    textEl.vertical
                      ? 'bg-accent/10 text-accent'
                      : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <VerticalTextIcon />
                </button>
              </div>

              {/* 文本适应 — 选项抽象，保留下拉 + 短标签 */}
              <FieldRow label={translate('property.style.textDefault.autoFit')}>
                <PanelSelect
                  value={textEl.autoFit || ''}
                  onChange={(e) => up({ autoFit: e.target.value || undefined })}
                >
                  <option value="">{translate('property.style.textDefault.autoFitNone')}</option>
                  <option value="shrink">{translate('property.style.textDefault.autoFitShrink')}</option>
                  <option value="resize">{translate('property.style.textDefault.autoFitResize')}</option>
                </PanelSelect>
              </FieldRow>

              {/* 内边距 */}
              <FieldRow label={translate('property.style.textDefault.margin')}>
                <FieldGrid cols={4}>
                  {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                    <FieldRow
                      key={side}
                      label={translate(`property.style.textDefault.margin${side.charAt(0).toUpperCase() + side.slice(1)}`)}
                    >
                      <PanelInput
                        type="number"
                        min="0" max="200" step="1"
                        value={textEl.margin?.[side] ?? ''}
                        onChange={(e) => {
                          const v = Number(e.target.value)
                          const next = { ...(textEl.margin || {}), [side]: Number.isFinite(v) && v >= 0 ? v : undefined }
                          const hasAny = Object.values(next).some((val) => val != null && val > 0)
                          up({ margin: hasAny ? next : undefined })
                        }}
                        placeholder="0"
                      />
                    </FieldRow>
                  ))}
                </FieldGrid>
              </FieldRow>

            </div>
          </SectionPanel>
        )
      })()}

      {/* ── 元素超链接（shape/image/text/line） ── */}
      {hasElementLink && (() => {
        return (
          <SectionPanel title={translate('property.style.link.title')} storageKey="slide.style.link">
            <div className="grid gap-1.5">
              <PanelSelect
                value={elementLinkType}
                onChange={(e) => setElementLinkType(e.target.value === 'slide' ? 'slide' : 'web')}
              >
                <option value="web">{translate('property.style.link.type.web')}</option>
                <option value="slide">{translate('property.style.link.type.slide')}</option>
              </PanelSelect>
              {elementLinkType === 'slide' ? (
                <PanelSelect
                  value={elementLinkInput}
                  onChange={(e) => {
                    const v = e.target.value
                    setElementLinkInput(v)
                    if (v) {
                      up({ link: { type: 'slide', target: v } })
                    } else {
                      up({ link: undefined })
                    }
                  }}
                >
                  <option value="">{translate('property.style.link.noTarget')}</option>
                  {linkPages.map((_, idx) => {
                    const target = `page-${idx + 1}`
                    return (
                      <option key={target} value={target}>
                        {translate('property.style.link.pageLabel')} {idx + 1}
                      </option>
                    )
                  })}
                </PanelSelect>
              ) : (
                <PanelInput
                  type="text"
                  value={elementLinkInput}
                  onChange={(e) => setElementLinkInput(e.target.value)}
                  onBlur={applyElementLink}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      applyElementLink()
                    }
                  }}
                  placeholder={translate('property.style.link.placeholder.web')}
                />
              )}
              <div className="grid grid-cols-2 gap-1">
                {elementLinkType !== 'slide' && (
                  <button
                    type="button"
                    onClick={applyElementLink}
                    className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer"
                  >
                    {translate('property.style.link.save')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={removeElementLink}
                  className={`border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer ${elementLinkType === 'slide' ? 'col-span-2' : ''}`}
                >
                  {translate('property.style.link.remove')}
                </button>
              </div>
            </div>
          </SectionPanel>
        )
      })()}

      {/* ── 表格单元格富文本（仅在单元格编辑态） ── */}
      {isTable && (
        <SectionPanel title={translate('property.style.tableRichText.title')} storageKey="slide.style.tableRichText">
          {!isTableRichTextEditing ? (
            <div className="text-body text-muted-foreground/60 leading-normal">
              {translate('property.style.tableRichText.tip')}
            </div>
          ) : (
            <div data-table-richtext-control="1" className="grid gap-1.5">
              <div className="grid grid-cols-3 gap-1">
                {[
                  { key: 'bold' as const, label: 'B', active: tableSelection.bold },
                  { key: 'italic' as const, label: 'I', active: tableSelection.italic },
                  { key: 'underline' as const, label: 'U', active: tableSelection.underline },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => sendTableCommand(item.key)}
                    data-table-richtext-control="1"
                    className={`border-none rounded py-1 text-body cursor-pointer ${item.active ? 'bg-accent/10 text-accent' : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'} ${item.key === 'bold' ? 'font-bold' : 'font-medium'} ${item.key === 'italic' ? 'italic' : 'not-italic'} ${item.key === 'underline' ? 'underline' : 'no-underline'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-4 gap-1">
                {[
                  { key: 'alignLeft' as const, label: translate('property.style.tableRichText.align.left'), active: tableSelection.align === 'left' },
                  { key: 'alignCenter' as const, label: translate('property.style.tableRichText.align.center'), active: tableSelection.align === 'center' },
                  { key: 'alignRight' as const, label: translate('property.style.tableRichText.align.right'), active: tableSelection.align === 'right' },
                  { key: 'alignJustify' as const, label: translate('property.style.tableRichText.align.justify'), active: tableSelection.align === 'justify' },
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => sendTableCommand(item.key)}
                    data-table-richtext-control="1"
                    className={`border-none rounded py-1 text-body cursor-pointer ${item.active ? 'bg-accent/10 text-accent' : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div data-table-richtext-control="1">
                  <FieldLabel>{translate('property.style.tableRichText.fontSize')}</FieldLabel>
                  <NumberComboBox
                    value={tableFontSizeInput ? Number(tableFontSizeInput) : undefined}
                    onChange={(v) => {
                      if (v != null) {
                        setTableFontSizeInput(String(v))
                        sendTableCommand('fontSize', String(v))
                      }
                    }}
                    presets={FONT_SIZE_PRESETS}
                    min={1} max={400} step={0.5}
                    placeholder="14"
                    suffix="pt"
                  />
                </div>
                <div>
                  <FieldLabel>{translate('property.color')}</FieldLabel>
                  <div className="flex items-center gap-1.5">
                    <div data-table-richtext-control="1">
                      <ColorSwatch
                        value={tableFontColorInput}
                        onChange={(v) => {
                          setTableFontColorInput(v)
                          sendTableCommand('fontColor', v)
                        }}
                      />
                    </div>
                    <PanelInput
                      type="text"
                      value={tableFontColorInput}
                      data-table-richtext-control="1"
                      onChange={(e) => setTableFontColorInput(e.target.value)}
                      onBlur={applyTableFontColor}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          applyTableFontColor()
                        }
                      }}
                    />
                  </div>
                </div>
              </div>

              <div data-table-richtext-control="1">
                <FieldLabel>{translate('property.font')}</FieldLabel>
                <FontSelect
                  value={tableFontFamilyInput}
                  onChange={(v) => {
                    setTableFontFamilyInput(v)
                    if (v) sendTableCommand('fontFamily', v)
                  }}
                  placeholder={translate('property.style.tableRichText.fontPlaceholder')}
                />
              </div>

              <div className="grid grid-cols-4 gap-1">
                <button
                  type="button"
                  onClick={() => sendTableCommand('unorderedList')}
                  data-table-richtext-control="1"
                  className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer"
                >
                  {translate('property.style.tableRichText.unorderedList')}
                </button>
                <button
                  type="button"
                  onClick={() => sendTableCommand('orderedList')}
                  data-table-richtext-control="1"
                  className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer"
                >
                  {translate('property.style.tableRichText.orderedList')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const currentLink = tableSelection.link || 'https://'
                    const defaultInput = currentLink.startsWith('#page-') ? currentLink.slice(1) : currentLink
                    setTableLinkInput(defaultInput)
                    setTableLinkEditing(true)
                  }}
                  data-table-richtext-control="1"
                  className={`border-none rounded py-1 text-body cursor-pointer ${tableLinkEditing ? 'bg-accent/10 text-accent' : 'bg-muted/40 text-muted-foreground hover:bg-muted/60'}`}
                >
                  {translate('property.style.tableRichText.link')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    sendTableCommand('removeLink')
                    setTableLinkEditing(false)
                    setTableLinkInput('')
                  }}
                  data-table-richtext-control="1"
                  className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer"
                >
                  {translate('property.style.tableRichText.unlink')}
                </button>
              </div>

              {tableLinkEditing && (
                <div data-table-richtext-control="1" className="flex gap-1">
                  <PanelInput
                    type="text"
                    autoFocus
                    value={tableLinkInput}
                    data-table-richtext-control="1"
                    onChange={(e) => setTableLinkInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        const value = tableLinkInput.trim()
                        if (!value) { sendTableCommand('removeLink') } else {
                          const normalized = normalizeRichTextHyperlinkInput(value)
                          if (normalized) sendTableCommand('createLink', normalized.href)
                        }
                        setTableLinkEditing(false)
                      }
                      if (e.key === 'Escape') { e.preventDefault(); setTableLinkEditing(false) }
                    }}
                    placeholder={translate('property.style.tableRichText.linkPlaceholder')}
                    className="flex-1"
                  />
                  <button
                    type="button"
                    data-table-richtext-control="1"
                    onClick={() => {
                      const value = tableLinkInput.trim()
                      if (!value) { sendTableCommand('removeLink') } else {
                        const normalized = normalizeRichTextHyperlinkInput(value)
                        if (normalized) sendTableCommand('createLink', normalized.href)
                      }
                      setTableLinkEditing(false)
                    }}
                    className="border-none bg-accent/10 text-accent rounded px-2.5 text-body cursor-pointer font-medium whitespace-nowrap"
                  >
                    {translate('property.apply')}
                  </button>
                </div>
              )}

              <div data-table-richtext-control="1" className="grid grid-cols-2 gap-1.5">
                <div>
                  <FieldLabel>{translate('property.style.tableRichText.cellBg')}</FieldLabel>
                  <div className="flex items-center gap-1.5">
                    <ColorSwatch
                      value={tableSelection.cellBgColor || '#ffffff'}
                      onChange={(v) => sendTableCommand('cellBgColor', v)}
                    />
                    <span className="text-caption text-muted-foreground/60 font-mono">
                      {tableSelection.cellBgColor || '#ffffff'}
                    </span>
                  </div>
                </div>
                <div>
                  <FieldLabel>{translate('property.style.tableRichText.cellVerticalAlign')}</FieldLabel>
                  <PanelSelect
                    value={tableSelection.verticalAlign || 'top'}
                    data-table-richtext-control="1"
                    onChange={(e) => sendTableCommand('cellVerticalAlign', e.target.value)}
                  >
                    <option value="top">{translate('property.style.textDefault.verticalAlignTop')}</option>
                    <option value="middle">{translate('property.style.textDefault.verticalAlignMiddle')}</option>
                    <option value="bottom">{translate('property.style.textDefault.verticalAlignBottom')}</option>
                  </PanelSelect>
                </div>
              </div>

              <button
                type="button"
                onClick={() => sendTableCommand('removeFormat')}
                data-table-richtext-control="1"
                className="w-full border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded py-1 text-body cursor-pointer"
              >
                {translate('property.style.tableRichText.clearFormatting')}
              </button>
            </div>
          )}
        </SectionPanel>
      )}

      {/* ── 表格主题 ── */}
      {isTable && (() => {
        const tableEl = el as PPTTableElement
        const tableTheme = tableEl.theme
        const updateTableTheme = (patch: Record<string, unknown>) =>
          up({ theme: { ...(tableTheme || { color: '#5b9bd5' }), ...patch } })
        return (
          <SectionPanel title={translate('property.style.tableTheme.title')} storageKey="slide.style.tableTheme">
            <div className="grid gap-1.5">
              <div>
                <FieldLabel>{translate('property.style.tableTheme.color')}</FieldLabel>
                <div className="flex items-center gap-1.5">
                  <ColorSwatch
                    value={tableTheme?.color || '#5b9bd5'}
                    onChange={(v) => updateTableTheme({ color: v })}
                  />
                  <span className="text-body text-muted-foreground/60 font-mono">
                    {tableTheme?.color || '#5b9bd5'}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {([
                  { key: 'headerRow', label: translate('property.style.tableTheme.headerRow') },
                  { key: 'headerCol', label: translate('property.style.tableTheme.headerCol') },
                  { key: 'footerRow', label: translate('property.style.tableTheme.footerRow') },
                  { key: 'lastCol', label: translate('property.style.tableTheme.lastCol') },
                  { key: 'stripedRows', label: translate('property.style.tableTheme.stripedRows') },
                  { key: 'stripedCols', label: translate('property.style.tableTheme.stripedCols') },
                ] as const).map((item) => (
                  <label key={item.key} className="flex items-center gap-1.5 text-body text-muted-foreground font-normal cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!(tableTheme as Record<string, unknown> | undefined)?.[item.key]}
                      onChange={(e) => updateTableTheme({ [item.key]: e.target.checked || undefined })}
                      className="accent-[hsl(var(--accent))]"
                    />
                    {item.label}
                  </label>
                ))}
              </div>
            </div>
          </SectionPanel>
        )
      })()}

      {/* ── 表格边框 ── */}
      {isTable && (() => {
        const tableEl = el as PPTTableElement
        const borders = tableEl.borders || {}
        const BORDER_SIDES: Array<{ key: 'top' | 'right' | 'bottom' | 'left' | 'insideH' | 'insideV'; label: string }> = [
          { key: 'top', label: translate('property.style.tableBorders.top') },
          { key: 'bottom', label: translate('property.style.tableBorders.bottom') },
          { key: 'left', label: translate('property.style.tableBorders.left') },
          { key: 'right', label: translate('property.style.tableBorders.right') },
          { key: 'insideH', label: translate('property.style.tableBorders.insideH') },
          { key: 'insideV', label: translate('property.style.tableBorders.insideV') },
        ]
        const updateBorder = (side: string, spec: PPTElementOutline | undefined) => {
          const next = { ...borders, [side]: spec }
          const hasAny = Object.values(next).some((v) => v != null)
          up({ borders: hasAny ? next : undefined })
        }
        return (
          <SectionPanel title={translate('property.style.tableBorders.title')} storageKey="slide.style.tableBorders">
            <div className="grid gap-1.5">
              {BORDER_SIDES.map((item) => {
                const spec = borders[item.key]
                const enabled = !!spec
                return (
                  <div key={item.key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => {
                        if (e.target.checked) {
                          updateBorder(item.key, spec || { style: 'solid', width: 1, color: '#000000' })
                        } else {
                          updateBorder(item.key, undefined)
                        }
                      }}
                      className="accent-[hsl(var(--accent))]"
                    />
                    <span className="text-body text-muted-foreground min-w-10">{item.label}</span>
                    {enabled && spec && (
                      <>
                        <ColorSwatch
                          value={spec.color}
                          onChange={(v) => updateBorder(item.key, { ...spec, color: v })}
                        />
                        <PanelInput
                          type="number" min="0.5" max="10" step="0.5"
                          value={spec.width}
                          onChange={(e) => { const w = parseFloat(e.target.value); if (Number.isFinite(w) && w >= 0.5) updateBorder(item.key, { ...spec, width: w }) }}
                          className="w-12"
                        />
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </SectionPanel>
        )
      })()}

      {/* ── 公式样式 ── */}
      {hasLatex && (
        <SectionPanel title={translate('property.style.latex.title')} storageKey="slide.style.latex">
          <LatexEditor
            element={el as PPTLatexElement}
            onUpdate={onUpdate}
          />
        </SectionPanel>
      )}

      {/* ── 视频属性 ── */}
      {isVideo && (
        <SectionPanel title={translate('property.style.video.title')} storageKey="slide.style.video">
          <div className="grid gap-1.5">
            <div>
              <FieldLabel>{translate('property.style.video.src')}</FieldLabel>
              <PanelInput
                type="text"
                value={(el as PPTVideoElement).src}
                onChange={(e) => up({ src: e.target.value })}
                placeholder="https://..."
              />
            </div>
            <div>
              <FieldLabel>{translate('property.style.video.poster')}</FieldLabel>
              <PanelInput
                type="text"
                value={(el as PPTVideoElement).poster || ''}
                onChange={(e) => up({ poster: e.target.value || undefined })}
                placeholder={translate('property.style.video.posterPlaceholder')}
              />
            </div>
            <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
              <input
                type="checkbox"
                checked={(el as PPTVideoElement).autoplay}
                onChange={(e) => up({ autoplay: e.target.checked })}
                className="accent-[hsl(var(--accent))]"
              />
              {translate('property.style.video.autoplay')}
            </label>
          </div>
        </SectionPanel>
      )}

      {/* ── 音频属性 ── */}
      {isAudio && (
        <SectionPanel title={translate('property.style.audio.title')} storageKey="slide.style.audio">
          <div className="grid gap-1.5">
            <div>
              <FieldLabel>{translate('property.style.audio.src')}</FieldLabel>
              <PanelInput
                type="text"
                value={(el as PPTAudioElement).src}
                onChange={(e) => up({ src: e.target.value })}
                placeholder="https://..."
              />
            </div>
            <div>
              <FieldLabel>{translate('property.style.audio.iconColor')}</FieldLabel>
              <div className="flex items-center gap-1.5">
                <ColorSwatch value={(el as PPTAudioElement).color} onChange={(v) => up({ color: v })} />
                <span className="text-body text-muted-foreground/60 font-mono">
                  {(el as PPTAudioElement).color}
                </span>
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
              <input
                type="checkbox"
                checked={(el as PPTAudioElement).autoplay}
                onChange={(e) => up({ autoplay: e.target.checked })}
                className="accent-[hsl(var(--accent))]"
              />
              {translate('property.style.audio.autoplay')}
            </label>
            <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
              <input
                type="checkbox"
                checked={(el as PPTAudioElement).loop}
                onChange={(e) => up({ loop: e.target.checked })}
                className="accent-[hsl(var(--accent))]"
              />
              {translate('property.style.audio.loop')}
            </label>
          </div>
        </SectionPanel>
      )}

      {/* ── 线条样式 ── */}
      {hasLineStyle && (
        <SectionPanel title={translate('property.style.line.title')} storageKey="slide.style.line">
          <div className="grid grid-cols-2 gap-1">
            <div>
              <FieldLabel>{translate('property.color')}</FieldLabel>
              <div className="flex items-center gap-1.5">
                <ColorSwatch value={(el as PPTLineElement).color} onChange={(v) => up({ color: v })} />
                <span className="text-body text-muted-foreground/60 font-mono">
                  {(el as PPTLineElement).color}
                </span>
              </div>
            </div>
            <div>
              <FieldLabel>{translate('property.style.line.width')}</FieldLabel>
              <PanelInput
                type="number" min="0.1" max="20" step="0.1"
                value={(el as PPTLineElement).lineWidth}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (!Number.isFinite(next)) return
                  up({ lineWidth: Math.max(0.1, next) })
                }}
              />
            </div>
            <div>
              <FieldLabel>{translate('property.style.line.style')}</FieldLabel>
              <PanelSelect
                value={(el as PPTLineElement).style}
                onChange={(e) => up({ style: e.target.value })}
              >
                <option value="solid">{translate('property.style.line.styleOptions.solid')}</option>
                <option value="dashed">{translate('property.style.line.styleOptions.dashed')}</option>
                <option value="dotted">{translate('property.style.line.styleOptions.dotted')}</option>
                <option value="dashDot">{translate('property.style.line.styleOptions.dashDot')}</option>
                <option value="longDash">{translate('property.style.line.styleOptions.longDash')}</option>
                <option value="longDashDot">{translate('property.style.line.styleOptions.longDashDot')}</option>
              </PanelSelect>
            </div>
            <div>
              <FieldLabel>{translate('property.style.line.type')}</FieldLabel>
              <PanelSelect
                value={lineType}
                onChange={(e) => updateLineType(e.target.value as 'straight' | 'broken' | 'broken2' | 'curve' | 'cubic')}
              >
                <option value="straight">{translate('property.style.line.typeOptions.straight')}</option>
                <option value="broken">{translate('property.style.line.typeOptions.broken')}</option>
                <option value="broken2">{translate('property.style.line.typeOptions.broken2')}</option>
                <option value="curve">{translate('property.style.line.typeOptions.curve')}</option>
                <option value="cubic">{translate('property.style.line.typeOptions.cubic')}</option>
              </PanelSelect>
            </div>
            <div>
              <FieldLabel>{translate('property.style.line.startCap')}</FieldLabel>
              <PanelSelect
                value={startPointValue || 'none'}
                onChange={(e) => updateLinePoint(0, e.target.value)}
              >
                <option value="none">{translate('property.style.line.cap.none')}</option>
                <option value="arrow">{translate('property.style.line.cap.arrow')}</option>
                <option value="triangle">{translate('property.style.line.cap.triangle')}</option>
                <option value="stealth">{translate('property.style.line.cap.stealth')}</option>
                <option value="diamond">{translate('property.style.line.cap.diamond')}</option>
                <option value="dot">{translate('property.style.line.cap.dot')}</option>
              </PanelSelect>
            </div>
            <div>
              <FieldLabel>{translate('property.style.line.endCap')}</FieldLabel>
              <PanelSelect
                value={endPointValue || 'none'}
                onChange={(e) => updateLinePoint(1, e.target.value)}
              >
                <option value="none">{translate('property.style.line.cap.none')}</option>
                <option value="arrow">{translate('property.style.line.cap.arrow')}</option>
                <option value="triangle">{translate('property.style.line.cap.triangle')}</option>
                <option value="stealth">{translate('property.style.line.cap.stealth')}</option>
                <option value="diamond">{translate('property.style.line.cap.diamond')}</option>
                <option value="dot">{translate('property.style.line.cap.dot')}</option>
              </PanelSelect>
            </div>
          </div>
        </SectionPanel>
      )}

      {/* ── 边框 ── */}
      {hasOutline && (
        <SectionPanel title={translate('property.style.outline.title')} storageKey="slide.style.outline">
          <OutlineEditor
            outline={outline}
            onChange={(v) => up({ outline: v })}
            themePalette={themePalettePreview}
          />
        </SectionPanel>
      )}

      {/* ── 阴影 ── */}
      {hasShadow && (
        <SectionPanel title={translate('property.style.shadow.title')} storageKey="slide.style.shadow">
          <ShadowEditor
            shadow={shadow}
            onChange={(v) => up({ shadow: v })}
          />
        </SectionPanel>
      )}
    </>
  )
}

// ── 图表编辑器 ──

const FALLBACK_CHART_COLORS = ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4', '#70ad47']

const ChartEditor: React.FC<{
  chart: PPTChartElement
  onChange: (updates: Partial<PPTChartElement>) => void
}> = ({ chart, onChange }) => {
  const translate = useT()
  const presentationTheme = useSlideStore((s) => s.presentation?.theme)
  const [labelsInput, setLabelsInput] = useState(chart.data.labels.join(', '))
  const [legendsInput, setLegendsInput] = useState(chart.data.legends.join(', '))
  const [seriesInput, setSeriesInput] = useState(formatSeriesMatrix(chart.data.series))
  const [xSeriesInput, setXSeriesInput] = useState(formatSeriesMatrix(chart.data.xSeries))

  useEffect(() => {
    setLabelsInput(chart.data.labels.join(', '))
    setLegendsInput(chart.data.legends.join(', '))
    setSeriesInput(formatSeriesMatrix(chart.data.series))
    setXSeriesInput(formatSeriesMatrix(chart.data.xSeries))
  }, [chart.id, chart.data])

  const isPieType = chart.chartType === 'pie' || chart.chartType === 'ring'
  const canStack = supportsStack(chart.chartType)
  const canSmooth = supportsSmooth(chart.chartType)
  const options = chart.options || {}

  const showLegend = options.showLegend ?? (isPieType || chart.data.legends.length > 1)
  const showDataLabel = options.showDataLabel ?? isPieType
  const legendPosition = options.legendPosition || 'b'
  const stack = options.stack ?? false
  const lineSmooth = options.lineSmooth ?? false
  const labelsFieldLabel = chart.chartType === 'scatter'
    ? translate('property.chart.labelsFieldScatter')
    : translate('property.chart.labelsField')
  const labelsFieldPlaceholder = chart.chartType === 'scatter'
    ? translate('property.chart.labelsPlaceholderScatter')
    : translate('property.chart.labelsPlaceholder')
  const legendsFieldLabel = isPieType
    ? translate('property.chart.legendsFieldPie')
    : translate('property.chart.legendsField')
  const legendsFieldPlaceholder = isPieType
    ? translate('property.chart.legendsPlaceholderPie')
    : translate('property.chart.legendsPlaceholder')
  const seriesFieldLabel = isPieType
    ? translate('property.chart.seriesFieldPie')
    : translate('property.chart.seriesField')
  const xSeriesFieldLabel = translate('property.chart.xSeriesField')
  const smoothLabel = chart.chartType === 'scatter'
    ? translate('property.chart.smoothScatter')
    : translate('property.chart.smooth')

  const chartColors = chart.themeColors?.length ? chart.themeColors : FALLBACK_CHART_COLORS
  const chartThemePalette = useMemo(
    () => BG_THEME_KEYS.map((item) => ({
      ...item,
      label: getThemeKeyLabel(item, translate),
      color: resolveBackgroundColor(
        { type: 'theme', theme: { key: item.key } },
        presentationTheme,
      ),
    })),
    [presentationTheme, translate],
  )
  const chartThemePaletteMap = useMemo(
    () => new Map(chartThemePalette.map((item) => [item.key, item.color])),
    [chartThemePalette],
  )
  const chartThemeKeyByColorHex = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of chartThemePalette) {
      const hex = toColorInputHex(item.color)
      if (!map.has(hex)) {
        map.set(hex, item.key)
      }
    }
    return map
  }, [chartThemePalette])
  const chartColorKeys = useMemo(() => {
    const rawKeys = Array.isArray(chart.themeColorKeys) ? chart.themeColorKeys : []
    return chartColors.map((color, idx) => {
      const explicit = normalizeChartThemeKey(rawKeys[idx])
      if (explicit) return explicit
      return chartThemeKeyByColorHex.get(toColorInputHex(color)) || null
    })
  }, [chart.themeColorKeys, chartColors, chartThemeKeyByColorHex])

  const emitChartPalette = useCallback(
    (nextColors: string[], nextKeys: Array<string | null>) => {
      const alignedKeys = nextColors.map((_, idx) => normalizeChartThemeKey(nextKeys[idx]) || null)
      const hasThemeKeys = alignedKeys.some((key) => Boolean(key))
      onChange({
        themeColors: nextColors,
        themeColorKeys: hasThemeKeys ? alignedKeys : undefined,
      })
    },
    [onChange],
  )

  const updateOptions = useCallback(
    (patch: Partial<ChartOptions>) => {
      onChange({ options: { ...options, ...patch } })
    },
    [onChange, options],
  )

  const commitChartData = useCallback(() => {
    const nextDataRaw: ChartData = {
      labels: parseChartTokens(labelsInput),
      legends: parseChartTokens(legendsInput),
      series: parseSeriesMatrix(seriesInput),
    }
    if (chart.chartType === 'scatter') {
      const parsedXSeries = parseSeriesMatrix(xSeriesInput)
      if (parsedXSeries.length > 0) {
        nextDataRaw.xSeries = parsedXSeries
      }
    }
    const nextData: ChartData = normalizeChartData(chart.chartType, nextDataRaw, translate)
    onChange({ data: nextData })
  }, [chart.chartType, labelsInput, legendsInput, seriesInput, xSeriesInput, onChange, translate])

  const commitRef = useRef(commitChartData)
  commitRef.current = commitChartData
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debouncedCommitChartData = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      commitRef.current()
    }, 300)
  }, [])
  useEffect(() => () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current) }, [])
  const flushAndCommit = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    commitRef.current()
  }, [])

  const onChangeType = (nextType: ChartType) => {
    const nextOptions: ChartOptions = { ...options }
    if (!supportsStack(nextType)) delete nextOptions.stack
    if (!supportsSmooth(nextType)) delete nextOptions.lineSmooth
    onChange({
      chartType: nextType,
      data: normalizeChartData(nextType, chart.data, translate),
      options: nextOptions,
    })
  }

  const onChangeChartColor = (index: number, color: string) => {
    const next = [...chartColors]
    const nextKeys = [...chartColorKeys]
    next[index] = color
    nextKeys[index] = null
    emitChartPalette(next, nextKeys)
  }

  const onChangeChartThemeKey = (index: number, rawKey: string) => {
    const normalizedKey = normalizeChartThemeKey(rawKey)
    const nextColors = [...chartColors]
    const nextKeys = [...chartColorKeys]

    if (!normalizedKey) {
      nextKeys[index] = null
      emitChartPalette(nextColors, nextKeys)
      return
    }

    const resolvedColor = chartThemePaletteMap.get(normalizedKey)
    if (resolvedColor) {
      nextColors[index] = resolvedColor
    }
    nextKeys[index] = normalizedKey
    emitChartPalette(nextColors, nextKeys)
  }

  const applyThemePalette = () => {
    const nextColors = chartColors.map((_, idx) => {
      const key = CHART_PRIMARY_THEME_KEYS[idx % CHART_PRIMARY_THEME_KEYS.length]
      return chartThemePaletteMap.get(key) || FALLBACK_CHART_COLORS[idx % FALLBACK_CHART_COLORS.length]
    })
    const nextKeys = chartColors.map((_, idx) => CHART_PRIMARY_THEME_KEYS[idx % CHART_PRIMARY_THEME_KEYS.length])
    emitChartPalette(nextColors, nextKeys)
  }

  const addChartColor = () => {
    emitChartPalette(
      [...chartColors, FALLBACK_CHART_COLORS[0]],
      [...chartColorKeys, null],
    )
  }

  const removeChartColor = (index: number) => {
    if (chartColors.length <= 1) return
    const nextColors = chartColors.filter((_, i) => i !== index)
    const nextKeys = chartColorKeys.filter((_, i) => i !== index)
    emitChartPalette(nextColors, nextKeys)
  }

  const fillEnabled = !!chart.fill
  const textColorEnabled = !!chart.textColor
  const gridColorEnabled = !!chart.gridColor

  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <FieldLabel>{translate('property.chart.type')}</FieldLabel>
          <PanelSelect
            value={chart.chartType}
            onChange={(e) => onChangeType(e.target.value as ChartType)}
          >
            {CHART_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {translate(`insert.chart.types.${opt}.label`)}
              </option>
            ))}
          </PanelSelect>
        </div>
        <div>
          <FieldLabel>{translate('property.chart.title')}</FieldLabel>
          <PanelInput
            type="text"
            value={chart.chartTitle || ''}
            onChange={(e) => onChange({ chartTitle: e.target.value || undefined })}
            placeholder={translate('property.chart.titlePlaceholder')}
          />
        </div>
      </div>

      <div>
        <FieldLabel>{labelsFieldLabel}</FieldLabel>
        <PanelInput
          type="text"
          value={labelsInput}
          onChange={(e) => { setLabelsInput(e.target.value); debouncedCommitChartData() }}
          onBlur={flushAndCommit}
          placeholder={labelsFieldPlaceholder}
        />
      </div>

      <div>
        <FieldLabel>{legendsFieldLabel}</FieldLabel>
        <PanelInput
          type="text"
          value={legendsInput}
          onChange={(e) => { setLegendsInput(e.target.value); debouncedCommitChartData() }}
          onBlur={flushAndCommit}
          placeholder={legendsFieldPlaceholder}
        />
      </div>

      <div>
        <FieldLabel>{seriesFieldLabel}</FieldLabel>
        <PanelTextarea
          value={seriesInput}
          onChange={(e) => { setSeriesInput(e.target.value); debouncedCommitChartData() }}
          onBlur={flushAndCommit}
          rows={Math.max(2, Math.min(6, chart.data.series.length + 1))}
          style={{ resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
        />
      </div>
      {chart.chartType === 'scatter' ? (
        <div>
          <FieldLabel>{xSeriesFieldLabel}</FieldLabel>
          <PanelTextarea
            value={xSeriesInput}
            onChange={(e) => { setXSeriesInput(e.target.value); debouncedCommitChartData() }}
            onBlur={flushAndCommit}
            rows={Math.max(2, Math.min(6, chart.data.series.length + 1))}
            placeholder={translate('property.chart.xSeriesPlaceholder')}
            style={{ resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
          />
          <div className="mt-1 text-body text-muted-foreground/60">
            {translate('property.chart.xSeriesHint')}
          </div>
        </div>
      ) : null}
      {isPieType ? (
        <div className="text-body text-muted-foreground/60">
          {translate('property.chart.pieHint')}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
          <input type="checkbox" checked={showLegend} onChange={(e) => updateOptions({ showLegend: e.target.checked })} className="accent-[hsl(var(--accent))]" />
          {translate('property.chart.showLegend')}
        </label>
        <div>
          <FieldLabel>{translate('property.chart.legendPosition')}</FieldLabel>
          <PanelSelect
            value={legendPosition}
            onChange={(e) => updateOptions({ legendPosition: e.target.value as ChartOptions['legendPosition'] })}
          >
            <option value="b">{translate('property.chart.legendPositionBottom')}</option>
            <option value="t">{translate('property.chart.legendPositionTop')}</option>
            <option value="l">{translate('property.chart.legendPositionLeft')}</option>
            <option value="r">{translate('property.chart.legendPositionRight')}</option>
          </PanelSelect>
        </div>
        <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
          <input type="checkbox" checked={showDataLabel} onChange={(e) => updateOptions({ showDataLabel: e.target.checked })} className="accent-[hsl(var(--accent))]" />
          {translate('property.chart.showDataLabel')}
        </label>
        {canStack ? (
          <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
            <input type="checkbox" checked={stack} onChange={(e) => updateOptions({ stack: e.target.checked })} className="accent-[hsl(var(--accent))]" />
            {translate('property.chart.stack')}
          </label>
        ) : <span />}
        {canSmooth ? (
          <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
            <input type="checkbox" checked={lineSmooth} onChange={(e) => updateOptions({ lineSmooth: e.target.checked })} className="accent-[hsl(var(--accent))]" />
            {smoothLabel}
          </label>
        ) : <span />}
        {chart.chartType === 'radar' ? (
          <label className="flex items-center gap-1.5 text-body text-muted-foreground font-normal">
            <input type="checkbox" checked={options.radarFilled ?? false} onChange={(e) => updateOptions({ radarFilled: e.target.checked })} className="accent-[hsl(var(--accent))]" />
            {translate('property.chart.radarFilled')}
          </label>
        ) : <span />}
      </div>

      <div>
        <FieldLabel>{translate('property.chart.themeMapping')}</FieldLabel>
        <div className="mb-1.5 flex justify-between items-center">
          <span className="text-caption text-muted-foreground/60">
            {translate('property.chart.themeMappingHint')}
          </span>
          <button
            type="button"
            onClick={applyThemePalette}
            className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded px-2 py-0.5 text-body cursor-pointer"
          >
            {translate('property.chart.resetByTheme')}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {chartColors.map((color, idx) => (
            <div
              key={`${idx}-${color}`}
              className="grid gap-1 p-1 px-1.5 border border-border/10 rounded bg-background"
            >
              <div className="flex items-center gap-1">
                <ColorSwatch value={color} onChange={(v) => onChangeChartColor(idx, v)} />
                <button
                  type="button"
                  onClick={() => removeChartColor(idx)}
                  title={translate('property.chart.removeColor')}
                  className={`border-none bg-transparent text-muted-foreground/60 p-0 leading-none text-body ${chartColors.length <= 1 ? 'cursor-not-allowed opacity-40' : 'cursor-pointer opacity-100'}`}
                >
                  ×
                </button>
              </div>
              <PanelSelect
                value={chartColorKeys[idx] || ''}
                onChange={(e) => onChangeChartThemeKey(idx, e.target.value)}
                className="min-w-32"
              >
                <option value="">{translate('property.chart.customColor')}</option>
                {chartThemePalette.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label} ({item.color})
                  </option>
                ))}
              </PanelSelect>
            </div>
          ))}
          <button
            type="button"
            onClick={addChartColor}
            className="border-none bg-muted/40 text-muted-foreground hover:bg-muted/60 rounded px-2 py-0.5 text-body cursor-pointer"
          >
            {translate('property.chart.addColor')}
          </button>
        </div>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={fillEnabled}
            onChange={(e) => onChange({ fill: e.target.checked ? (chart.fill || '#ffffff') : undefined })}
            className="accent-[hsl(var(--accent))]"
          />
          <span className="text-body text-muted-foreground">{translate('property.chart.chartFillColor')}</span>
          {fillEnabled && <ColorSwatch value={chart.fill || '#ffffff'} onChange={(v) => onChange({ fill: v })} />}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={textColorEnabled}
            onChange={(e) => onChange({ textColor: e.target.checked ? (chart.textColor || '#333333') : undefined })}
            className="accent-[hsl(var(--accent))]"
          />
          <span className="text-body text-muted-foreground">{translate('property.chart.axisTextColor')}</span>
          {textColorEnabled && <ColorSwatch value={chart.textColor || '#333333'} onChange={(v) => onChange({ textColor: v })} />}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={gridColorEnabled}
            onChange={(e) => onChange({ gridColor: e.target.checked ? (chart.gridColor || '#d0d0d0') : undefined })}
            className="accent-[hsl(var(--accent))]"
          />
          <span className="text-body text-muted-foreground">{translate('property.chart.gridLineColor')}</span>
          {gridColorEnabled && <ColorSwatch value={chart.gridColor || '#d0d0d0'} onChange={(v) => onChange({ gridColor: v })} />}
        </div>
      </div>
    </div>
  )
}

