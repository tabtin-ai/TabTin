import React, { useMemo } from 'react'
import type { LinePoint, PPTLineElement } from '../../types/slides'
import { buildDropShadowFilter, ptToPx } from '../../utils/geometry'
import * as t from '../../theme'
import { getLinePathD } from '../../utils/line-geometry'

interface LineElementProps {
  element: PPTLineElement
}

/**
 * 线条元素
 *
 * 支持 PPTist 的四种线型：
 * - 直线（默认）
 * - 折线（broken）
 * - 双折线（broken2）
 * - 二次贝塞尔曲线（curve）
 * - 三次贝塞尔曲线（cubic）
 */
const LineElement: React.FC<LineElementProps> = ({ element }) => {
  const [x1, y1] = element.start ?? [0, 0]
  const [x2, y2] = element.end ?? [0, 0]

  const strokeColor = element.color || t.textPrimary
  // lineWidth 数据层按 pt 存储（与 OOXML / python-pptx 一致），SVG 需要 px
  const strokeWidth = ptToPx(element.lineWidth || 2)

  // dash/dot 模式随线宽缩放（与 PowerPoint 行为一致）
  const dashArray = useMemo(() => {
    if (element.style === 'dashed') {
      const dash = Math.max(4, strokeWidth * 3)
      const gap = Math.max(2, strokeWidth * 1.5)
      return `${dash} ${gap}`
    }
    if (element.style === 'dotted') {
      // 圆点模式：dot 长度 ≈ 0（linecap 撑出圆形），间距按线宽缩放
      const gap = Math.max(2, strokeWidth * 2)
      return `0.01 ${gap}`
    }
    if (element.style === 'dashDot') {
      const dash = Math.max(4, strokeWidth * 3)
      const dot = 0.01
      const gap = Math.max(2, strokeWidth * 1.5)
      return `${dash} ${gap} ${dot} ${gap}`
    }
    if (element.style === 'longDash') {
      const dash = Math.max(8, strokeWidth * 6)
      const gap = Math.max(2, strokeWidth * 1.5)
      return `${dash} ${gap}`
    }
    if (element.style === 'longDashDot') {
      const dash = Math.max(8, strokeWidth * 6)
      const dot = 0.01
      const gap = Math.max(2, strokeWidth * 1.5)
      return `${dash} ${gap} ${dot} ${gap}`
    }
    return undefined
  }, [element.style, strokeWidth])

  const linecap = element.lineCap || (
    (element.style === 'dotted' || element.style === 'dashDot' || element.style === 'longDashDot') ? 'round' : undefined
  )
  const linejoin = element.lineJoin || undefined

  const markerId = `line-marker-end-${element.id}`
  const markerStartId = `line-marker-start-${element.id}`
  const [startPoint, endPoint] = element.points || ['', '']
  const [startPS, endPS] = element.pointSizes || [undefined, undefined]
  const endScale = getPointSizeScale(endPS)
  const startScale = getPointSizeScale(startPS)

  // 计算 SVG 路径
  const pathD = useMemo(
    () => getLinePathD(element),
    [x1, y1, x2, y2, element.broken, element.broken2, element.curve, element.cubic],
  )

  // 阴影
  const shadowFilter = element.shadow
    ? buildDropShadowFilter(element.shadow)
    : undefined

  // 箭头使用 markerUnits="strokeWidth" 让 marker 随线宽自动缩放
  return (
    <svg width="100%" height="100%" style={{ overflow: 'visible', filter: shadowFilter }}>
      <defs>
        {endPoint !== '' && (
          <marker
            id={markerId}
            markerWidth={getMarkerConfig(endPoint, endScale).width}
            markerHeight={getMarkerConfig(endPoint, endScale).height}
            refX={getMarkerConfig(endPoint, endScale).refX}
            refY={getMarkerConfig(endPoint, endScale).refY}
            orient="auto"
            markerUnits="strokeWidth"
            overflow="visible"
          >
            {renderMarkerBody(endPoint, strokeColor, false)}
          </marker>
        )}
        {startPoint !== '' && (
          <marker
            id={markerStartId}
            markerWidth={getMarkerConfig(startPoint, startScale).width}
            markerHeight={getMarkerConfig(startPoint, startScale).height}
            refX={getMarkerConfig(startPoint, startScale).startRefX}
            refY={getMarkerConfig(startPoint, startScale).refY}
            orient="auto"
            markerUnits="strokeWidth"
            overflow="visible"
          >
            {renderMarkerBody(startPoint, strokeColor, true)}
          </marker>
        )}
      </defs>
      <path
        d={pathD}
        fill="none"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={dashArray}
        strokeLinecap={linecap}
        strokeLinejoin={linejoin}
        markerEnd={endPoint !== '' ? `url(#${markerId})` : undefined}
        markerStart={startPoint !== '' ? `url(#${markerStartId})` : undefined}
      />
    </svg>
  )
}

const POINT_SIZE_SCALE: Record<string, number> = { sm: 0.7, med: 1, lg: 1.4 }

function getPointSizeScale(ps: { w?: string; len?: string } | undefined): number {
  if (!ps) return 1
  const ws = POINT_SIZE_SCALE[ps.w ?? 'med'] ?? 1
  const ls = POINT_SIZE_SCALE[ps.len ?? 'med'] ?? 1
  return Math.max(ws, ls)
}

function getMarkerConfig(point: LinePoint, scale = 1) {
  const s = scale
  if (point === 'dot') {
    return { width: 4 * s, height: 4 * s, refX: 3 * s, startRefX: 1 * s, refY: 2 * s }
  }
  if (point === 'diamond') {
    return { width: 5 * s, height: 5 * s, refX: 5 * s, startRefX: 0, refY: 2.5 * s }
  }
  if (point === 'stealth') {
    return { width: 5 * s, height: 4 * s, refX: 5 * s, startRefX: 0, refY: 2 * s }
  }
  if (point === 'triangle') {
    return { width: 5 * s, height: 4 * s, refX: 5 * s, startRefX: 0, refY: 2 * s }
  }
  return { width: 5 * s, height: 4 * s, refX: 5 * s, startRefX: 0, refY: 2 * s }
}

function renderMarkerBody(point: LinePoint, color: string, start: boolean) {
  if (point === 'dot') {
    return <circle cx="2" cy="2" r="1.5" fill={color} />
  }
  if (point === 'diamond') {
    return start
      ? <polygon points="5 2.5,2.5 0,0 2.5,2.5 5" fill={color} />
      : <polygon points="0 2.5,2.5 0,5 2.5,2.5 5" fill={color} />
  }
  if (point === 'stealth') {
    return start
      ? <polygon points="5 0,1.25 2,5 4,3.25 2" fill={color} />
      : <polygon points="0 0,3.75 2,0 4,1.75 2" fill={color} />
  }
  if (point === 'triangle') {
    return start
      ? <polygon points="5 0,0 2,5 4" fill={color} />
      : <polygon points="0 0,5 2,0 4" fill={color} />
  }
  // default: arrow — open V-shape (no fill), matching OOXML arrow style
  return start
    ? <polyline points="5,0 0,2 5,4" fill="none" stroke={color} strokeWidth="0.7" strokeLinejoin="round" />
    : <polyline points="0,0 5,2 0,4" fill="none" stroke={color} strokeWidth="0.7" strokeLinejoin="round" />
}

export default React.memo(LineElement)
