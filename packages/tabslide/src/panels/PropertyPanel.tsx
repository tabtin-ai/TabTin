import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import type {
  PPTElement, SlideBackground,
  SlideBackgroundTheme, SlideLayoutRef,
} from '../types/slides'
import { resolveBackgroundColor } from '../utils/background'
import { useT } from '../i18n'
import { SLIDE_BG } from '../defaults/colors'

import {
  TOOLBAR_WIDTH, PANEL_WIDTH, ANIM_MS,
  BG_THEME_KEYS,
  roundTo, toColorInputHex, extractColorAlpha, colorWithAlpha,
  typeLabel,
  type LayoutOption,
  getLayoutKey, cloneLayoutRef, getLayoutOptionLabel, getThemeKeyLabel,
} from './right-sidebar/shared/constants'
import {
  ToolbarIconBtn, FieldLabel, NumberInput, ColorSwatch, RangeSlider,
  PanelSelect, PanelInput,
} from './right-sidebar/shared/components'
import { SectionPanel } from '@tabtin/smartsheet-ui'
import {
  PageIcon, MoveIcon, TransformIcon, CloseIcon,
} from './right-sidebar/shared/icons'
import { Layers as LayersIcon } from 'lucide-react'
import { StyleEditor } from './right-sidebar/editors/style-editor'
import { FillEditor } from './right-sidebar/editors/FillEditor'
import { LayerList } from './right-sidebar/LayersTab'
import { ScrollArea } from '../components/ui/ScrollArea'

/**
 * PropertyPanel — 右侧属性面板
 *
 * 两种状态：
 * 1. 收起态：常驻窄图标工具条（40px），悬浮在画布右侧
 * 2. 展开态：点击图标后滑出完整操作面板（240px），覆盖在画布上方
 *
 * 面板不占用 flex 布局空间（absolute 定位），画布始终撑满。
 */
