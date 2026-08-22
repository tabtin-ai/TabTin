import type {
  EditorConfig,
  PPTElement,
  PPTLineElement,
  SlideLayoutRef,
} from '../../types/slides'
import { getShapePath } from '../../configs/shapes'
import { normalizeLineGeometry } from '../../utils/line-geometry'

const COORD_DECIMALS = 3
const ROTATE_DECIMALS = 2
const OPACITY_DECIMALS = 4

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const roundTo = (value: number, decimals: number): number => {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

export const normalizeElementTransform = (element: PPTElement): PPTElement => {
  if (element.type === 'line') {
    const normalizedLine = normalizeLineGeometry(
      element as PPTLineElement,
      { minWidth: 1, minHeight: 1, decimals: COORD_DECIMALS },
    )
    const normalized = { ...normalizedLine } as Record<string, unknown>
    if (typeof normalizedLine.rotate === 'number') {
      normalized.rotate = roundTo(normalizedLine.rotate, ROTATE_DECIMALS)
    }
    if (typeof normalizedLine.opacity === 'number') {
      normalized.opacity = roundTo(clamp(normalizedLine.opacity, 0, 1), OPACITY_DECIMALS)
    }
    return normalized as unknown as PPTElement
  }

  const normalized = { ...element } as Record<string, unknown>

  normalized.x = roundTo(element.x, COORD_DECIMALS)
  normalized.y = roundTo(element.y, COORD_DECIMALS)
  normalized.width = Math.max(1, roundTo(element.width, COORD_DECIMALS))
  if (typeof (element as { height?: number }).height === 'number') {
    normalized.height = Math.max(1, roundTo((element as { height: number }).height, COORD_DECIMALS))
  }

  if (typeof (element as { rotate?: number }).rotate === 'number') {
    normalized.rotate = roundTo((element as { rotate: number }).rotate, ROTATE_DECIMALS)
  }
  if (typeof element.opacity === 'number') {
    normalized.opacity = roundTo(clamp(element.opacity, 0, 1), OPACITY_DECIMALS)
  }

  const normalizedElement = normalized as unknown as PPTElement
  if (normalizedElement.type === 'shape' && normalizedElement.pathFormula) {
    normalizedElement.path = getShapePath(
      normalizedElement.pathFormula,
      normalizedElement.path,
      normalizedElement.width,
      normalizedElement.height,
      normalizedElement.keypoints,
    )
  }

  return normalizedElement
}

export const normalizeElementUpdates = (
  current: PPTElement,
  updates: Partial<PPTElement>,
): Partial<PPTElement> => {
  const normalized = { ...updates } as Record<string, unknown>
  const isLine = current.type === 'line'

  if (typeof normalized.x === 'number') {
    normalized.x = roundTo(normalized.x, COORD_DECIMALS)
  }
  if (typeof normalized.y === 'number') {
    normalized.y = roundTo(normalized.y, COORD_DECIMALS)
  }
  if (typeof normalized.width === 'number') {
    normalized.width = Math.max(isLine ? 0 : 1, roundTo(normalized.width, COORD_DECIMALS))
  }
  if (typeof normalized.height === 'number') {
    normalized.height = Math.max(isLine ? 0 : 1, roundTo(normalized.height, COORD_DECIMALS))
  }
  if (typeof normalized.rotate === 'number') {
    normalized.rotate = roundTo(normalized.rotate, ROTATE_DECIMALS)
  }
  if (typeof normalized.opacity === 'number') {
    normalized.opacity = roundTo(clamp(normalized.opacity, 0, 1), OPACITY_DECIMALS)
  }

  return normalized as Partial<PPTElement>
}

const applyBooleanEditorConfigUpdates = (
  next: EditorConfig,
  updates: Partial<EditorConfig>,
) => {
  if (typeof updates.snapToGrid === 'boolean') next.snapToGrid = updates.snapToGrid
  if (typeof updates.snapToGuides === 'boolean') next.snapToGuides = updates.snapToGuides
  if (typeof updates.showGrid === 'boolean') next.showGrid = updates.showGrid
  if (typeof updates.showRuler === 'boolean') next.showRuler = updates.showRuler
}

const applyGridEditorConfigUpdates = (
  next: EditorConfig,
  updates: Partial<EditorConfig>,
) => {
  if (typeof updates.gridSize === 'number' && Number.isFinite(updates.gridSize) && updates.gridSize > 0) {
    next.gridSize = Math.max(1, Math.round(updates.gridSize))
  }

  if (
    typeof updates.snapThreshold === 'number'
    && Number.isFinite(updates.snapThreshold)
    && updates.snapThreshold >= 0
  ) {
    next.snapThreshold = roundTo(updates.snapThreshold, 2)
  }
}

const applyZoomEditorConfigUpdates = (
  next: EditorConfig,
  updates: Partial<EditorConfig>,
) => {
  if (typeof updates.minZoom === 'number' && Number.isFinite(updates.minZoom) && updates.minZoom > 0) {
    next.minZoom = roundTo(updates.minZoom, 3)
  }
  if (typeof updates.maxZoom === 'number' && Number.isFinite(updates.maxZoom) && updates.maxZoom > 0) {
    next.maxZoom = roundTo(updates.maxZoom, 3)
  }

  if (next.minZoom > next.maxZoom) {
    next.maxZoom = next.minZoom
  }
}

export const sanitizeEditorConfig = (
  current: EditorConfig,
  updates: Partial<EditorConfig>,
): EditorConfig => {
  const next: EditorConfig = { ...current }

  applyBooleanEditorConfigUpdates(next, updates)
  applyGridEditorConfigUpdates(next, updates)
  applyZoomEditorConfigUpdates(next, updates)

  return next
}

export const normalizeLayoutRef = (layout?: SlideLayoutRef): SlideLayoutRef | undefined => {
  if (!layout || typeof layout !== 'object') return undefined
  const next: SlideLayoutRef = {}

  if (typeof layout.name === 'string' && layout.name.trim()) {
    next.name = layout.name.trim()
  }
  if (typeof layout.index === 'number' && Number.isFinite(layout.index) && layout.index >= 0) {
    next.index = Math.trunc(layout.index)
  }
  if (typeof layout.partName === 'string' && layout.partName.trim()) {
    next.partName = layout.partName.trim()
  }
  if (typeof layout.masterName === 'string' && layout.masterName.trim()) {
    next.masterName = layout.masterName.trim()
  }
  if (typeof layout.masterPartName === 'string' && layout.masterPartName.trim()) {
    next.masterPartName = layout.masterPartName.trim()
  }

  return Object.keys(next).length > 0 ? next : undefined
}
