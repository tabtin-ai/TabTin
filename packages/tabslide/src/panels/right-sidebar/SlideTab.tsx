import React, { useCallback, useMemo, useState } from 'react'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import type { SlideBackground, SlideBackgroundTheme, TurningMode } from '../../types/slides'
import { TURNING_ANIMATIONS } from '../../configs/animations'
import { resolveBackgroundColor } from '../../utils/background'
import { useT } from '../../i18n'
import { SLIDE_BG } from '../../defaults/colors'
import {
  BG_THEME_KEYS,
  toColorInputHex, extractColorAlpha, colorWithAlpha,
  type LayoutOption,
  getLayoutKey, cloneLayoutRef, getLayoutOptionLabel, getThemeKeyLabel,
} from './shared/constants'
import {
  FieldLabel, PanelSelect, ColorSwatch,
} from './shared/components'
import { SectionPanel } from '@tabtin/smartsheet-ui'
import { FillEditor } from './editors/FillEditor'
import { FontSelect } from './editors/FontSelect'
import { ScrollArea } from '../../components/ui/ScrollArea'

export interface SlideTabProps {
  onUploadImage?: (file: File) => Promise<string>
}

export const SlideTab: React.FC<SlideTabProps> = ({ onUploadImage }) => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const updatePageBackground = useSlideStore((s) => s.updatePageBackground)
  const updatePageLayout = useSlideStore((s) => s.updatePageLayout)
  const updatePageTurningMode = useSlideStore((s) => s.updatePageTurningMode)
  const updatePageMasterElements = useSlideStore((s) => s.updatePageMasterElements)
  const updatePresentationMeta = useSlideStore((s) => s.updatePresentationMeta)
  const editorConfig = useSlideStore((s) => s.editorConfig)
  const updateEditorConfig = useSlideStore((s) => s.updateEditorConfig)

  const [showBgEditor, setShowBgEditor] = useState(false)

  const page = presentation?.pages[currentPageIndex]

  const runWithHistory = useCallback((fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    fn()
  }, [])

  const layoutOptions = useMemo<LayoutOption[]>(() => {
    if (!presentation?.pages?.length) return []
    const map = new Map<string, LayoutOption>()
    for (const p of presentation.pages) {
      if (!p.layout) continue
      const key = getLayoutKey(p.layout)
      if (!key) continue
      const existing = map.get(key)
      if (!existing) {
        map.set(key, {
          key,
          layout: cloneLayoutRef(p.layout),
          label: getLayoutOptionLabel(p.layout, translate),
          ...(p.masterElements?.length ? { masterElements: p.masterElements } : {}),
        })
        continue
      }
      if (!existing.masterElements?.length && p.masterElements?.length) {
        existing.masterElements = p.masterElements
      }
    }
    return [...map.values()].sort((a, b) => {
      const ai = typeof a.layout.index === 'number' ? a.layout.index : Number.MAX_SAFE_INTEGER
      const bi = typeof b.layout.index === 'number' ? b.layout.index : Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
      return a.label.localeCompare(b.label)
    })
  }, [presentation?.pages, translate])

  const currentLayoutKey = getLayoutKey(page?.layout)
  const applyLayoutOption = useCallback((layoutKey: string) => {
    const target = layoutOptions.find((item) => item.key === layoutKey)
    runWithHistory(() => {
      updatePageLayout(currentPageIndex, target ? target.layout : undefined)
      if (target?.masterElements?.length) {
        updatePageMasterElements(currentPageIndex, structuredClone(target.masterElements))
      } else {
        updatePageMasterElements(currentPageIndex, undefined)
      }
    })
  }, [currentPageIndex, layoutOptions, runWithHistory, updatePageLayout, updatePageMasterElements])

  const applyTurningMode = useCallback((mode: TurningMode) => {
    runWithHistory(() => {
      updatePageTurningMode(currentPageIndex, mode)
    })
  }, [currentPageIndex, runWithHistory, updatePageTurningMode])

  const updatePageBg = useCallback((bg: SlideBackground) => {
    runWithHistory(() => updatePageBackground(currentPageIndex, bg))
  }, [currentPageIndex, runWithHistory, updatePageBackground])

  if (!page) return null

  const currentBackground: SlideBackground = page.background || {
    type: 'solid',
    color: presentation?.theme?.backgroundColor || SLIDE_BG,
  }
  const pageBgType = currentBackground.type
  const pageBgColor = resolveBackgroundColor(currentBackground, presentation?.theme)
  const pageBgImage = pageBgType === 'image' ? currentBackground.image : undefined
  const pageBgGradient = pageBgType === 'gradient' ? currentBackground.gradient : undefined
  const pageBgTheme = pageBgType === 'theme' ? currentBackground.theme : undefined
  const currentTurningMode: TurningMode = page.turningMode || 'no'

  const headingFont = presentation?.theme?.headingFontName || presentation?.theme?.fontName || ''
  const bodyFont = presentation?.theme?.fontName || ''

  return (
    <ScrollArea
      style={{ flex: 1 }}
      viewportStyle={{ paddingBottom: 16 }}
    >

      {/* ── Slide style ── */}
      <SectionPanel title={translate('property.slideStyle')} storageKey="slide.style">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>{translate('property.pageLayout.title')}</FieldLabel>
            <PanelSelect
              value={currentLayoutKey}
              onChange={(e) => applyLayoutOption(e.target.value)}
              disabled={layoutOptions.length === 0}
              className="max-w-[150px]"
            >
              <option value="">{translate('property.pageLayout.unbound')}</option>
              {layoutOptions.map((item) => (
                <option key={item.key} value={item.key}>{item.label}</option>
              ))}
            </PanelSelect>
          </div>

          <div className="flex items-center justify-between gap-2">
            <FieldLabel>{translate('property.pageTransition.title')}</FieldLabel>
            <PanelSelect
              value={currentTurningMode}
              onChange={(e) => applyTurningMode(e.target.value as TurningMode)}
              className="max-w-[160px]"
            >
              {TURNING_ANIMATIONS.map((item) => (
                <option key={item.name} value={item.name}>
                  {(() => {
                    const key = `property.pageTransition.option.${item.name}`
                    const translated = translate(key)
                    return translated === key ? item.label : translated
                  })()}
                </option>
              ))}
            </PanelSelect>
          </div>
        </div>
      </SectionPanel>

      {/* ── Background color ── */}
      <SectionPanel title={translate('property.pageBackground.title')} storageKey="slide.background">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setShowBgEditor(!showBgEditor)}
              className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-body text-muted-foreground transition-colors hover:bg-muted/60"
            >
              <span
                className="h-5 w-5 flex-shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]"
                style={{
                  background: pageBgType === 'gradient' && pageBgGradient
                    ? `linear-gradient(${pageBgGradient.rotate || 0}deg, ${pageBgGradient.colors?.map((c: {color: string; pos: number}) => `${c.color} ${Math.round(c.pos * 100)}%`).join(', ') || pageBgColor})`
                    : pageBgColor,
                }}
              />
              <span className="font-mono text-caption">
                {pageBgType === 'image'
                  ? translate('property.pageBackground.typeImage')
                  : pageBgType === 'gradient'
                    ? translate('property.pageBackground.typeGradient')
                    : toColorInputHex(pageBgColor)}
              </span>
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <polyline points={showBgEditor ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
              </svg>
            </button>
          </div>

          {showBgEditor && (
            <div>
              {pageBgType === 'theme' ? (
                <div className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BG_THEME_KEYS.map((item) => {
                      const resolved = resolveBackgroundColor({ type: 'theme', theme: { key: item.key } }, presentation?.theme)
                      const isActive = (pageBgTheme?.key || 'lt1') === item.key
                      const itemLabel = getThemeKeyLabel(item, translate)
                      return (
                        <button
                          key={item.key} title={itemLabel}
                          onClick={() => updatePageBg({ type: 'theme', color: resolved, theme: { key: item.key, color: resolved } })}
                          className={`h-7 w-7 rounded-full transition-shadow ${isActive ? 'ring-2 ring-accent ring-offset-1' : 'ring-1 ring-border/30'}`}
                          style={{ background: resolved }}
                        />
                      )
                    })}
                  </div>
                  <button
                    onClick={() => updatePageBg({ type: 'solid', color: pageBgColor })}
                    className="w-full rounded bg-muted/40 px-2 py-1.5 text-body text-muted-foreground transition-colors hover:bg-muted/60"
                  >
                    {translate('property.pageBackground.switchToNormal')}
                  </button>
                </div>
              ) : (
                <div className="grid gap-2">
                  <FillEditor
                    key={`page-bg-${page.id}-${pageBgType}`}
                    fill={pageBgType === 'solid' ? toColorInputHex(pageBgColor) : undefined}
                    gradient={pageBgType === 'gradient' ? pageBgGradient : undefined}
                    pattern={pageBgType === 'image' ? (pageBgImage?.src || '') : undefined}
                    modeOverride={pageBgType === 'image' ? 'pattern' : pageBgType === 'gradient' ? 'gradient' : 'solid'}
                    opacity={pageBgType === 'solid' ? extractColorAlpha(pageBgColor) : undefined}
                    onFillChange={(v) => { const alpha = extractColorAlpha(pageBgColor); updatePageBg({ type: 'solid', color: colorWithAlpha(v, alpha) }) }}
                    onOpacityChange={(a) => updatePageBg({ type: 'solid', color: colorWithAlpha(pageBgColor, a) })}
                    onGradientChange={(g) => updatePageBg({ type: 'gradient', gradient: g })}
                    onPatternChange={(v) => {
                      const src = (v || '').trim()
                      if (!src) { updatePageBg({ type: 'solid', color: pageBgColor }); return }
                      updatePageBg({ type: 'image', image: { src, size: pageBgImage?.size || 'cover' } })
                    }}
                    onUploadImage={onUploadImage}
                  />
                  {pageBgType === 'image' && (
                    <div className="flex items-center gap-2">
                      <FieldLabel>{translate('property.pageBackground.imageFit')}</FieldLabel>
                      <PanelSelect
                        value={pageBgImage?.size || 'cover'}
                        onChange={(e) => updatePageBg({ type: 'image', image: { src: pageBgImage?.src || '', size: e.target.value as 'cover' | 'contain' | 'repeat' } })}
                        className="w-auto"
                      >
                        <option value="cover">{translate('property.pageBackground.imageFitCover')}</option>
                        <option value="contain">{translate('property.pageBackground.imageFitContain')}</option>
                        <option value="repeat">{translate('property.pageBackground.imageFitRepeat')}</option>
                      </PanelSelect>
                    </div>
                  )}
                  <button
                    onClick={() => {
                      const theme: SlideBackgroundTheme = { key: pageBgTheme?.key || 'lt1', color: pageBgColor }
                      updatePageBg({ type: 'theme', color: pageBgColor, theme })
                    }}
                    className="w-full rounded bg-accent/10 px-2 py-1.5 text-body font-medium text-accent transition-colors hover:bg-accent/20"
                  >
                    {translate('property.pageBackground.useTheme')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </SectionPanel>

      {/* ── Canvas Assist ── */}
      <SectionPanel title={translate('property.canvasAssist.title')} storageKey="slide.canvasAssist">
        <div className="grid gap-2.5">
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-body text-muted-foreground">{translate('property.canvasAssist.snapToGuides')}</span>
            <input
              type="checkbox"
              checked={editorConfig.snapToGuides}
              onChange={(e) => updateEditorConfig({ snapToGuides: e.target.checked })}
              className="accent-accent"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-body text-muted-foreground">{translate('property.canvasAssist.snapToGrid')}</span>
            <input
              type="checkbox"
              checked={editorConfig.snapToGrid}
              onChange={(e) => updateEditorConfig({ snapToGrid: e.target.checked })}
              className="accent-accent"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-2">
            <span className="text-body text-muted-foreground">{translate('property.canvasAssist.showGrid')}</span>
            <input
              type="checkbox"
              checked={editorConfig.showGrid}
              onChange={(e) => updateEditorConfig({ showGrid: e.target.checked })}
              className="accent-accent"
            />
          </label>
        </div>
      </SectionPanel>

      {/* ── Theme fonts ── */}
      {presentation?.theme && (
        <SectionPanel title={translate('property.themeFont.title')} storageKey="slide.themeFont">
          <div className="grid gap-2.5">
            <div>
              <FieldLabel>{translate('property.themeFont.heading')}</FieldLabel>
              <FontSelect
                value={headingFont}
                onChange={(v) => {
                  if (v) runWithHistory(() => updatePresentationMeta({ theme: { ...presentation.theme!, headingFontName: v } }))
                }}
                placeholder={translate('property.themeFont.headingPlaceholder')}
              />
            </div>
            <div>
              <FieldLabel>{translate('property.themeFont.body')}</FieldLabel>
              <FontSelect
                value={bodyFont}
                onChange={(v) => {
                  if (v) runWithHistory(() => updatePresentationMeta({ theme: { ...presentation.theme!, fontName: v } }))
                }}
                placeholder={translate('property.themeFont.bodyPlaceholder')}
              />
            </div>
          </div>
        </SectionPanel>
      )}

    </ScrollArea>
  )
}
