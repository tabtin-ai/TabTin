/**
 * backend-adapter 的数值 / 坐标 / 链接归一化纯函数。
 * 从 backend-adapter.ts 抽离，供前后端双向转换复用，零副作用便于单测。
 */
import type { PPTElementLink } from '../../types/slides'

export const COORD_DECIMALS = 3
export const ROTATE_DECIMALS = 2
export const OPACITY_DECIMALS = 4

export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function getFrontendVisible(rawVisible: unknown): boolean | undefined {
  return rawVisible === false ? false : undefined
}

export function normalizeBackendElementLink(raw: unknown): PPTElementLink | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const link = raw as Record<string, unknown>
  const rawTarget = link.target
  if (typeof rawTarget !== 'string') return undefined
  const target = rawTarget.trim()
  if (!target) return undefined

  const rawType = typeof link.type === 'string' ? link.type.trim().toLowerCase() : ''
  if (rawType === 'slide') return { type: 'slide', target }
  if (rawType === 'web') return { type: 'web', target }

  if (/^page-\d+$/i.test(target) || /^slide\d+\.xml$/i.test(target) || /^\d+$/.test(target)) {
    return { type: 'slide', target }
  }
  return { type: 'web', target }
}

export function normalizeFrontendElementLink(raw: unknown): PPTElementLink | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const link = raw as Record<string, unknown>
  const target = typeof link.target === 'string' ? link.target.trim() : ''
  if (!target) return undefined
  const type = link.type === 'slide' ? 'slide' : 'web'
  return { type, target }
}

export function toFiniteNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim()
    if (normalized.length > 0) {
      const parsed = Number(normalized)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }
  return fallback
}

export function normalizeCoord(raw: unknown, fallback = 0): number {
  return roundTo(toFiniteNumber(raw, fallback), COORD_DECIMALS)
}

export function normalizeSize(raw: unknown, fallback: number, minValue: number): number {
  return Math.max(minValue, roundTo(toFiniteNumber(raw, fallback), COORD_DECIMALS))
}

export function normalizeRotate(raw: unknown, fallback = 0): number {
  return roundTo(toFiniteNumber(raw, fallback), ROTATE_DECIMALS)
}

export function normalizeOpacity(raw: unknown, fallback = 1): number {
  const value = clamp(toFiniteNumber(raw, fallback), 0, 1)
  return roundTo(value, OPACITY_DECIMALS)
}

export function normalizeZIndex(raw: unknown, fallback = 0): number {
  const parsed = toFiniteNumber(raw, fallback)
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  return Math.max(0, normalized)
}
