import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSlideStore } from '../../store/slide'
import { useT } from '../../i18n'
import { SlideInsertPanel } from './SlideInsertPanel'
import { SlideTab } from './SlideTab'
import { PropertiesTab } from './PropertiesTab'
import { AnimationTab } from './AnimationTab'
import { LayerSidebar } from './LayerSidebar'
import { PlusCircle, SlidersHorizontal, Sparkles, Layers, Plus, Minus, Maximize } from 'lucide-react'
import { ScrollArea } from '../../components/ui/ScrollArea'
import {
  FloatingPanel,
  CapsuleButton,
  CapsuleLabel,
  type FloatingPanelContent,
  type FloatingPanelTab,
} from '@tabtin/smartsheet-ui'

const TAB_IDS = ['insert', 'edit', 'animation'] as const
type TabId = (typeof TAB_IDS)[number]

function isTabId(v: string | null): v is TabId {
  return v !== null && (TAB_IDS as readonly string[]).includes(v)
}

export interface RightSidebarProps {
  zoom?: number
  onZoomChange?: (z: number) => void
  onFit?: () => void
  onUploadImage?: (file: File) => Promise<string>
  onImageError?: (type: 'validation' | 'upload' | 'load', message: string) => void
  isLayerPanelOpen?: boolean
  onToggleLayerPanel?: () => void
}

const LAYER_PANEL_HEIGHT = 320
const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.1
const ZOOM_MAX = 5

const TAB_DEFS: { id: TabId; labelKey: string; icon: React.ReactNode }[] = [
  { id: 'insert', labelKey: 'tab.insert', icon: <PlusCircle className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'edit', labelKey: 'tab.edit', icon: <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> },
  { id: 'animation', labelKey: 'tab.animation', icon: <Sparkles className="h-3.5 w-3.5" aria-hidden /> },
]

// ---------------------------------------------------------------------------
// RightSidebar
// ---------------------------------------------------------------------------

export const RightSidebar: React.FC<RightSidebarProps> = ({
  zoom, onZoomChange, onFit, onUploadImage, onImageError,
  isLayerPanelOpen = false,
  onToggleLayerPanel,
}) => {
  const translate = useT()
  const selectedElements = useSlideStore((s) => s.selectedElements)

  const elements = selectedElements()

  const [activeTab, setActiveTab] = useState<TabId | null>('edit')
  const setEditing = useSlideStore((s) => s.setEditing)
  const prevTabRef = useRef<TabId | null>(activeTab)

  const handleTabChange = useCallback((id: string | null) => {
    setActiveTab(id === null ? null : isTabId(id) ? id : null)
  }, [])

  useEffect(() => {
    const prev = prevTabRef.current
    prevTabRef.current = activeTab
    if (prev === 'edit' && activeTab !== 'edit') {
      setEditing(null)
    }
  }, [activeTab, setEditing])

  const getPanelTitle = (): string => {
    if (!activeTab) return ''
    if (activeTab === 'insert') return translate('tab.insert')
    if (activeTab === 'edit') {
      return elements.length > 0 ? translate('tab.properties') : translate('property.pageProperties')
    }
    if (activeTab === 'animation') return translate('tab.animation')
    return ''
  }

  const zoomPercent = zoom !== undefined ? Math.round(zoom * 100) : 100
  const tabs = useMemo<FloatingPanelTab[]>(
    () => TAB_DEFS.map((tab) => ({ id: tab.id, label: translate(tab.labelKey), icon: tab.icon })),
    [translate],
  )

  const zoomFooter = onZoomChange && zoom !== undefined ? (
    <>
      <CapsuleButton compact onClick={() => onZoomChange(Math.max(ZOOM_MIN, zoom - ZOOM_STEP))} title={translate('canvas.zoomOut')}>
        <Minus className="h-3.5 w-3.5" />
      </CapsuleButton>
      <CapsuleLabel onClick={() => onZoomChange(1)} title={`${zoomPercent}%`}>
        {zoomPercent}%
      </CapsuleLabel>
      <CapsuleButton compact onClick={() => onZoomChange(Math.min(ZOOM_MAX, zoom + ZOOM_STEP))} title={translate('canvas.zoomIn')}>
        <Plus className="h-3.5 w-3.5" />
      </CapsuleButton>
      {onFit && (
        <CapsuleButton compact onClick={onFit} title={translate('canvas.fitToScreen')}>
          <Maximize className="h-3.5 w-3.5" />
        </CapsuleButton>
      )}
    </>
  ) : undefined

  const layerToggle = onToggleLayerPanel ? (
    <CapsuleButton
      isActive={isLayerPanelOpen}
      onClick={onToggleLayerPanel}
      title={translate('tab.layers')}
    >
      <Layers className="h-3.5 w-3.5" aria-hidden />
    </CapsuleButton>
  ) : undefined

  const secondaryPanels = useMemo<FloatingPanelContent[]>(
    () => isLayerPanelOpen
      ? [{
          id: 'layers',
          title: translate('tab.layers'),
          children: <LayerSidebar />,
          onClose: onToggleLayerPanel,
          resizable: true,
          minHeight: 180,
          ...(activeTab ? { height: LAYER_PANEL_HEIGHT } : {}),
        }]
      : [],
    [activeTab, isLayerPanelOpen, onToggleLayerPanel, translate],
  )

  const renderTabContent = (): React.ReactNode => {
    switch (activeTab) {
      case 'insert':
        return (
          <ScrollArea key="tab-insert" style={{ flex: 1 }}>
            <SlideInsertPanel onUploadImage={onUploadImage} onError={onImageError} />
          </ScrollArea>
        )
      case 'edit':
        return elements.length > 0
          ? <PropertiesTab key="tab-edit-properties" onUploadImage={onUploadImage} />
          : <SlideTab key="tab-edit-slide" onUploadImage={onUploadImage} />
      case 'animation':
        return <AnimationTab key="tab-animation" />
      default:
        return null
    }
  }

  return (
    <FloatingPanel
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      title={getPanelTitle()}
      capsuleFooter={zoomFooter}
      capsuleBeforeFooter={layerToggle}
      secondaryPanels={secondaryPanels}
      panelOpen={activeTab !== null || isLayerPanelOpen}
      className="h-full"
      unifyPanelSurface
    >
      {renderTabContent()}
    </FloatingPanel>
  )
}
