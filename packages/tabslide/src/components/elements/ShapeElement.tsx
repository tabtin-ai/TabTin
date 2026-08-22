import React, { useMemo } from 'react'
import type { PPTShapeElement, Gradient } from '../../types/slides'
import { getShapePath, ShapePathFormulas } from '../../configs/shapes'
import { buildDropShadowFilter } from '../../utils/geometry'
import { sanitizeHtml } from '../../utils/sanitize'
import * as t from '../../theme'
import ShapeTextEditor from './ShapeTextEditor'
import { KeypointHandles } from './ShapeKeypointHandles'

interface ShapeElementProps {
  element: PPTShapeElement
  isSelected?: boolean
  isEditing?: boolean
  onStartEdit?: () => void
}

/** 生成 SVG 渐变定义 */
const GradientDef: React.FC<{ id: string; gradient: Gradient }> = ({ id, gradient }) => {
  if (gradient.type === 'linear') {
    return (
      <linearGradient id={id} gradientTransform={`rotate(${gradient.rotate}, 0.5, 0.5)`}>
        {gradient.colors.map((stop, i) => (
          <stop key={i} offset={`${stop.pos * 100}%`} stopColor={stop.color} />
        ))}
      </linearGradient>
    )
  }
  return (
    <radialGradient
      id={id}
      cx={gradient.center?.x ?? 0.5}
      cy={gradient.center?.y ?? 0.5}
      r={0.5}
      fx={gradient.center?.x ?? 0.5}
      fy={gradient.center?.y ?? 0.5}
      gradientUnits="objectBoundingBox"
    >
      {gradient.colors.map((stop, i) => (
        <stop key={i} offset={`${stop.pos * 100}%`} stopColor={stop.color} />
      ))}
    </radialGradient>
  )
}

/**
 * 形状元素
 *
 * 核心特性：
 * - pathFormula 动态路径
 * - 选中时显示黄色菱形 keypoint 控制点（可拖拽调节圆角/箭头宽度等）
 * - 双击编辑形状内文字
 */
const ShapeElement: React.FC<ShapeElementProps> = ({ element, isSelected, isEditing, onStartEdit }) => {
  const gradientId = `grad-${element.id}`
  const clipPathId = `clip-${element.id}`

  // 动态计算 path
  const actualPath = useMemo(
    () =>
      getShapePath(
        element.pathFormula,
        element.path,
        element.width,
        element.height,
        element.keypoints,
      ),
    [element.pathFormula, element.path, element.width, element.height, element.keypoints],
  )

  // 有 pathFormula 时，viewBox = 实际尺寸（path 已按尺寸计算）
  // 无 pathFormula 时，用预设 viewBox（path 会被 viewBox 缩放）
  const viewBox = element.pathFormula
    ? `0 0 ${element.width} ${element.height}`
    : `0 0 ${element.viewBox?.[0] ?? element.width} ${element.viewBox?.[1] ?? element.height}`

  // 与后端写回策略保持一致：pattern > gradient > solid/none
  const fill = element.pattern
    ? `url(#pat-${element.id})`
    : element.gradient
      ? `url(#${gradientId})`
      : element.fill === 'transparent' || element.fill === 'none'
        ? 'transparent'
        : element.fill || t.accent


  const outlineProps = (() => {
    if (!element.outline) return {}
    const w = element.outline.width || 1
    let dasharray: string | undefined
    switch (element.outline.style) {
      case 'dashed':
        dasharray = `${Math.max(4, w * 3)} ${Math.max(2, w * 1.5)}`; break
      case 'dotted':
        dasharray = `${w} ${Math.max(2, w * 2)}`; break
      case 'dashDot':
        dasharray = `${Math.max(4, w * 3)} ${Math.max(2, w * 1.5)} ${w} ${Math.max(2, w * 1.5)}`; break
      case 'longDash':
        dasharray = `${Math.max(8, w * 6)} ${Math.max(2, w * 1.5)}`; break
      case 'longDashDot':
        dasharray = `${Math.max(8, w * 6)} ${Math.max(2, w * 1.5)} ${w} ${Math.max(2, w * 1.5)}`; break
    }
    const needsRoundCap = !element.outline.lineCap && (
      element.outline.style === 'dotted' || element.outline.style === 'dashDot' || element.outline.style === 'longDashDot'
    )
    return {
      stroke: element.outline.color,
      strokeWidth: w,
      strokeDasharray: dasharray,
      strokeLinecap: element.outline.lineCap || (needsRoundCap ? 'round' : undefined),
      strokeLinejoin: element.outline.lineJoin || undefined,
    }
  })()

  const shadowFilter = element.shadow
    ? buildDropShadowFilter(element.shadow)
    : undefined

  // 翻转已由 ElementRenderer 容器统一处理

  // 是否有可编辑的控制点
  const formula = element.pathFormula ? ShapePathFormulas[element.pathFormula] : undefined
  const showHandles = isSelected && formula?.editable && element.keypoints && element.keypoints.length > 0

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        width="100%"
        height="100%"
        viewBox={viewBox}
        preserveAspectRatio="none"
        style={{ filter: shadowFilter, overflow: 'visible' }}
      >
        <defs>
          <clipPath id={clipPathId}>
            <path d={actualPath} />
          </clipPath>
          {element.gradient && <GradientDef id={gradientId} gradient={element.gradient} />}
          {element.pattern && (
            <pattern
              id={`pat-${element.id}`}
              patternUnits="objectBoundingBox"
              patternContentUnits="objectBoundingBox"
              width="1"
              height="1"
            >
              <image href={element.pattern} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
            </pattern>
          )}
        </defs>
        <path d={actualPath} fill={fill} {...outlineProps} />
        {/* 非编辑态：静态渲染形状内文字 */}
        {element.text && !isEditing && (
          <foreignObject x="0" y="0" width="100%" height="100%" clipPath={`url(#${clipPathId})`}>
            <div
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: element.text.align === 'right' ? 'flex-end' : element.text.align === 'center' ? 'center' : 'flex-start',
                justifyContent: element.text.verticalAlign === 'bottom' ? 'flex-end' : element.text.verticalAlign === 'middle' ? 'center' : 'flex-start',
                fontSize: element.text.defaultFontSize || 18,
                color: element.text.defaultColor || t.textPrimary,
                fontFamily: element.text.defaultFontName || 'inherit',
                textAlign: element.text.align || 'left',
                padding: '8px',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                onStartEdit?.()
              }}
            >
              <style>{`.tabslide-shape-text-${element.id} p { margin: 0; }`}</style>
              <div
                className={`tabslide-shape-text-${element.id}`}
                style={{ width: '100%' }}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(element.text.content || '') }}
              />
            </div>
          </foreignObject>
        )}
      </svg>

      {/* 编辑态：HTML overlay 编辑器（在 SVG 之上，避免 foreignObject 内 contentEditable 兼容问题） */}
      {element.text && isEditing && (
        <ShapeTextEditor element={element} text={element.text} clipPathId={clipPathId} />
      )}

      {/* 黄色菱形控制点 */}
      {showHandles && formula && element.keypoints && (
        <KeypointHandles
          element={element}
          formula={formula}
          keypoints={element.keypoints}
        />
      )}
    </div>
  )
}

export default React.memo(ShapeElement)
