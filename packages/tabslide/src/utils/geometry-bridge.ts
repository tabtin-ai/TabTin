/**
 * Geometry bridge — Smart Guides, Auto Distribute, Tidy Up, and alignment
 * functions for TabSlide's PPTElement types.
 *
 * All implementations operate on {id, x, y, width, height} rectangles
 * (pure math, no external dependencies).
 */

import type { PPTElement } from '../types/slides'

export interface SimpleRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export interface PositionResult {
  id: string
  x: number
  y: number
}

export interface GuideLineInfo {
  axis: 'x' | 'y'
  position: number
  from: number
  to: number
  type: 'edge' | 'center' | 'spacing'
}

export interface SpacingGuideInfo {
  axis: 'x' | 'y'
  labelPosition: { x: number; y: number }
  distance: number
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export interface SmartGuideResult {
  snapX: number | null
  snapY: number | null
  guides: GuideLineInfo[]
  spacingGuides: SpacingGuideInfo[]
}

// ---------------------------------------------------------------------------
// PPTElement → SimpleRect conversion
// ---------------------------------------------------------------------------

function elementToRect(el: PPTElement): SimpleRect {
  if (el.type === 'line') {
    return {
      id: el.id,
      x: el.x,
      y: el.y,
      width: Math.max(el.width, 1),
      height: Math.max(el.height ?? 1, 1),
    }
  }
  return {
    id: el.id,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
  }
}

// ---------------------------------------------------------------------------
// Smart Guides — internal helpers
// ---------------------------------------------------------------------------

interface RefPoints {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
}

function extractRefPoints(b: SimpleRect): RefPoints {
  return {
    left: b.x,
    centerX: b.x + b.width / 2,
    right: b.x + b.width,
    top: b.y,
    centerY: b.y + b.height / 2,
    bottom: b.y + b.height,
  }
}

type XRefKey = 'left' | 'centerX' | 'right'
type YRefKey = 'top' | 'centerY' | 'bottom'

interface SnapCandidate {
  delta: number
  absDelta: number
  guide: GuideLineInfo
}

function verticalGuideSpan(drag: SimpleRect, sib: SimpleRect): { from: number; to: number } {
  const minTop = Math.min(drag.y, sib.y)
  const maxBot = Math.max(drag.y + drag.height, sib.y + sib.height)
  return { from: minTop, to: maxBot }
}

function horizontalGuideSpan(drag: SimpleRect, sib: SimpleRect): { from: number; to: number } {
  const minLeft = Math.min(drag.x, sib.x)
  const maxRight = Math.max(drag.x + drag.width, sib.x + sib.width)
  return { from: minLeft, to: maxRight }
}

function guideTypeForKey(key: XRefKey | YRefKey): 'edge' | 'center' {
  return key === 'centerX' || key === 'centerY' ? 'center' : 'edge'
}

const X_KEYS: XRefKey[] = ['left', 'centerX', 'right']
const Y_KEYS: YRefKey[] = ['top', 'centerY', 'bottom']

function collectAlignmentSnaps(
  dragging: SimpleRect,
  siblings: SimpleRect[],
  threshold: number,
): { xCandidates: SnapCandidate[]; yCandidates: SnapCandidate[] } {
  const dragRef = extractRefPoints(dragging)
  const xCandidates: SnapCandidate[] = []
  const yCandidates: SnapCandidate[] = []

  for (const sib of siblings) {
    const sibRef = extractRefPoints(sib)

    for (const dk of X_KEYS) {
      for (const sk of X_KEYS) {
        const delta = sibRef[sk] - dragRef[dk]
        const absDelta = Math.abs(delta)
        if (absDelta <= threshold) {
          const snappedPosition = sibRef[sk]
          const span = verticalGuideSpan(
            { ...dragging, x: dragging.x + delta },
            sib,
          )
          xCandidates.push({
            delta,
            absDelta,
            guide: {
              axis: 'x',
              position: snappedPosition,
              from: span.from,
              to: span.to,
              type: guideTypeForKey(dk) === 'center' || guideTypeForKey(sk) === 'center' ? 'center' : 'edge',
            },
          })
        }
      }
    }

    for (const dk of Y_KEYS) {
      for (const sk of Y_KEYS) {
        const delta = sibRef[sk] - dragRef[dk]
        const absDelta = Math.abs(delta)
        if (absDelta <= threshold) {
          const snappedPosition = sibRef[sk]
          const span = horizontalGuideSpan(
            { ...dragging, y: dragging.y + delta },
            sib,
          )
          yCandidates.push({
            delta,
            absDelta,
            guide: {
              axis: 'y',
              position: snappedPosition,
              from: span.from,
              to: span.to,
              type: guideTypeForKey(dk) === 'center' || guideTypeForKey(sk) === 'center' ? 'center' : 'edge',
            },
          })
        }
      }
    }
  }

  return { xCandidates, yCandidates }
}

// ---------------------------------------------------------------------------
// Smart Guides — spacing detection
// ---------------------------------------------------------------------------

interface GapInfo {
  axis: 'x' | 'y'
  gap: number
  a: SimpleRect
  b: SimpleRect
}

function findSiblingGaps(siblings: SimpleRect[]): GapInfo[] {
  const gaps: GapInfo[] = []
  if (siblings.length < 2) return gaps

  const byX = [...siblings].sort((a, b) => a.x - b.x)
  for (let i = 0; i < byX.length; i++) {
    for (let j = i + 1; j < byX.length; j++) {
      const a = byX[i]
      const b = byX[j]
      const gap = b.x - (a.x + a.width)
      if (gap > 0) {
        gaps.push({ axis: 'x', gap, a, b })
      }
    }
  }

  const byY = [...siblings].sort((a, b) => a.y - b.y)
  for (let i = 0; i < byY.length; i++) {
    for (let j = i + 1; j < byY.length; j++) {
      const a = byY[i]
      const b = byY[j]
      const gap = b.y - (a.y + a.height)
      if (gap > 0) {
        gaps.push({ axis: 'y', gap, a, b })
      }
    }
  }

  return gaps
}

function collectSpacingGuides(
  dragging: SimpleRect,
  siblings: SimpleRect[],
  threshold: number,
  bestDeltaX: number,
  bestDeltaY: number,
): { spacingGuides: SpacingGuideInfo[]; guides: GuideLineInfo[] } {
  const spacingGuides: SpacingGuideInfo[] = []
  const guides: GuideLineInfo[] = []
  const siblingGaps = findSiblingGaps(siblings)

  const snappedDrag: SimpleRect = {
    ...dragging,
    x: dragging.x + bestDeltaX,
    y: dragging.y + bestDeltaY,
  }
  const dragRight = snappedDrag.x + snappedDrag.width
  const dragBottom = snappedDrag.y + snappedDrag.height

  for (const sib of siblings) {
    const sibRight = sib.x + sib.width
    const sibBottom = sib.y + sib.height

    const xGaps = [
      { gap: snappedDrag.x - sibRight, side: 'left' as const },
      { gap: sib.x - dragRight, side: 'right' as const },
    ]

    for (const { gap: dragGap, side } of xGaps) {
      if (dragGap <= 0) continue
      for (const sg of siblingGaps) {
        if (sg.axis !== 'x') continue
        if (Math.abs(dragGap - sg.gap) <= threshold) {
          const midY = Math.max(snappedDrag.y, sib.y) +
            (Math.min(snappedDrag.y + snappedDrag.height, sib.y + sib.height) -
              Math.max(snappedDrag.y, sib.y)) / 2

          const fromX = side === 'left' ? sibRight : dragRight
          const toX = side === 'left' ? snappedDrag.x : sib.x

          spacingGuides.push({
            axis: 'x',
            distance: dragGap,
            labelPosition: { x: (fromX + toX) / 2, y: midY },
            from: { x: fromX, y: midY },
            to: { x: toX, y: midY },
          })

          const refFromX = sg.a.x + sg.a.width
          const refToX = sg.b.x
          const refMidY =
            (Math.max(sg.a.y, sg.b.y) +
              Math.min(sg.a.y + sg.a.height, sg.b.y + sg.b.height)) / 2

          spacingGuides.push({
            axis: 'x',
            distance: sg.gap,
            labelPosition: { x: (refFromX + refToX) / 2, y: refMidY },
            from: { x: refFromX, y: refMidY },
            to: { x: refToX, y: refMidY },
          })
        }
      }
    }

    const yGaps = [
      { gap: snappedDrag.y - sibBottom, side: 'top' as const },
      { gap: sib.y - dragBottom, side: 'bottom' as const },
    ]

    for (const { gap: dragGap, side } of yGaps) {
      if (dragGap <= 0) continue
      for (const sg of siblingGaps) {
        if (sg.axis !== 'y') continue
        if (Math.abs(dragGap - sg.gap) <= threshold) {
          const midX = Math.max(snappedDrag.x, sib.x) +
            (Math.min(snappedDrag.x + snappedDrag.width, sib.x + sib.width) -
              Math.max(snappedDrag.x, sib.x)) / 2

          const fromY = side === 'top' ? sibBottom : dragBottom
          const toY = side === 'top' ? snappedDrag.y : sib.y

          spacingGuides.push({
            axis: 'y',
            distance: dragGap,
            labelPosition: { x: midX, y: (fromY + toY) / 2 },
            from: { x: midX, y: fromY },
            to: { x: midX, y: toY },
          })

          const refFromY = sg.a.y + sg.a.height
          const refToY = sg.b.y
          const refMidX =
            (Math.max(sg.a.x, sg.b.x) +
              Math.min(sg.a.x + sg.a.width, sg.b.x + sg.b.width)) / 2

          spacingGuides.push({
            axis: 'y',
            distance: sg.gap,
            labelPosition: { x: refMidX, y: (refFromY + refToY) / 2 },
            from: { x: refMidX, y: refFromY },
            to: { x: refMidX, y: refToY },
          })
        }
      }
    }
  }

  return { spacingGuides, guides }
}

function mergeGuides(guides: GuideLineInfo[]): void {
  for (let i = 0; i < guides.length; i++) {
    for (let j = i + 1; j < guides.length; j++) {
      const a = guides[i]
      const b = guides[j]
      if (a.axis === b.axis && a.position === b.position && a.type === b.type) {
        a.from = Math.min(a.from, b.from)
        a.to = Math.max(a.to, b.to)
        guides.splice(j, 1)
        j--
      }
    }
  }
}

function _computeSmartGuides(
  dragging: SimpleRect,
  siblings: SimpleRect[],
  options?: { snapThreshold?: number; enableSpacing?: boolean },
): SmartGuideResult {
  const threshold = options?.snapThreshold ?? 4
  const enableSpacing = options?.enableSpacing ?? true

  const filteredSiblings = dragging.id
    ? siblings.filter((s) => s.id !== dragging.id)
    : siblings

  if (filteredSiblings.length === 0) {
    return { snapX: null, snapY: null, guides: [], spacingGuides: [] }
  }

  const { xCandidates, yCandidates } = collectAlignmentSnaps(dragging, filteredSiblings, threshold)

  let bestX: SnapCandidate | null = null
  for (const c of xCandidates) {
    if (!bestX || c.absDelta < bestX.absDelta) bestX = c
  }

  let bestY: SnapCandidate | null = null
  for (const c of yCandidates) {
    if (!bestY || c.absDelta < bestY.absDelta) bestY = c
  }

  const bestDeltaX = bestX?.delta ?? 0
  const bestDeltaY = bestY?.delta ?? 0

  const guides: GuideLineInfo[] = []

  if (bestX) {
    for (const c of xCandidates) {
      if (c.delta === bestX.delta) {
        guides.push(c.guide)
      }
    }
  }

  if (bestY) {
    for (const c of yCandidates) {
      if (c.delta === bestY.delta) {
        guides.push(c.guide)
      }
    }
  }

  mergeGuides(guides)

  let spacingGuides: SpacingGuideInfo[] = []
  if (enableSpacing) {
    const spacing = collectSpacingGuides(dragging, filteredSiblings, threshold, bestDeltaX, bestDeltaY)
    spacingGuides = spacing.spacingGuides
    for (const g of spacing.guides) guides.push(g)
  }

  return {
    snapX: bestX ? dragging.x + bestX.delta : null,
    snapY: bestY ? dragging.y + bestY.delta : null,
    guides,
    spacingGuides,
  }
}

// ---------------------------------------------------------------------------
// Distribute / Align / TidyUp — internal implementations
// ---------------------------------------------------------------------------

function _distributeHorizontally(shapes: SimpleRect[]): PositionResult[] {
  if (shapes.length < 3) return []

  const sorted = [...shapes].sort((a, b) => a.x - b.x)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  const totalSpace = last.x + last.width - first.x
  const totalShapeWidth = sorted.reduce((sum, s) => sum + s.width, 0)
  const gap = (totalSpace - totalShapeWidth) / (sorted.length - 1)

  const results: PositionResult[] = []
  let cursor = first.x + first.width + gap

  for (let i = 1; i < sorted.length - 1; i++) {
    const s = sorted[i]
    results.push({ id: s.id, x: cursor, y: s.y })
    cursor += s.width + gap
  }

  return results
}

function _distributeVertically(shapes: SimpleRect[]): PositionResult[] {
  if (shapes.length < 3) return []

  const sorted = [...shapes].sort((a, b) => a.y - b.y)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  const totalSpace = last.y + last.height - first.y
  const totalShapeHeight = sorted.reduce((sum, s) => sum + s.height, 0)
  const gap = (totalSpace - totalShapeHeight) / (sorted.length - 1)

  const results: PositionResult[] = []
  let cursor = first.y + first.height + gap

  for (let i = 1; i < sorted.length - 1; i++) {
    const s = sorted[i]
    results.push({ id: s.id, x: s.x, y: cursor })
    cursor += s.height + gap
  }

  return results
}

type AlignMode = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom'

function _alignShapes(shapes: SimpleRect[], mode: AlignMode): PositionResult[] {
  if (shapes.length === 0) return []

  switch (mode) {
    case 'left': {
      const target = Math.min(...shapes.map((s) => s.x))
      return shapes.map((s) => ({ id: s.id, x: target, y: s.y }))
    }
    case 'center-h': {
      const minX = Math.min(...shapes.map((s) => s.x))
      const maxX = Math.max(...shapes.map((s) => s.x + s.width))
      const center = (minX + maxX) / 2
      return shapes.map((s) => ({ id: s.id, x: center - s.width / 2, y: s.y }))
    }
    case 'right': {
      const target = Math.max(...shapes.map((s) => s.x + s.width))
      return shapes.map((s) => ({ id: s.id, x: target - s.width, y: s.y }))
    }
    case 'top': {
      const target = Math.min(...shapes.map((s) => s.y))
      return shapes.map((s) => ({ id: s.id, x: s.x, y: target }))
    }
    case 'center-v': {
      const minY = Math.min(...shapes.map((s) => s.y))
      const maxY = Math.max(...shapes.map((s) => s.y + s.height))
      const center = (minY + maxY) / 2
      return shapes.map((s) => ({ id: s.id, x: s.x, y: center - s.height / 2 }))
    }
    case 'bottom': {
      const target = Math.max(...shapes.map((s) => s.y + s.height))
      return shapes.map((s) => ({ id: s.id, x: s.x, y: target - s.height }))
    }
  }
}

function groupIntoRows(shapes: SimpleRect[]): SimpleRect[][] {
  const sorted = [...shapes].sort((a, b) => a.y - b.y)
  const rows: SimpleRect[][] = []
  let currentRow: SimpleRect[] = [sorted[0]]
  let rowBottom = sorted[0].y + sorted[0].height

  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]
    if (s.y < rowBottom) {
      currentRow.push(s)
      rowBottom = Math.max(rowBottom, s.y + s.height)
    } else {
      rows.push(currentRow)
      currentRow = [s]
      rowBottom = s.y + s.height
    }
  }
  rows.push(currentRow)

  return rows
}

