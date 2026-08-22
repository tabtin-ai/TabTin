import { SHELL_TOP_BAR_HEIGHT } from '@shared/shell-top-bar-layout'

export type CapsulePlacement = {
  side: 'left' | 'right'
  yRatio: number
}

export type CapsulePoint = {
  x: number
  y: number
}

export type CapsuleSize = {
  width: number
  height: number
}

export type CapsuleRect = CapsulePoint & CapsuleSize

export type CapsulePositionBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export type CapsuleDockTarget = {
  placement: CapsulePlacement
  position: CapsulePoint
}

export type OverlayGeometry = CapsuleRect & {
  /** 相对 overlay 左上角的动画原点。 */
  transformOrigin: CapsulePoint
  /** 可直接传给 React style.transformOrigin。 */
  transformOriginCss: string
}

export const DEFAULT_CAPSULE_PLACEMENT: CapsulePlacement = {
  side: 'right',
  yRatio: 1,
}

export const DEFAULT_CAPSULE_SAFE_MARGIN = 20
export const DEFAULT_VELOCITY_PROJECTION_SECONDS = 0.18

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback

const nonNegative = (value: number): number => Math.max(0, finiteOr(value, 0))

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, finiteOr(value, min)))

function normalizeSize(size: CapsuleSize): CapsuleSize {
  return {
    width: nonNegative(size.width),
    height: nonNegative(size.height),
  }
}

function resolveAxisBounds({
  viewportLength,
  itemLength,
  preferredStartInset,
  preferredEndInset,
  hardStartInset = 0,
}: {
  viewportLength: number
  itemLength: number
  preferredStartInset: number
  preferredEndInset: number
  hardStartInset?: number
}): { min: number; max: number } {
  const viewport = nonNegative(viewportLength)
  const item = nonNegative(itemLength)
  const hardMax = Math.max(0, viewport - item)
  const preferredMin = nonNegative(preferredStartInset)
  const preferredMax = viewport - nonNegative(preferredEndInset) - item

  if (preferredMin <= preferredMax) {
    return {
      min: clamp(preferredMin, 0, hardMax),
      max: clamp(preferredMax, 0, hardMax),
    }
  }

  // 小窗口先放宽视觉安全边距；顶栏只在胶囊确实能完整放到其下方时保留。
  const hardMin = hardMax >= hardStartInset ? nonNegative(hardStartInset) : 0
  return {
    min: clamp(hardMin, 0, hardMax),
    max: hardMax,
  }
}

export function normalizeCapsulePlacement(value: unknown): CapsulePlacement {
  if (!value || typeof value !== 'object')
    return { ...DEFAULT_CAPSULE_PLACEMENT }

  const candidate = value as Partial<CapsulePlacement>
  const side =
    candidate.side === 'left' || candidate.side === 'right'
      ? candidate.side
      : DEFAULT_CAPSULE_PLACEMENT.side
  const yRatio =
    typeof candidate.yRatio === 'number' && Number.isFinite(candidate.yRatio)
      ? clamp(candidate.yRatio, 0, 1)
      : DEFAULT_CAPSULE_PLACEMENT.yRatio

  return { side, yRatio }
}

export function resolveCapsulePositionBounds(
  viewport: CapsuleSize,
  capsuleSize: CapsuleSize,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
): CapsulePositionBounds {
  const normalizedViewport = normalizeSize(viewport)
  const normalizedCapsule = normalizeSize(capsuleSize)
  const margin = nonNegative(safeMargin)
  const horizontal = resolveAxisBounds({
    viewportLength: normalizedViewport.width,
    itemLength: normalizedCapsule.width,
    preferredStartInset: margin,
    preferredEndInset: margin,
  })
  const vertical = resolveAxisBounds({
    viewportLength: normalizedViewport.height,
    itemLength: normalizedCapsule.height,
    preferredStartInset: SHELL_TOP_BAR_HEIGHT + margin,
    preferredEndInset: margin,
    hardStartInset: SHELL_TOP_BAR_HEIGHT,
  })

  return {
    minX: horizontal.min,
    maxX: horizontal.max,
    minY: vertical.min,
    maxY: vertical.max,
  }
}

export function clampCapsulePosition(
  position: CapsulePoint,
  viewport: CapsuleSize,
  capsuleSize: CapsuleSize,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
): CapsulePoint {
  const bounds = resolveCapsulePositionBounds(viewport, capsuleSize, safeMargin)
  return {
    x: clamp(position.x, bounds.minX, bounds.maxX),
    y: clamp(position.y, bounds.minY, bounds.maxY),
  }
}

export function resolveCapsulePosition(
  placementValue: unknown,
  viewport: CapsuleSize,
  capsuleSize: CapsuleSize,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
): CapsulePoint {
  const placement = normalizeCapsulePlacement(placementValue)
  const bounds = resolveCapsulePositionBounds(viewport, capsuleSize, safeMargin)
  return {
    x: placement.side === 'left' ? bounds.minX : bounds.maxX,
    y: bounds.minY + (bounds.maxY - bounds.minY) * placement.yRatio,
  }
}

