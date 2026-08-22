import type { PPTLineElement } from '../types/slides'
import { ptToPx } from './geometry'

type LineGeometryInput = Pick<PPTLineElement, 'start' | 'end'>
  & Partial<Pick<PPTLineElement, 'broken' | 'broken2' | 'curve' | 'cubic' | 'lineWidth'>>

type LineGeometryWithPosition = LineGeometryInput & Pick<PPTLineElement, 'x' | 'y'>

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface LineLocalBounds extends Rect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const DEFAULT_COORD_DECIMALS = 3

const roundCoord = (value: number, decimals = DEFAULT_COORD_DECIMALS): number => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

const getLineStrokeWidthPx = (line: LineGeometryInput): number => {
  const raw = typeof line.lineWidth === 'number' && Number.isFinite(line.lineWidth)
    ? line.lineWidth
    : 2
  return Math.max(0, ptToPx(raw))
}

const shiftLinePoint = (
  point: [number, number],
  offsetX: number,
  offsetY: number,
  decimals: number,
): [number, number] => {
  return [
    roundCoord(point[0] - offsetX, decimals),
    roundCoord(point[1] - offsetY, decimals),
  ]
}

/**
 * 构建线条 SVG path，统一直线/折线/双折线/二次/三次贝塞尔语义。
 */
export function getLinePathD(line: LineGeometryInput): string {
  const [x1, y1] = line.start ?? [0, 0]
  const [x2, y2] = line.end ?? [0, 0]

  if (line.cubic) {
    const [cp1, cp2] = line.cubic
    return `M ${x1} ${y1} C ${cp1[0]} ${cp1[1]}, ${cp2[0]} ${cp2[1]}, ${x2} ${y2}`
  }

  if (line.curve) {
    const [cx, cy] = line.curve
    return `M ${x1} ${y1} Q ${cx} ${cy}, ${x2} ${y2}`
  }

  if (line.broken2) {
    const [bx, by] = line.broken2
    const midX = (x1 + x2) / 2
    return `M ${x1} ${y1} L ${bx} ${by} L ${midX} ${(by + y2) / 2} L ${x2} ${y2}`
  }

  if (line.broken) {
    const [bx, by] = line.broken
    return `M ${x1} ${y1} L ${bx} ${by} L ${x2} ${y2}`
  }

  return `M ${x1} ${y1} L ${x2} ${y2}`
}

/**
 * 计算线条在局部坐标系内的包围盒（包含折点/控制点）。
 */
