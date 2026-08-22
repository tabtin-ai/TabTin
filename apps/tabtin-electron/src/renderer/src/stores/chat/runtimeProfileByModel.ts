/**
 * Runtime Profile 按模型隔离（避免双栏切模型时 thinking / performance 串参）。
 *
 * 会话级仍写当前生效的 `thinking_mode` / `performance_profile`（给后端 / main），
 * 各模型历史意图落在 `*_by_model` JSON map；切模型时按目标 id 重算生效键。
 */

import {
  normalizeModelParamOverrides,
  toRuntimeProfileV2ForTransport,
  type ModelParamOverrides,
  type ModelParamValue,
} from './runtimeProfileIntent'

export const THINKING_BY_MODEL_KEY = 'thinking_by_model'
export const PERFORMANCE_BY_MODEL_KEY = 'performance_by_model'

const THINKING_MODES = new Set(['off', 'standard', 'deep'])
const PERFORMANCE_PROFILES = new Set(['fast', 'balanced', 'quality'])

type ScalarOverrides = Record<string, string | number | boolean>

function cloneScalar(
  overrides: ModelParamOverrides | null | undefined,
): ScalarOverrides {
  return normalizeModelParamOverrides(overrides) as ScalarOverrides
}

function parseStringMap(
  overrides: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, string> {
  const raw = overrides?.[key]
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [modelId, value] of Object.entries(parsed)) {
      const id = modelId.trim()
      if (id && typeof value === 'string' && value.trim()) {
        out[id] = value.trim().toLowerCase()
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeStringMap(
  next: ScalarOverrides,
  key: string,
  map: Record<string, string>,
): void {
  if (Object.keys(map).length === 0) {
    delete next[key]
    return
  }
  next[key] = JSON.stringify(map)
}

function normalizeThinkingMode(value: ModelParamValue | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return THINKING_MODES.has(normalized) ? normalized : null
}

function normalizePerformanceProfile(
  value: ModelParamValue | undefined,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return PERFORMANCE_PROFILES.has(normalized) ? normalized : null
}

/** 把会话级 thinking/performance 记到上一模型的 map（仅当 map 尚无该 id）。 */
export function seedRuntimeProfileMapsFromLegacy(
  overrides: ModelParamOverrides | null | undefined,
  previousModelId: string,
): ModelParamOverrides {
  const next = cloneScalar(overrides)
  const prevId = previousModelId.trim()
  if (!prevId) return toRuntimeProfileV2ForTransport(next)

  const thinkingMap = parseStringMap(next, THINKING_BY_MODEL_KEY)
  const thinking = normalizeThinkingMode(next.thinking_mode)
  if (thinking && !Object.prototype.hasOwnProperty.call(thinkingMap, prevId)) {
    thinkingMap[prevId] = thinking
    writeStringMap(next, THINKING_BY_MODEL_KEY, thinkingMap)
  }

  const performanceMap = parseStringMap(next, PERFORMANCE_BY_MODEL_KEY)
  const performance = normalizePerformanceProfile(next.performance_profile)
  if (
    performance
    && !Object.prototype.hasOwnProperty.call(performanceMap, prevId)
  ) {
    performanceMap[prevId] = performance
    writeStringMap(next, PERFORMANCE_BY_MODEL_KEY, performanceMap)
  }

  return toRuntimeProfileV2ForTransport(next)
}

/** 按目标模型从 map 重算生效 thinking_mode / performance_profile（无记录则清除，走 Catalog 默认）。 */
export function applyRuntimeProfileForModel(
  overrides: ModelParamOverrides | null | undefined,
  modelId: string,
): ModelParamOverrides {
  const next = cloneScalar(overrides)
  const id = modelId.trim()

  const thinkingMap = parseStringMap(next, THINKING_BY_MODEL_KEY)
  const thinking = id && Object.prototype.hasOwnProperty.call(thinkingMap, id)
    ? normalizeThinkingMode(thinkingMap[id])
    : null
  if (thinking) next.thinking_mode = thinking
  else delete next.thinking_mode
  delete next.reasoning_effort

  const performanceMap = parseStringMap(next, PERFORMANCE_BY_MODEL_KEY)
  const performance = id && Object.prototype.hasOwnProperty.call(performanceMap, id)
    ? normalizePerformanceProfile(performanceMap[id])
    : null
  if (performance) next.performance_profile = performance
  else delete next.performance_profile

  return toRuntimeProfileV2ForTransport(next)
}

export function writeThinkingForModel(
  overrides: ModelParamOverrides | null | undefined,
  modelId: string,
  mode: ModelParamValue,
): ModelParamOverrides {
  const next = cloneScalar(overrides)
  const id = modelId.trim()
  const normalized = normalizeThinkingMode(mode)
  const map = parseStringMap(next, THINKING_BY_MODEL_KEY)
  if (id && normalized) {
    map[id] = normalized
    next.thinking_mode = normalized
  } else if (id) {
    delete map[id]
    delete next.thinking_mode
  }
  writeStringMap(next, THINKING_BY_MODEL_KEY, map)
  delete next.reasoning_effort
  return toRuntimeProfileV2ForTransport(next)
}

export function writePerformanceForModel(
  overrides: ModelParamOverrides | null | undefined,
  modelId: string,
  profile: ModelParamValue,
): ModelParamOverrides {
  const next = cloneScalar(overrides)
  const id = modelId.trim()
  const normalized = normalizePerformanceProfile(profile)
  const map = parseStringMap(next, PERFORMANCE_BY_MODEL_KEY)
  if (id && normalized) {
    map[id] = normalized
    next.performance_profile = normalized
  } else if (id) {
    delete map[id]
    delete next.performance_profile
  }
  writeStringMap(next, PERFORMANCE_BY_MODEL_KEY, map)
  return toRuntimeProfileV2ForTransport(next)
}

/** Django 可能剥掉 *_by_model；响应后从本地 payload 补回。 */
export function retainRuntimeProfileByModelAfterServerPersist(
  serverOverrides: ModelParamOverrides | null | undefined,
  localPayload: ModelParamOverrides | null | undefined,
): ModelParamOverrides {
  const merged = cloneScalar(serverOverrides)
  const local = cloneScalar(localPayload)
  for (const key of [THINKING_BY_MODEL_KEY, PERFORMANCE_BY_MODEL_KEY]) {
    if (Object.prototype.hasOwnProperty.call(local, key)) {
      merged[key] = local[key]
    } else {
      delete merged[key]
    }
  }
  return toRuntimeProfileV2ForTransport(merged)
}