export function capsulePositionToPlacement(
  position: CapsulePoint,
  viewport: CapsuleSize,
  capsuleSize: CapsuleSize,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
): CapsulePlacement {
  const bounds = resolveCapsulePositionBounds(viewport, capsuleSize, safeMargin)
  const clamped = clampCapsulePosition(
    position,
    viewport,
    capsuleSize,
    safeMargin,
  )
  const horizontalMidpoint = (bounds.minX + bounds.maxX) / 2
  const verticalRange = bounds.maxY - bounds.minY

  return {
    side: clamped.x < horizontalMidpoint ? 'left' : 'right',
    yRatio: verticalRange > 0 ? (clamped.y - bounds.minY) / verticalRange : 1,
  }
}

export function resolveCapsuleDockTarget({
  position,
  velocity,
  viewport,
  capsuleSize,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
  projectionSeconds = DEFAULT_VELOCITY_PROJECTION_SECONDS,
}: {
  position: CapsulePoint
  /** Framer Motion 释放速度，单位为 px/s。 */
  velocity: CapsulePoint
  viewport: CapsuleSize
  capsuleSize: CapsuleSize
  safeMargin?: number
  projectionSeconds?: number
}): CapsuleDockTarget {
  const projection = nonNegative(projectionSeconds)
  const projectedPosition = clampCapsulePosition(
    {
      x: finiteOr(position.x, 0) + finiteOr(velocity.x, 0) * projection,
      y: finiteOr(position.y, 0) + finiteOr(velocity.y, 0) * projection,
    },
    viewport,
    capsuleSize,
    safeMargin,
  )
  const placement = capsulePositionToPlacement(
    projectedPosition,
    viewport,
    capsuleSize,
    safeMargin,
  )

  return {
    placement,
    position: resolveCapsulePosition(
      placement,
      viewport,
      capsuleSize,
      safeMargin,
    ),
  }
}

function resolveOverlayAvailableRect(
  viewportValue: CapsuleSize,
  overlaySizeValue: CapsuleSize,
  safeMargin: number,
): CapsuleRect {
  const viewport = normalizeSize(viewportValue)
  const overlaySize = normalizeSize(overlaySizeValue)
  const margin = nonNegative(safeMargin)
  const horizontalMargin =
    viewport.width >= overlaySize.width + margin * 2 ? margin : 0
  const contentHeight = Math.max(0, viewport.height - SHELL_TOP_BAR_HEIGHT)
  const verticalMargin =
    contentHeight >= overlaySize.height + margin * 2 ? margin : 0
  const x = horizontalMargin
  const y = Math.min(viewport.height, SHELL_TOP_BAR_HEIGHT + verticalMargin)

  return {
    x,
    y,
    width: Math.max(0, viewport.width - horizontalMargin * 2),
    height: Math.max(0, viewport.height - y - verticalMargin),
  }
}

export function resolveOverlayGeometry({
  viewport,
  overlaySize: overlaySizeValue,
  capsuleRect: capsuleRectValue,
  side,
  safeMargin = DEFAULT_CAPSULE_SAFE_MARGIN,
}: {
  viewport: CapsuleSize
  overlaySize: CapsuleSize
  capsuleRect: CapsuleRect
  side: CapsulePlacement['side']
  safeMargin?: number
}): OverlayGeometry {
  const overlaySize = normalizeSize(overlaySizeValue)
  const available = resolveOverlayAvailableRect(
    viewport,
    overlaySize,
    safeMargin,
  )
  const capsuleSize = normalizeSize(capsuleRectValue)
  const capsuleRect = {
    x: finiteOr(capsuleRectValue.x, 0),
    y: finiteOr(capsuleRectValue.y, 0),
    ...capsuleSize,
  }
  const width = Math.min(overlaySize.width, available.width)
  const height = Math.min(overlaySize.height, available.height)
  const normalizedSide = side === 'left' ? 'left' : 'right'
  const anchor = {
    x:
      normalizedSide === 'left'
        ? capsuleRect.x
        : capsuleRect.x + capsuleRect.width,
    y: capsuleRect.y + capsuleRect.height / 2,
  }
  const preferredX = normalizedSide === 'left' ? anchor.x : anchor.x - width
  const preferredY = anchor.y - height / 2
  const x = clamp(
    preferredX,
    available.x,
    available.x + available.width - width,
  )
  const y = clamp(
    preferredY,
    available.y,
    available.y + available.height - height,
  )
  const transformOrigin = {
    x: clamp(anchor.x - x, 0, width),
    y: clamp(anchor.y - y, 0, height),
  }

  return {
    x,
    y,
    width,
    height,
    transformOrigin,
    transformOriginCss: `${transformOrigin.x}px ${transformOrigin.y}px`,
  }
}