export function getLineLocalBounds(line: LineGeometryInput): LineLocalBounds {
  const points: Array<[number, number]> = [line.start ?? [0, 0], line.end ?? [0, 0]]

  if (line.broken) points.push(line.broken)

  if (line.broken2) {
    points.push(line.broken2)
    points.push([
      ((line.start?.[0] ?? 0) + (line.end?.[0] ?? 0)) / 2,
      (line.broken2[1] + (line.end?.[1] ?? 0)) / 2,
    ])
  }

  if (line.curve) points.push(line.curve)

  if (line.cubic) {
    points.push(line.cubic[0])
    points.push(line.cubic[1])
  }

  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return {
    minX,
    minY,
    maxX,
    maxY,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

export function getLineLength(line: LineGeometryInput): number {
  const [x1, y1] = line.start ?? [0, 0]
  const [x2, y2] = line.end ?? [0, 0]
  return Math.hypot(x2 - x1, y2 - y1)
}

/**
 * 计算线条在画布绝对坐标系中的包围盒。
 */
export function getLineAbsoluteBounds(line: LineGeometryWithPosition): LineLocalBounds {
  const local = getLineLocalBounds(line)
  const x = line.x + local.minX
  const y = line.y + local.minY
  return {
    ...local,
    x,
    y,
  }
}

/**
 * 线条命中/框选矩形：按最小尺寸居中扩展，避免水平/垂直线难选中。
 */
export function getLineSelectionRect(
  line: LineGeometryWithPosition,
  minVisualSize = 4,
): Rect {
  const bounds = getLineAbsoluteBounds(line)
  const stroke = typeof line.lineWidth === 'number' && Number.isFinite(line.lineWidth)
    ? Math.max(0, line.lineWidth)
    : 0
  const minSize = Math.max(minVisualSize, stroke)
  return inflateRectToMinSize(bounds, minSize, minSize)
}

function inflateRectToMinSize(
  rect: Rect,
  minWidth: number,
  minHeight: number,
): Rect {
  let { x, y, width, height } = rect

  if (width < minWidth) {
    const delta = (minWidth - width) / 2
    x -= delta
    width = minWidth
  }

  if (height < minHeight) {
    const delta = (minHeight - height) / 2
    y -= delta
    height = minHeight
  }

  return { x, y, width, height }
}

interface NormalizeLineGeometryOptions {
  minWidth?: number
  minHeight?: number
  decimals?: number
}

interface BuildLineResizeUpdatesOptions {
  minWidth?: number
  minHeight?: number
  decimals?: number
}

/**
 * 将线条几何归一化到局部坐标原点（minX/minY -> 0,0）。
 *
 * 这样可确保：
 * 1. 控制点在 start/end 外侧时，元素容器仍与真实可见区域一致；
 * 2. Moveable/点击命中/框选体验稳定；
 * 3. x/y 始终表示线条真实包围盒左上角。
 */
export function normalizeLineGeometry(
  line: PPTLineElement,
  options: NormalizeLineGeometryOptions = {},
): PPTLineElement {
  const bounds = getLineLocalBounds(line)
  const decimals = options.decimals ?? DEFAULT_COORD_DECIMALS
  const minWidth = options.minWidth ?? 1
  const minHeight = options.minHeight ?? 1
  const strokeWidth = getLineStrokeWidthPx(line)
  const strokePad = strokeWidth / 2
  const visualMinX = bounds.minX - strokePad
  const visualMinY = bounds.minY - strokePad
  const visualWidth = bounds.width + strokeWidth
  const visualHeight = bounds.height + strokeWidth

  const next: PPTLineElement = {
    ...line,
    x: roundCoord(line.x + visualMinX, decimals),
    y: roundCoord(line.y + visualMinY, decimals),
    width: Math.max(minWidth, roundCoord(visualWidth, decimals)),
    height: Math.max(minHeight, roundCoord(visualHeight, decimals)),
    start: shiftLinePoint(line.start ?? [0, 0], visualMinX, visualMinY, decimals),
    end: shiftLinePoint(line.end ?? [0, 0], visualMinX, visualMinY, decimals),
  }

  if (line.broken) {
    next.broken = shiftLinePoint(line.broken, visualMinX, visualMinY, decimals)
  }
  if (line.broken2) {
    next.broken2 = shiftLinePoint(line.broken2, visualMinX, visualMinY, decimals)
  }
  if (line.curve) {
    next.curve = shiftLinePoint(line.curve, visualMinX, visualMinY, decimals)
  }
  if (line.cubic) {
    next.cubic = [
      shiftLinePoint(line.cubic[0], visualMinX, visualMinY, decimals),
      shiftLinePoint(line.cubic[1], visualMinX, visualMinY, decimals),
    ]
  }

  return next
}

export function buildLineLengthUpdates(
  line: PPTLineElement,
  length: number,
  options: { decimals?: number } = {},
): Partial<PPTLineElement> {
  const decimals = options.decimals ?? DEFAULT_COORD_DECIMALS
  const nextLength = Math.max(0, Number.isFinite(length) ? length : 0)
  const start = line.start ?? [0, 0]
  const end = line.end ?? [0, 0]
  const currentLength = getLineLength(line)

  if (currentLength <= 1e-9) {
    return {
      start,
      end: [roundCoord(start[0] + nextLength, decimals), roundCoord(start[1], decimals)],
    }
  }

  const scale = nextLength / currentLength
  const scalePoint = (point: [number, number]): [number, number] => [
    roundCoord(start[0] + (point[0] - start[0]) * scale, decimals),
    roundCoord(start[1] + (point[1] - start[1]) * scale, decimals),
  ]

  const updates: Partial<PPTLineElement> = {
    start,
    end: scalePoint(end),
  }

  if (line.broken) updates.broken = scalePoint(line.broken)
  if (line.broken2) updates.broken2 = scalePoint(line.broken2)
  if (line.curve) updates.curve = scalePoint(line.curve)
  if (line.cubic) {
    updates.cubic = [
      scalePoint(line.cubic[0]),
      scalePoint(line.cubic[1]),
    ]
  }

  return updates
}

/**
 * 根据新的包围盒尺寸缩放线条局部点位。
 *
 * line 的 width/height 是 start/end/控制点推导值，不能像普通元素一样直接写入；
 * 否则下一轮 normalizeLineGeometry() 会把属性面板里的 W/H 覆盖回旧值。
 */
export function buildLineResizeUpdates(
  line: PPTLineElement,
  left: number,
  top: number,
  width: number,
  height: number,
  options: BuildLineResizeUpdatesOptions = {},
): Partial<PPTLineElement> {
  const decimals = options.decimals ?? 2
  const minWidth = options.minWidth ?? 1
  const minHeight = options.minHeight ?? 1
  const bounds = getLineLocalBounds(line)
  const strokeWidth = getLineStrokeWidthPx(line)
  const strokePad = strokeWidth / 2
  const newW = Math.max(width, minWidth)
  const newH = Math.max(height, minHeight)
  const targetCenterW = Math.max(0, newW - strokeWidth)
  const targetCenterH = Math.max(0, newH - strokeWidth)

  const scaleAxis = (
    value: number,
    min: number,
    span: number,
    nextSpan: number,
  ): number => {
    if (Math.abs(span) < 1e-9) {
      return strokePad
    }
    return roundCoord(strokePad + (value - min) * (nextSpan / span), decimals)
  }

  const scalePoint = (
    point: [number, number],
  ): [number, number] => [
    scaleAxis(point[0], bounds.minX, bounds.width, targetCenterW),
    scaleAxis(point[1], bounds.minY, bounds.height, targetCenterH),
  ]

  const updates: Partial<PPTLineElement> = {
    x: left,
    y: top,
    width: newW,
    height: newH,
    start: scalePoint(line.start),
    end: scalePoint(line.end),
  }

  if (line.broken) updates.broken = scalePoint(line.broken)
  if (line.broken2) updates.broken2 = scalePoint(line.broken2)
  if (line.curve) updates.curve = scalePoint(line.curve)
  if (line.cubic) {
    updates.cubic = [
      scalePoint(line.cubic[0]),
      scalePoint(line.cubic[1]),
    ]
  }

  return updates
}
