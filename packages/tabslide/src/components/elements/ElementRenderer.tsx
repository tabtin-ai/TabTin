import React, { useCallback } from 'react'
import type { PPTElement } from '../../types/slides'
import { useSlideStore } from '../../store/slide'
import { shouldAppendSelection } from '../../utils/modifier'
import { buildFlipTransform, ptToPx } from '../../utils/geometry'
import TextElement from './TextElement'
import ImageElement from './ImageElement'
import ShapeElement from './ShapeElement'
import LineElement from './LineElement'
import ChartElement from './ChartElement'
import TableElement from './TableElement'
import LatexElement from './LatexElement'
import {
  CanvasEmbedContent,
  VideoMediaThumbnail,
  VideoMediaContent,
  AudioMediaThumbnail,
  AudioMediaContent,
  ChartThumbnailContent,
  TableThumbnailContent,
} from './element-thumbnails'

interface ElementRendererProps {
  element: PPTElement
  /** 显式 CSS zIndex，确保堆叠顺序与数据层一致 */
  zIndex?: number
  /** 是否为缩略图模式（禁止交互） */
  thumbnail?: boolean
  /** 当前正在编辑的元素 ID */
  editingElementId?: string | null
  /** 开始编辑元素的回调 */
  onStartEdit?: (id: string) => void
}

/**
 * 元素调度器
 *
 * 负责：
 * 1. 根据 element.type 渲染对应组件
 * 2. 处理定位（absolute positioning, rotation, opacity）
 * 3. 处理选择事件
 *
 * 设计决策：
 * - PPTLineElement 没有 height/rotate，需要特殊处理定位
 * - 缩略图模式下禁止所有交互
 */
const ElementRenderer: React.FC<ElementRendererProps> = ({
  element,
  zIndex,
  thumbnail = false,
  editingElementId,
  onStartEdit,
}) => {
  // 精确订阅：只在"当前元素是否被选中"变化时触发重渲染
  const isSelected = useSlideStore((s) => (thumbnail ? false : s.selectedElementIds.includes(element.id)))
  const selectElement = useSlideStore((s) => s.selectElement)
  const setEditing = useSlideStore((s) => s.setEditing)

  const isEditing = editingElementId === element.id

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (thumbnail) return
      if (e.button !== 0) return
      e.stopPropagation()
      selectElement(element.id, shouldAppendSelection(e.nativeEvent))
    },
    [element.id, selectElement, thumbnail],
  )

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (thumbnail) return
      if (element.locked) return
      const canStartEditing = element.type === 'text'
        || element.type === 'table'
        || element.type === 'image'
        || (element.type === 'shape' && !!element.text)
      if (!canStartEditing) return
      e.stopPropagation()
      setEditing(element.id)
    },
    [thumbnail, element, setEditing],
  )

  const handleStartEdit = useCallback(() => {
    if (thumbnail) return
    onStartEdit?.(element.id)
  }, [element.id, onStartEdit, thumbnail])

  // 渲染元素内容
  const renderContent = () => {
    switch (element.type) {
      case 'text':
        return <TextElement element={element} isEditing={isEditing} onStartEdit={handleStartEdit} />
      case 'image':
        return <ImageElement element={element} isEditing={isEditing} />
      case 'shape':
        return <ShapeElement element={element} isSelected={isSelected && !isEditing} isEditing={isEditing} onStartEdit={handleStartEdit} />
      case 'line':
        return <LineElement element={element} />
      case 'chart':
        return thumbnail
          ? <ChartThumbnailContent element={element} />
          : <ChartElement element={element} />
      case 'table':
        return thumbnail
          ? <TableThumbnailContent element={element} />
          : <TableElement element={element} />
      case 'latex':
        return <LatexElement element={element} />
      case 'video':
        return thumbnail
          ? <VideoMediaThumbnail element={element} />
          : <VideoMediaContent element={element} />
      case 'audio':
        return thumbnail
          ? <AudioMediaThumbnail element={element} />
          : <AudioMediaContent element={element} />
      case 'canvas':
        return <CanvasEmbedContent element={element} />
      default:
        return null
    }
  }

  // 线条元素的定位方式不同（height 由 start/end 推导）
  const isLine = element.type === 'line'
  const lineHitPadding = isLine
    ? Math.max(4, ptToPx((element as Extract<PPTElement, { type: 'line' }>).lineWidth || 2) / 2)
    : 0
  const lineHeight = isLine
    ? (() => {
        const line = element as { height?: number; start?: [number, number]; end?: [number, number] }
        if (typeof line.height === 'number' && Number.isFinite(line.height) && line.height > 0) {
          return line.height
        }
        const sy = line.start?.[1] ?? 0
        const ey = line.end?.[1] ?? 0
        return Math.max(1, Math.abs(ey - sy))
      })()
    : undefined

  // 构建 transform：统一在容器上应用翻转+旋转，顺序为 flip → rotate
  // 线条在 group 旋转/翻转后也依赖该容器级 transform 持久化显示。
  const flipPart = buildFlipTransform(element as { flipH?: boolean; flipV?: boolean })
  const rotatePart = 'rotate' in element && (element as { rotate?: number }).rotate
    ? `rotate(${(element as { rotate?: number }).rotate}deg)`
    : ''
  const transformStr = [flipPart, rotatePart].filter(Boolean).join(' ')
  const transform = transformStr || undefined

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    left: element.x,
    top: isLine ? element.y : (element as Exclude<PPTElement, { type: 'line' }>).y,
    width: element.width,
    height: isLine ? lineHeight : (element as Exclude<PPTElement, { type: 'line' }>).height,
    zIndex,
    opacity: element.opacity,
    transform,
    transformOrigin: transform ? 'center center' : undefined,
    cursor: thumbnail ? 'default' : element.locked ? 'not-allowed' : 'move',
    pointerEvents: thumbnail ? 'none' : 'auto',
    // CSS Containment: 让浏览器知道元素布局不影响其他元素，优化重排性能
    contain: 'layout style paint',
  }

  return (
    <div
      data-element-id={element.id}
      style={containerStyle}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {isLine && !thumbnail && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: -lineHitPadding,
            background: 'transparent',
          }}
        />
      )}
      {renderContent()}
    </div>
  )
}

export default React.memo(ElementRenderer)