const PropertyPanel: React.FC = () => {
  const translate = useT()
  const presentation = useSlideStore((s) => s.presentation)
  const currentPageIndex = useSlideStore((s) => s.currentPageIndex)
  const selectedElements = useSlideStore((s) => s.selectedElements)
  const updateElement = useSlideStore((s) => s.updateElement)
  const updatePageBackground = useSlideStore((s) => s.updatePageBackground)
  const updatePageLayout = useSlideStore((s) => s.updatePageLayout)
  const updatePageMasterElements = useSlideStore((s) => s.updatePageMasterElements)
  const selectElement = useSlideStore((s) => s.selectElement)
  const bringForwardSelection = useSlideStore((s) => s.bringForwardSelection)
  const sendBackwardSelection = useSlideStore((s) => s.sendBackwardSelection)
  const bringSelectionToFront = useSlideStore((s) => s.bringSelectionToFront)
  const sendSelectionToBack = useSlideStore((s) => s.sendSelectionToBack)
  const toggleVisibility = useSlideStore((s) => s.toggleVisibility)
  const setVisibility = useSlideStore((s) => s.setVisibility)
  const toggleLock = useSlideStore((s) => s.toggleLock)
  const setLocked = useSlideStore((s) => s.setLocked)
  const setGroupName = useSlideStore((s) => s.setGroupName)
  const reorderElements = useSlideStore((s) => s.reorderElements)
  const updatePresentationMeta = useSlideStore((s) => s.updatePresentationMeta)
  const selectedElementIds = useSlideStore((s) => s.selectedElementIds)
  const editingElementId = useSlideStore((s) => s.editingElementId)

  const [expanded, setExpanded] = useState(false)
  const [activeSection, setActiveSection] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const elements = selectedElements()
  const page = presentation?.pages[currentPageIndex]
  const hasSelection = elements.length > 0
  const el = hasSelection ? elements[0] : null
  const isLine = el?.type === 'line'

  useEffect(() => {
    if (!expanded) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handler)
    }
  }, [expanded])

  const handleUpdate = useCallback(
    (id: string, updates: Partial<PPTElement>) => updateElement(id, updates),
    [updateElement],
  )

  const openSection = useCallback((section: string) => {
    setActiveSection(section)
    setExpanded(true)
  }, [])

  const runWithHistory = useCallback((fn: () => void) => {
    const s = useSlideStore.getState()
    if (s.presentation) {
      useHistoryStore.getState().pushSnapshot(s.presentation.pages)
    }
    fn()
  }, [])

  const handleLayerBringForward = useCallback(
    (ids: string[]) => runWithHistory(() => bringForwardSelection(ids)),
    [bringForwardSelection, runWithHistory],
  )
  const handleLayerSendBackward = useCallback(
    (ids: string[]) => runWithHistory(() => sendBackwardSelection(ids)),
    [runWithHistory, sendBackwardSelection],
  )
  const handleLayerBringToFront = useCallback(
    (ids: string[]) => runWithHistory(() => bringSelectionToFront(ids)),
    [bringSelectionToFront, runWithHistory],
  )
  const handleLayerSendToBack = useCallback(
    (ids: string[]) => runWithHistory(() => sendSelectionToBack(ids)),
    [runWithHistory, sendSelectionToBack],
  )
  const handleLayerToggleVisibility = useCallback(
    (id: string) => runWithHistory(() => toggleVisibility(id)),
    [runWithHistory, toggleVisibility],
  )
  const handleLayerSetVisibility = useCallback(
    (ids: string[], visible: boolean) => runWithHistory(() => setVisibility(ids, visible)),
    [runWithHistory, setVisibility],
  )
  const handleLayerToggleLock = useCallback(
    (id: string) => runWithHistory(() => toggleLock(id)),
    [runWithHistory, toggleLock],
  )
  const handleLayerSetLock = useCallback(
    (ids: string[], locked: boolean) => runWithHistory(() => setLocked(ids, locked)),
    [runWithHistory, setLocked],
  )
  const handleLayerSetGroupName = useCallback(
    (ids: string[], groupName: string) => runWithHistory(() => setGroupName(ids, groupName)),
    [runWithHistory, setGroupName],
  )
  const handleLayerReorder = useCallback(
    (from: number, to: number) => runWithHistory(() => reorderElements(from, to)),
    [reorderElements, runWithHistory],
  )

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
  }, [
    currentPageIndex,
    layoutOptions,
    runWithHistory,
    updatePageLayout,
    updatePageMasterElements,
  ])

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
  const themePalettePreview = BG_THEME_KEYS.map((item) => ({
    ...item,
    color: resolveBackgroundColor(
      { type: 'theme', theme: { key: item.key } },
      presentation?.theme,
    ),
  }))

  const updatePageBg = (bg: SlideBackground) => {
    updatePageBackground(currentPageIndex, bg)
  }

  const switchToThemeBackground = () => {
    const theme: SlideBackgroundTheme = {
      key: pageBgTheme?.key || 'lt1',
      color: pageBgColor,
    }
    updatePageBg({ type: 'theme', color: pageBgColor, theme })
  }

  const switchToNormalBackground = () => {
    updatePageBg({ type: 'solid', color: pageBgColor })
  }

  type ToolItem = { id: string; icon: React.ReactNode; label: string; show: boolean }
  const tools: ToolItem[] = [
    { id: 'page', icon: <PageIcon />, label: translate('property.toolbar.page'), show: !hasSelection },
    { id: 'pos', icon: <MoveIcon />, label: translate('property.toolbar.position'), show: hasSelection },
    { id: 'transform', icon: <TransformIcon />, label: translate('property.toolbar.transform'), show: hasSelection },
    { id: 'layer', icon: <LayersIcon className="w-[18px] h-[18px]" />, label: translate('property.toolbar.layer'), show: true },
  ]

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-0 bottom-0 flex z-30 pointer-events-none"
      style={{
        width: expanded ? TOOLBAR_WIDTH + PANEL_WIDTH : TOOLBAR_WIDTH,
        transition: `width ${ANIM_MS} ease`,
      }}
    >
      {/* ── 窄图标工具条（常驻） ── */}
      <div
        className="shrink-0 flex flex-col items-center pt-2.5 gap-0.5 bg-background border-l border-border/30 pointer-events-auto"
        style={{ width: TOOLBAR_WIDTH }}
      >
        {tools.filter((ti) => ti.show).map((ti) => (
          <ToolbarIconBtn
            key={ti.id}
            active={expanded && activeSection === ti.id}
            title={ti.label}
            onClick={() => {
              if (expanded && activeSection === ti.id) {
                setExpanded(false)
              } else {
                openSection(ti.id)
              }
            }}
          >
            {ti.icon}
          </ToolbarIconBtn>
        ))}
      </div>

      {/* ── 展开面板（滑出） ── */}
      <ScrollArea
        className="shrink-0 bg-background border-l border-border/10"
        style={{
          width: PANEL_WIDTH,
          opacity: expanded ? 1 : 0,
          transform: expanded ? 'translateX(0)' : `translateX(${PANEL_WIDTH}px)`,
          transition: `transform ${ANIM_MS} ease, opacity ${ANIM_MS} ease`,
          pointerEvents: expanded ? 'auto' : 'none',
        }}
      >
        {/* 面板头 */}
        <div className="flex items-center justify-between pt-2.5 pr-3 pb-2 pl-3.5 border-b border-border/10">
          <span className="font-semibold text-caption text-muted-foreground uppercase tracking-[0.5px]">
            {hasSelection
              ? (elements.length === 1 ? typeLabel(el!.type, translate) : translate('property.multiSelection', { count: elements.length }))
              : translate('property.page')}
          </span>
          <button
            onClick={() => setExpanded(false)}
            title={translate('property.collapse')}
            className="border-none bg-transparent cursor-pointer p-0.5 rounded text-muted-foreground/60 flex hover:text-muted-foreground"
          >
            <CloseIcon />
          </button>
        </div>

        {/* ── 面板内容 ── */}
        {activeSection === 'layer' ? (
          <LayerList
            page={page}
            selectedIds={selectedElementIds}
            onSelect={selectElement}
            onToggleVisibility={handleLayerToggleVisibility}
            onSetVisibility={handleLayerSetVisibility}
            onToggleLock={handleLayerToggleLock}
            onSetLock={handleLayerSetLock}
            onSetGroupName={handleLayerSetGroupName}
            onBringForward={handleLayerBringForward}
            onSendBackward={handleLayerSendBackward}
            onBringToFront={handleLayerBringToFront}
            onSendToBack={handleLayerSendToBack}
            onReorder={handleLayerReorder}
          />
        ) : !hasSelection ? (
          <>
            <SectionPanel title={translate('property.pageLayout.title')} storageKey="slide.prop.layout" defaultCollapsed={false}>
              <div className="grid gap-1.5">
                <PanelSelect
                  value={currentLayoutKey}
                  onChange={(e) => applyLayoutOption(e.target.value)}
                  disabled={layoutOptions.length === 0}
                >
                  <option value="">{translate('property.pageLayout.unbound')}</option>
                  {layoutOptions.map((item) => (
                    <option key={item.key} value={item.key}>{item.label}</option>
                  ))}
                </PanelSelect>
                {page.layout ? (
                  <div className="grid gap-0.5">
                    {typeof page.layout.index === 'number' && (
                      <span className="text-caption text-muted-foreground/60">
                        {translate('property.pageLayout.index', { index: page.layout.index })}
                      </span>
                    )}
                    {page.layout.partName && (
                      <span className="text-caption text-muted-foreground/60 break-all">
                        {page.layout.partName}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-caption text-muted-foreground/60">
                    {layoutOptions.length > 0
                      ? translate('property.pageLayout.noOriginMeta')
                      : translate('property.pageLayout.noSnapshots')}
                  </span>
                )}
              </div>
            </SectionPanel>
            <SectionPanel title={translate('property.pageBackground.title')} storageKey="slide.prop.bg" defaultCollapsed={false}>
              {pageBgType === 'theme' ? (
                <div className="grid gap-2">
                  <div className="grid grid-cols-2 gap-1.5">
                    <div>
                      <FieldLabel>{translate('property.pageBackground.themeKey')}</FieldLabel>
                      <PanelSelect
                        value={pageBgTheme?.key || 'lt1'}
                        onChange={(e) => {
                          const key = e.target.value
                          updatePageBg({
                            type: 'theme',
                            color: pageBgColor,
                            theme: {
                              key,
                              color: pageBgTheme?.color || pageBgColor,
                            },
                          })
                        }}
                      >
                        {BG_THEME_KEYS.map((item) => (
                          <option key={item.key} value={item.key}>{getThemeKeyLabel(item, translate)}</option>
                        ))}
                      </PanelSelect>
                    </div>
                    <div>
                      <FieldLabel>{translate('property.pageBackground.resolvedColor')}</FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <ColorSwatch
                          value={pageBgColor}
                          onChange={(v) => {
                            updatePageBg({
                              type: 'theme',
                              color: v,
                              theme: {
                                key: pageBgTheme?.key || 'lt1',
                                color: v,
                              },
                            })
                          }}
                        />
                        <span className="text-caption text-muted-foreground/60 font-mono">{pageBgColor}</span>
                      </div>
                    </div>
                  </div>
                  <div className="grid gap-1">
                    <FieldLabel>{translate('property.pageBackground.themePalette')}</FieldLabel>
                    <div className="grid grid-cols-5 gap-1.5">
                      {themePalettePreview.map((item) => {
                        const isActive = (pageBgTheme?.key || 'lt1') === item.key
                        const itemLabel = getThemeKeyLabel(item, translate)
                        return (
                          <button
                            key={item.key}
                            title={`${itemLabel} · ${item.color}`}
                            onClick={() => {
                              updatePageBg({
                                type: 'theme',
                                color: item.color,
                                theme: { key: item.key, color: item.color },
                              })
                            }}
                            className={`border bg-background rounded p-1 cursor-pointer grid gap-1 justify-items-center ${
                              isActive ? 'border-accent' : 'border-border/10'
                            }`}
                          >
                            <span
                              className="w-4 h-4 rounded-full border border-border/30 inline-block"
                              style={{ background: item.color }}
                            />
                            <span className={`text-caption ${isActive ? 'text-accent' : 'text-muted-foreground/60'}`}>
                              {itemLabel.replace(/\s+/g, '')}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <button
                    onClick={switchToNormalBackground}
                    className="border border-border/10 bg-background text-muted-foreground rounded px-2 py-[5px] text-caption cursor-pointer hover:bg-muted/50"
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
                    onFillChange={(v) => {
                      const alpha = extractColorAlpha(pageBgColor)
                      updatePageBg({ type: 'solid', color: colorWithAlpha(v, alpha) })
                    }}
                    onOpacityChange={(a) => {
                      updatePageBg({ type: 'solid', color: colorWithAlpha(pageBgColor, a) })
                    }}
                    onGradientChange={(g) => updatePageBg({ type: 'gradient', gradient: g })}
                    onPatternChange={(v) => {
                      const src = (v || '').trim()
                      if (!src) {
                        updatePageBg({ type: 'solid', color: pageBgColor })
                        return
                      }
                      updatePageBg({
                        type: 'image',
                        image: {
                          src,
                          size: pageBgImage?.size || 'cover',
                        },
                      })
                    }}
                  />
                  {pageBgType === 'image' && (
                    <div className="grid gap-1">
                      <FieldLabel>{translate('property.pageBackground.imageFit')}</FieldLabel>
                      <PanelSelect
                        value={pageBgImage?.size || 'cover'}
                        onChange={(e) => updatePageBg({
                          type: 'image',
                          image: {
                            src: pageBgImage?.src || '',
                            size: e.target.value as 'cover' | 'contain' | 'repeat',
                          },
                        })}
                      >
                        <option value="cover">{translate('property.pageBackground.imageFitCover')}</option>
                        <option value="contain">{translate('property.pageBackground.imageFitContain')}</option>
                        <option value="repeat">{translate('property.pageBackground.imageFitRepeat')}</option>
                      </PanelSelect>
                    </div>
                  )}
                  <button
                    onClick={switchToThemeBackground}
                    className="border border-accent bg-accent/10 text-accent rounded px-2 py-[5px] text-caption cursor-pointer hover:bg-accent/20"
                  >
                    {translate('property.pageBackground.useTheme')}
                  </button>
                </div>
              )}
            </SectionPanel>
            {presentation?.theme && (
              <>
                <SectionPanel title={translate('property.themeFont.title')} storageKey="slide.prop.font" defaultCollapsed={false}>
                  <div className="grid gap-1.5">
                    <div>
                      <FieldLabel>{translate('property.themeFont.heading')}</FieldLabel>
                      <PanelInput
                        value={presentation.theme.headingFontName || presentation.theme.fontName || ''}
                        onChange={(e) => {
                          const val = e.target.value.trim()
                          if (!val) return
                          runWithHistory(() => {
                            updatePresentationMeta({
                              theme: { ...presentation.theme!, headingFontName: val },
                            })
                          })
                        }}
                        placeholder={translate('property.themeFont.headingPlaceholder')}
                      />
                      <span className="text-caption text-muted-foreground/60 mt-0.5 block">
                        {translate('property.currentValue', {
                          value: presentation.theme.headingFontName || presentation.theme.fontName || translate('property.default'),
                        })}
                      </span>
                    </div>
                    <div>
                      <FieldLabel>{translate('property.themeFont.body')}</FieldLabel>
                      <PanelInput
                        value={presentation.theme.fontName || ''}
                        onChange={(e) => {
                          const val = e.target.value.trim()
                          if (!val) return
                          runWithHistory(() => {
                            updatePresentationMeta({
                              theme: { ...presentation.theme!, fontName: val },
                            })
                          })
                        }}
                        placeholder={translate('property.themeFont.bodyPlaceholder')}
                      />
                      <span className="text-caption text-muted-foreground/60 mt-0.5 block">
                        {translate('property.currentValue', {
                          value: presentation.theme.fontName || translate('property.default'),
                        })}
                      </span>
                    </div>
                  </div>
                </SectionPanel>
              </>
            )}
          </>
        ) : el && elements.length === 1 ? (
          <>
            <SectionPanel title={translate('property.positionSize')} storageKey="slide.prop.position" defaultCollapsed={false}>
              <div className="grid grid-cols-2 gap-1">
                <NumberInput label="X" value={roundTo(el.x)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { x: v } as Partial<PPTElement>)} fullWidth />
                <NumberInput label="Y" value={roundTo(el.y)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { y: v } as Partial<PPTElement>)} fullWidth />
                <NumberInput label="W" value={roundTo(el.width)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { width: v } as Partial<PPTElement>)} fullWidth />
                {!isLine && (
                  <NumberInput label="H" value={roundTo((el as { height: number }).height)} step={0.1} precision={1} onChange={(v) => handleUpdate(el.id, { height: v } as Partial<PPTElement>)} fullWidth />
                )}
              </div>
            </SectionPanel>

            <SectionPanel title={translate('property.transform')} storageKey="slide.prop.transform" defaultCollapsed={false}>
              <div className="grid grid-cols-2 gap-1">
                {!isLine && (
                  <NumberInput
                    label={translate('property.rotate')}
                    value={roundTo((el as { rotate: number }).rotate)}
                    step={0.1}
                    precision={1}
                    onChange={(v) => handleUpdate(el.id, { rotate: v } as Partial<PPTElement>)}
                    suffix="°"
                    fullWidth
                  />
                )}
                <div>
                  <FieldLabel>{translate('property.opacity')}</FieldLabel>
                  <div className="flex items-center gap-1.5">
                    <RangeSlider
                      min={0} max={1} step={0.01}
                      value={el.opacity}
                      onChange={(v) => handleUpdate(el.id, { opacity: v } as Partial<PPTElement>)}
                      className="flex-1"
                    />
                    <span className="text-caption text-muted-foreground/60 min-w-7 text-right">
                      {Math.round(el.opacity * 100)}%
                    </span>
                  </div>
                </div>
              </div>
              {!isLine && (
                <div className="grid grid-cols-2 gap-1 mt-1.5">
                  <button
                    onClick={() => handleUpdate(el.id, {
                      flipH: !(el as { flipH?: boolean }).flipH,
                    } as Partial<PPTElement>)}
                    className={`border rounded py-[5px] text-caption cursor-pointer ${
                      (el as { flipH?: boolean }).flipH
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border/10 bg-background text-muted-foreground'
                    }`}
                  >
                    {translate('property.flipHorizontal')}
                  </button>
                  <button
                    onClick={() => handleUpdate(el.id, {
                      flipV: !(el as { flipV?: boolean }).flipV,
                    } as Partial<PPTElement>)}
                    className={`border rounded py-[5px] text-caption cursor-pointer ${
                      (el as { flipV?: boolean }).flipV
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-border/10 bg-background text-muted-foreground'
                    }`}
                  >
                    {translate('property.flipVertical')}
                  </button>
                </div>
              )}
            </SectionPanel>

            <StyleEditor
              element={el}
              onUpdate={handleUpdate}
              editingElementId={editingElementId}
            />
          </>
        ) : (
          <div className="px-3 py-2">
            <span className="text-body text-muted-foreground/60">
              {translate('property.multiSelection', { count: elements.length })}
            </span>
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

export default PropertyPanel