function detectCommonGap(shapes: SimpleRect[], axis: 'x' | 'y'): number {
  const DEFAULT_GAP = 20
  if (shapes.length < 2) return DEFAULT_GAP

  const sorted = [...shapes].sort((a, b) =>
    axis === 'x' ? a.x - b.x : a.y - b.y,
  )

  const gaps: number[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]
    const next = sorted[i + 1]
    const gap =
      axis === 'x'
        ? next.x - (current.x + current.width)
        : next.y - (current.y + current.height)
    if (gap >= 0) gaps.push(Math.round(gap))
  }

  if (gaps.length === 0) return DEFAULT_GAP

  const freq = new Map<number, number>()
  for (const g of gaps) {
    freq.set(g, (freq.get(g) ?? 0) + 1)
  }

  let bestGap = DEFAULT_GAP
  let bestCount = 0
  for (const [g, count] of freq) {
    if (count > bestCount) {
      bestCount = count
      bestGap = g
    }
  }

  return bestGap
}

function _tidyUp(
  shapes: SimpleRect[],
  options?: { gapX?: number; gapY?: number },
): PositionResult[] {
  if (shapes.length === 0) return []

  const rows = groupIntoRows(shapes)

  const gapX = options?.gapX ?? detectCommonGap(shapes, 'x')
  const gapY = options?.gapY ?? detectCommonGap(shapes, 'y')

  rows.sort((a, b) => Math.min(...a.map(s => s.y)) - Math.min(...b.map(s => s.y)))

  const results = new Map<string, PositionResult>()
  let cursorY = Math.min(...rows[0].map(s => s.y))

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const rowHeight = Math.max(...row.map((s) => s.height))

    let cursorX = row[0].x
    for (const s of row) {
      results.set(s.id, { id: s.id, x: cursorX, y: cursorY })
      cursorX += s.width + gapX
    }

    cursorY += rowHeight + gapY
  }

  return Array.from(results.values())
}

// ---------------------------------------------------------------------------
// Public API (async for backward compatibility)
// ---------------------------------------------------------------------------

export async function computeSmartGuides(
  dragging: PPTElement,
  references: PPTElement[],
  threshold?: number,
): Promise<SmartGuideResult> {
  const dragBounds = elementToRect(dragging)
  const refBounds = references
    .filter(el => el.id !== dragging.id)
    .map(elementToRect)
  return _computeSmartGuides(dragBounds, refBounds, { snapThreshold: threshold })
}

export async function autoDistributeHorizontal(
  elements: PPTElement[],
): Promise<PositionResult[]> {
  return _distributeHorizontally(elements.map(elementToRect))
}

export async function autoDistributeVertical(
  elements: PPTElement[],
): Promise<PositionResult[]> {
  return _distributeVertically(elements.map(elementToRect))
}

export async function alignShapesViaEngine(
  elements: PPTElement[],
  alignment: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom',
): Promise<PositionResult[]> {
  return _alignShapes(elements.map(elementToRect), alignment)
}

export async function tidyUp(
  elements: PPTElement[],
  options?: { gapX?: number; gapY?: number },
): Promise<PositionResult[]> {
  return _tidyUp(elements.map(elementToRect), options)
}
