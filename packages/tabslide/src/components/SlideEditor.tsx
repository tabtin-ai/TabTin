import React, { useEffect, useState, useCallback } from 'react'
import type { SlidePresentation } from '../types/slides'
import type { SlideShowOptions } from '../hooks/useSlideShow'
import { useSlideStore } from '../store/slide'
import { useHistoryStore } from '../store/history'
import { useKeyboard } from '../hooks/useKeyboard'
import { useClipboardPaste } from '../hooks/useClipboardPaste'
import Canvas from './Canvas'
import SlideShow from './SlideShow'
import SlideTopBar from './SlideTopBar'
import PageList from '../panels/PageList'
import { RightSidebar } from '../panels/right-sidebar'
import * as t from '../theme'
import { calculateFitZoom } from '../utils/geometry'
import { PanelErrorBoundary } from '@tabtin/smartsheet-ui'
import { attachSlideEditorStoreLifecycle } from './slide-editor-store-lifecycle'

interface SlideEditorProps {
  data: SlidePresentation
  onChange?: (data: SlidePresentation) => void
  style?: React.CSSProperties
  className?: string
  /** 宿主层注入的全屏控制（如 Electron setFullScreen） */
  fullscreenOptions?: SlideShowOptions
  /** 导入 PPTX 回调 */
  onImportPPTX?: () => void
  /** 导出 PPTX 回调 */
  onExportPPTX?: () => void
  /** 导出 PDF 回调 */
  onExportPDF?: () => void
  /** 导出图片回调 */
  onExportImages?: () => void
  /**
   * 图片上传回调（宿主层注入）。
   * 传入 File → 返回可访问的 URL（如 OSS CDN URL）。
   * 未提供时降级为 base64 data URL 内联。
   */
  onUploadImage?: (file: File) => Promise<string>
  /** 图片粘贴/拖放出错回调（校验失败、上传失败、加载失败等） */
  onImageError?: (type: 'validation' | 'upload' | 'load', message: string) => void
  /** 打开版本历史面板的回调（宿主层注入） */
  onOpenVersionHistory?: () => void
  /**
   * CC-014: 远端协作者 Presence 数据（来自 awarenessPeers，包含 color 字段）。
   * 用于未来在 PageList / Canvas 渲染远端光标/选区高亮。
   */
  remotePeers?: Array<{
    userId: string
    userName: string
    userColor: string
    userType?: 'user' | 'agent'
    pageId: string | null
    elementIds: string[]
  }>
  /**
   * CC-014: 本端选区/页面变化回调（用于广播 Awareness cursor）。
   * 当宿主层不通过 Bridge 广播时可直接注入；Bridge 已接管时传 undefined。
   */
  onSelectionChange?: (pageId: string | null, elementIds: string[]) => void
}

