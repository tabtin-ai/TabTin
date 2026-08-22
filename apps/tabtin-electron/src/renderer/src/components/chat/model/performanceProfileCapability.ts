/**
 * Performance Profile（响应策略）纯逻辑 — P1 只存意图。
 * Canonical key: performance_profile；与 thinking_mode 正交。
 *
 * UI 门控：仅当 Catalog `runtime_profile.performance.supported === true`
 * 才渲染选择器。缺省 / false / undefined → 隐藏（当前全厂商无真实 Fast API）。
 */

import type { Model, ModelParamOverrides, ModelParamValue } from '@tabtin/chat-client'

export const PERFORMANCE_PROFILE_VALUES = [
  'fast',
  'balanced',
  'quality',
] as const

export type PerformanceProfileValue = (typeof PERFORMANCE_PROFILE_VALUES)[number]

export const DEFAULT_PERFORMANCE_PROFILE: PerformanceProfileValue = 'balanced'

const PROFILE_SET = new Set<string>(PERFORMANCE_PROFILE_VALUES)

/** Catalog 能力门控：仅显式 supported=true 才展示可执行 Performance UI。 */
export function isPerformanceCapabilitySupported(
  model: Model | null | undefined,
): boolean {
  const runtimeProfile = model?.runtime_profile as
    | { performance?: { supported?: boolean } }
    | undefined
  return runtimeProfile?.performance?.supported === true
}

export function isPerformanceProfileValue(
  value: unknown,
): value is PerformanceProfileValue {
  return typeof value === 'string' && PROFILE_SET.has(value.trim().toLowerCase())
}

/** 读 Session 意图；非法 / 缺失 → balanced。不读 Catalog。 */
export function resolveActivePerformanceProfile(
  overrides: ModelParamOverrides | null | undefined,
): PerformanceProfileValue {
  const raw = overrides?.performance_profile
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (PROFILE_SET.has(normalized)) {
      return normalized as PerformanceProfileValue
    }
  }
  return DEFAULT_PERFORMANCE_PROFILE
}

export function performanceProfileControlChange(
  profile: PerformanceProfileValue,
): { key: 'performance_profile'; value: PerformanceProfileValue } {
  return { key: 'performance_profile', value: profile }
}

/** 供运输层校验：合法则返回规范化值，否则 null。 */
export function normalizePerformanceProfileValue(
  value: ModelParamValue | undefined,
): PerformanceProfileValue | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return PROFILE_SET.has(normalized)
    ? (normalized as PerformanceProfileValue)
    : null
}
