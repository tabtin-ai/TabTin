import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

const readPackageSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../..', relativePath), 'utf-8')

describe('#643: 图层面板独立侧边栏', () => {
  it('RightSidebar 不再把图层作为互斥 tab', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    expect(src).toContain("const TAB_IDS = ['insert', 'edit', 'animation'] as const")
    const tabDefs = src.slice(src.indexOf('const TAB_DEFS'), src.indexOf('// ---------------------------------------------------------------------------'))
    expect(tabDefs).not.toContain("id: 'layers'")
    expect(src).not.toContain('<LayerList')
  })

  it('SlideEditor 只挂载一个右侧栏并持有图层开关状态', () => {
    const src = readSrc('components/SlideEditor.tsx')
    expect(src).toContain('isLayerPanelOpen')
    expect(src).toMatch(/<RightSidebar[\s\S]*?isLayerPanelOpen=\{isLayerPanelOpen\}[\s\S]*?onToggleLayerPanel=/)
    expect(src).not.toContain('<LayerSidebar')
  })

  it('RightSidebar 把图层按钮放在缩放按钮组上方', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    const panelSrc = readPackageSrc('smartsheet-ui/src/components/floating-panel.tsx')
    expect(src).toContain('capsuleBeforeFooter={layerToggle}')
    expect(src).toContain('capsuleFooter={zoomFooter}')
    expect(panelSrc.indexOf('{capsuleBeforeFooter}')).toBeLessThan(panelSrc.indexOf('{capsuleFooter}'))
    expect(src).toContain('isActive={isLayerPanelOpen}')
  })

  it('RightSidebar 用 FloatingPanel secondaryPanels 同时显示图层内容', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    expect(src).toContain('const secondaryPanels = useMemo<FloatingPanelContent[]>')
    expect(src).toContain("id: 'layers'")
    expect(src).toContain('children: <LayerSidebar />')
    expect(src).toContain('resizable: true')
    expect(src).toContain('minHeight: 180')
    expect(src).toContain('secondaryPanels={secondaryPanels}')
  })

  it('RightSidebar 空选中时显示页面属性标题', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/tabslide.json'), 'utf-8'))
    const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/tabslide.json'), 'utf-8'))
    expect(src).toContain("translate('property.pageProperties')")
    expect(src).not.toContain("elements.length > 0 ? translate('tab.properties') : translate('tab.slide')")
    expect(zh.property.pageProperties).toBe('页面属性')
    expect(en.property.pageProperties).toBe('Page Properties')
  })

  it('RightSidebar 在图层隐藏时让上方面板填充到底部', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    expect(src).toContain('panelOpen={activeTab !== null || isLayerPanelOpen}')
    expect(src).toContain('...(activeTab ? { height: LAYER_PANEL_HEIGHT } : {})')
  })

  it('LayerSidebar 只提供内容并按当前页重建图层列表', () => {
    const src = readSrc('panels/right-sidebar/LayerSidebar.tsx')
    expect(src).not.toContain('<FloatingPanel')
    expect(src).toMatch(/<LayerList key=\{`layer-sidebar-\$\{currentPageIndex\}`\}/)
  })

  it('LayerList 把层级移动按钮放到底部常驻 actionbar', () => {
    const src = readSrc('panels/right-sidebar/LayersTab.tsx')
    const scrollEnd = src.indexOf('</ScrollArea>')
    const actionbar = src.indexOf('aria-label="Layer actions"')
    const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/zh-CN/tabslide.json'), 'utf-8'))
    const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../apps/tabtin-electron/src/renderer/src/i18n/locales/en-US/tabslide.json'), 'utf-8'))
    expect(actionbar).toBeGreaterThan(scrollEnd)
    expect(src).toContain("import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Eye, EyeOff, Lock, Unlock } from 'lucide-react'")
    expect(src).toContain('className="flex shrink-0 items-center border-t border-border/30 px-2.5 py-1"')
    expect(src).toContain('className="flex gap-1.5"')
    expect(src).toContain("getLayerActionTitle('property.layer.action.toFront')")
    expect(src).toContain('<ArrowUpToLine className="h-3 w-3" strokeWidth={1.75} />')
    expect(src).toContain('<ArrowDownToLine className="h-3 w-3" strokeWidth={1.75} />')
    expect(src).toContain('disabled={!hasMovableSelection}')
    expect(src).toContain('const allLayersHidden = hasLayerItems && page.elements.every((el) => el.visible === false)')
    expect(src).toContain('const allLayersLocked = hasLayerItems && page.elements.every((el) => el.locked)')
    expect(src).toContain("translate(allLayersHidden ? 'property.layer.action.showAll' : 'property.layer.action.hideAll')")
    expect(src).toContain('onClick={() => onSetVisibility(allElementIds, allLayersHidden)}')
    expect(src).toContain('allLayersHidden ? <EyeOff className="h-3 w-3" strokeWidth={1.75} /> : <Eye className="h-3 w-3" strokeWidth={1.75} />')
    expect(src).toContain("translate(allLayersLocked ? 'property.layer.action.unlockAll' : 'property.layer.action.lockAll')")
    expect(src).toContain('onClick={() => onSetLock(allElementIds, !allLayersLocked)}')
    expect(src).toContain('active={allLayersLocked}')
    expect(src).toContain('allLayersLocked ? <Lock className="h-3 w-3" strokeWidth={1.75} /> : <Unlock className="h-3 w-3" strokeWidth={1.75} />')
    expect(src).toContain('disabled={!hasLayerItems}')
    expect(zh.property.layer.action.hideAll).toBe('全部隐藏')
    expect(zh.property.layer.action.lockAll).toBe('全部锁定')
    expect(en.property.layer.action.hideAll).toBe('Hide All')
    expect(en.property.layer.action.lockAll).toBe('Lock All')
    expect(src).not.toContain('{hasSelection && (')
  })

  it('LayerBtn 支持图层状态高亮', () => {
    const src = readSrc('panels/right-sidebar/shared/components.tsx')
    expect(src).toContain('active?: boolean')
    expect(src).toContain('<PanelIconButton size="sm" active={active}')
  })

  it('LayerList 使用原页面属性图层的元素文案规则', () => {
    const src = readSrc('panels/right-sidebar/LayersTab.tsx')
    expect(src).toContain('const getLayerElementLabel = useCallback((element: PPTElement) => {')
    expect(src).toContain("raw.replace(/<[^>]+>/g, '').trim()")
    expect(src).toContain("return stripped.length > 20 ? `${stripped.slice(0, 20)}…` : stripped || translate('element.type.text')")
    expect(src).toContain("return element.text?.content?.replace(/<[^>]+>/g, '').trim() || translate('element.type.shape')")
    expect(src).toContain('const elName = getLayerElementLabel(el)')
    expect(src).toContain('const memberName = getLayerElementLabel(member)')
    expect(src).not.toContain('typeLabel(el.type, translate)')
    expect(src).not.toContain('typeLabel(member.type, translate)')
  })

  it('SlideTab 不再内嵌图层 section', () => {
    const src = readSrc('panels/right-sidebar/SlideTab.tsx')
    expect(src).not.toContain("title={translate('tab.layers')}")
    expect(src).not.toContain('storageKey="slide.layers"')
    expect(src).not.toContain('MiniLayerRow')
  })

  it('PropertiesTab 不再显示图层可见性和锁定按钮', () => {
    const src = readSrc('panels/right-sidebar/PropertiesTab.tsx')
    const elementSection = src.slice(
      src.indexOf('storageKey="slide.element"'),
      src.indexOf('<SectionPanel title={translate(\'property.transform\')'),
    )
    expect(elementSection).not.toContain('actions=')
    expect(elementSection).not.toContain('property.show')
    expect(elementSection).not.toContain('property.hide')
    expect(elementSection).not.toContain('property.lock')
    expect(elementSection).not.toContain('property.unlock')
    expect(src).not.toContain('PanelIconButton')
  })

  it('FloatingPanel 支持一个胶囊栏同时打开多个 panelContent', () => {
    const src = readPackageSrc('smartsheet-ui/src/components/floating-panel.tsx')
    expect(src).toContain('export interface FloatingPanelContent')
    expect(src).toContain('secondaryPanels?: FloatingPanelContent[]')
    expect(src).toContain('resizable?: boolean')
    expect(src).toContain('minHeight?: number')
    expect(src).toContain('maxHeight?: number')
    expect(src).toContain('minPanelWidth?: number')
    expect(src).toContain('maxPanelWidth?: number')
    expect(src).toContain('capsuleBeforeFooter?: React.ReactNode')
    expect(src).toContain('panelOpen?: boolean')
    expect(src).toContain('const [resizedPanelWidth, setResizedPanelWidth]')
    expect(src).toContain('const handleWidthResizeStart = React.useCallback')
    expect(src).toContain('const currentPanelWidth = resizedPanelWidth ?? panelWidth')
    expect(src).toContain('const openWidth = currentPanelWidth + CAPSULE_WIDTH + PANEL_GAP + CAPSULE_GAP * 2')
    expect(src).toContain('const panelContents: FloatingPanelContent[]')
    expect(src).toContain('panelContents.map((content, index)')
    expect(src).toContain('role="separator"')
    expect(src).toContain('cursor-row-resize')
    expect(src).toContain('aria-orientation="vertical"')
    expect(src).toContain('cursor-col-resize')
    expect(src).toContain('title="Resize panel width"')
    expect(src).toContain('onPointerDown={handleWidthResizeStart}')
    expect(src).toContain('isLeft ? "right-0" : "left-0"')
    expect(src).toContain('bottom-[-6px]')
    expect(src).toContain('top-[-6px]')
    expect(src).toContain('canResizeFromTop && content.resizable')
    expect(src).toContain('handleResizeStart(content, event)')
    expect(src).not.toContain('h-px w-full bg-border')
    expect(src).toContain('className="relative flex min-w-0 flex-col gap-2 overflow-hidden"')
    expect(src).toContain('px-3 py-2')
    expect(src).toContain('text-body font-medium text-foreground')
    expect(src).not.toContain('px-4 py-3')
    expect(src).not.toContain('text-caption font-medium text-foreground')
    expect(src).not.toContain('text-subtitle font-semibold text-foreground')
    expect(src.indexOf('{capsuleBeforeFooter}')).toBeLessThan(src.indexOf('border-t border-border'))
    expect(src.indexOf('border-t border-border')).toBeLessThan(src.indexOf('{capsuleFooter}'))
  })
})