const SlideEditor: React.FC<SlideEditorProps> = ({
  data, onChange, style, className, fullscreenOptions,
  onImportPPTX, onExportPPTX, onExportPDF, onExportImages, onUploadImage, onImageError,
  onOpenVersionHistory,
  remotePeers,
  onSelectionChange: _onSelectionChange,
}) => {
  const setPresentation = useSlideStore((s) => s.setPresentation)
  const presentation = useSlideStore((s) => s.presentation)
  const isDirty = useSlideStore((s) => s.isDirty)
  const markClean = useSlideStore((s) => s.markClean)
  const zoom = useSlideStore((s) => s.zoom)
  const setZoom = useSlideStore((s) => s.setZoom)
  const setPan = useSlideStore((s) => s.setPan)

  const [isShowMode, setIsShowMode] = useState(false)
  const [isLayerPanelOpen, setIsLayerPanelOpen] = useState(true)
  /** Canvas 当前可用尺寸（像素） */
  const [canvasViewport, setCanvasViewport] = useState({ width: 0, height: 0 })

  const { tryPasteClipboardImage, tryPasteClipboardText } = useClipboardPaste({ onUploadImage, onError: onImageError })
  useKeyboard({ tryPasteClipboardImage, tryPasteClipboardText })

  useEffect(() => {
    // 宿主 onChange 回流时，通常会把 store 当前对象原样透传回来。
    // 若重复重灌会导致页面/选择状态被重置，影响编辑连续性。
    if (useSlideStore.getState().presentation === data) return
    setPresentation(data)
    useHistoryStore.getState().clear()
  }, [data, setPresentation])

  useEffect(() => {
    return attachSlideEditorStoreLifecycle()
  }, [])

  useEffect(() => {
    if (isDirty && presentation && onChange) {
      const raf = requestAnimationFrame(() => {
        onChange(presentation)
        markClean()
      })
      return () => cancelAnimationFrame(raf)
    }
    return undefined
  }, [isDirty, presentation, onChange, markClean])

  const handleCanvasViewportResize = useCallback((size: { width: number; height: number }) => {
    const nextWidth = Math.max(0, size.width)
    const nextHeight = Math.max(0, size.height)
    setCanvasViewport((prev) => (
      Math.abs(prev.width - nextWidth) < 0.1 && Math.abs(prev.height - nextHeight) < 0.1
        ? prev
        : { width: nextWidth, height: nextHeight }
    ))
  }, [])

  const handleFitCanvas = useCallback(() => {
    const viewportWidth = canvasViewport.width
    const viewportHeight = canvasViewport.height
    if (viewportWidth <= 0 || viewportHeight <= 0) return

    const canvasWidth = presentation?.canvasWidth || 1280
    const canvasHeight = presentation?.canvasHeight || 720
    setZoom(calculateFitZoom(viewportWidth, viewportHeight, canvasWidth, canvasHeight))
    setPan(0, 0)
  }, [canvasViewport.height, canvasViewport.width, presentation?.canvasHeight, presentation?.canvasWidth, setPan, setZoom])

  const [showStartIndex, setShowStartIndex] = useState(0)
  const handleStartShow = useCallback((fromBeginning?: boolean) => {
    if (fromBeginning) {
      setShowStartIndex(0)
    } else {
      setShowStartIndex(useSlideStore.getState().currentPageIndex)
    }
    setIsShowMode(true)
  }, [])
  const handleEndShow = useCallback(() => setIsShowMode(false), [])

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        fontFamily: t.fontFamily,
        fontSize: 13,
        color: t.textPrimary,
        background: t.bgWorkspace,
        ...style,
      }}
    >
      {/* 顶栏：标题 + 放映 / 导入 / 导出 / 版本历史（对齐 TabVideo EditorHeader） */}
      <PanelErrorBoundary name="topbar">
        <SlideTopBar
          onStartShow={handleStartShow}
          onImportPPTX={onImportPPTX}
          onExportPPTX={onExportPPTX}
          onExportPDF={onExportPDF}
          onExportImages={onExportImages}
          onOpenVersionHistory={onOpenVersionHistory}
        />
      </PanelErrorBoundary>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0, position: 'relative' }}>
        {/* 左侧：画布 + 底部页条；右侧栏上方为编辑面板，下方为可同时显示的图层面板。 */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          <PanelErrorBoundary name="canvas" className="flex-1 min-h-0">
            <Canvas
              onViewportResize={handleCanvasViewportResize}
              showZoomControls={false}
              onUploadImage={onUploadImage}
              onImageError={onImageError}
              remotePeers={remotePeers}
            />
          </PanelErrorBoundary>
          <PanelErrorBoundary name="page-list">
            <PageList />
          </PanelErrorBoundary>
        </div>
        <PanelErrorBoundary name="sidebar">
          <RightSidebar
            zoom={zoom}
            onZoomChange={setZoom}
            onFit={handleFitCanvas}
            onUploadImage={onUploadImage}
            onImageError={onImageError}
            isLayerPanelOpen={isLayerPanelOpen}
            onToggleLayerPanel={() => setIsLayerPanelOpen((open) => !open)}
          />
        </PanelErrorBoundary>
      </div>

      {isShowMode && presentation && (
        <SlideShow
          presentation={presentation}
          startIndex={showStartIndex}
          onEnd={handleEndShow}
          fullscreenOptions={fullscreenOptions}
        />
      )}
    </div>
  )
}

export default SlideEditor
