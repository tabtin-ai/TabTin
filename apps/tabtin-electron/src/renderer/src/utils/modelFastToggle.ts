/**
 * 模型 Fast 模式（右栏开关 / 触发条闪电）。
 *
 * - Codex：会话意图写 `service_tier=fast`；LocalCodex 出网归一成 `priority`
 *   （chatgpt.com Codex 拒收裸 `fast`）
 * - 其它：目录 `runtime_controls` 声明了 speed / service_tier 且含 fast|priority
 * - 各模型开关存在 `fast_by_model`（JSON map）；切模型时按目标 id 重算生效参数
 */

import type { Model, ModelRuntimeControl } from '@tabtin/chat-client'
import { isOpenAICodexModel } from '../../../shared/openai-codex-models'

export const FAST_BY_MODEL_KEY = 'fast_by_model'
/** 旧会话读兼容；新写入只落 FAST_BY_MODEL_KEY。 */
const LEGACY_FAST_BY_MODEL_KEY = 'codex_fast_by_model'

export type ModelFastToggle = {
  key: string
  onValue: string
}

type ScalarOverrides = Record<string, string | number | boolean>

const CODEX_FAST_TOGGLE: ModelFastToggle = {
  key: 'service_tier',
  onValue: 'fast',
}

const FAST_PARAM_KEYS = ['service_tier', 'speed'] as const
const FAST_PARAM_KEY_SET = new Set<string>(FAST_PARAM_KEYS)

function isFastOptionValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 'fast' || normalized === 'priority'
}

function looksLikeFastOption(option: { value?: unknown; label?: string }): boolean {
  return (
    isFastOptionValue(option.value)
    || /fast|加速|极速/i.test(String(option.label || ''))
  )
}

function controlParamKey(control: ModelRuntimeControl): string {
  return (control.param_path?.trim() || control.key || '').trim()
}

function findCatalogFastToggle(model: Model): ModelFastToggle | null {
  for (const control of model.runtime_controls ?? []) {
    if (!control || control.kind !== 'select' || control.visibility === 'hidden') continue
    const key = controlParamKey(control)
    if (!FAST_PARAM_KEY_SET.has(key.toLowerCase())) continue
    const fastOption = (control.options ?? []).find(looksLikeFastOption)
    if (!fastOption || !isFastOptionValue(fastOption.value)) continue
    return { key, onValue: fastOption.value.trim() }
  }
  return null
}

/** 该模型是否显示 Fast，以及点击应写哪个参数。 */
export function resolveModelFastToggle(model: Model | null | undefined): ModelFastToggle | null {
  if (!model?.id) return null
  if (isOpenAICodexModel(model.id)) return CODEX_FAST_TOGGLE
  return findCatalogFastToggle(model)
}

function cloneScalarOverrides(
  overrides: Record<string, unknown> | null | undefined,
): ScalarOverrides {
  const out: ScalarOverrides = {}
  if (!overrides || typeof overrides !== 'object') return out
  for (const [key, value] of Object.entries(overrides)) {
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      out[key] = value
    }
  }
  return out
}

function parseFastByModel(
  overrides: Record<string, unknown> | null | undefined,
): Record<string, boolean> {
  const raw =
    overrides?.[FAST_BY_MODEL_KEY] ?? overrides?.[LEGACY_FAST_BY_MODEL_KEY]
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [modelId, enabled] of Object.entries(parsed)) {
      const id = modelId.trim()
      if (id && typeof enabled === 'boolean') out[id] = enabled
    }
    return out
  } catch {
    return {}
  }
}

function writeFastMap(next: ScalarOverrides, map: Record<string, boolean>): void {
  delete next[LEGACY_FAST_BY_MODEL_KEY]
  if (Object.keys(map).length === 0) {
    delete next[FAST_BY_MODEL_KEY]
    return
  }
  next[FAST_BY_MODEL_KEY] = JSON.stringify(map)
}

/** 清掉非当前控件上的加速通道，避免 service_tier / speed 互污染。 */
function clearSiblingFastParams(next: ScalarOverrides, keepKey: string): void {
  for (const key of FAST_PARAM_KEYS) {
    if (key === keepKey) continue
    const value = next[key]
    if (typeof value === 'string' && isFastOptionValue(value)) {
      delete next[key]
    }
  }
}

function clearAllFastParams(next: ScalarOverrides): void {
  delete next.service_tier
  if (typeof next.speed === 'string' && isFastOptionValue(next.speed)) {
    delete next.speed
  }
}

/** 当前生效 scalar 是否为 Fast（出网用）。 */
export function isFastParamEnabled(
  overrides: Record<string, unknown> | null | undefined,
  toggle: ModelFastToggle = CODEX_FAST_TOGGLE,
): boolean {
  if (!overrides) return false
  const raw = overrides[toggle.key]
  if (!isFastOptionValue(raw)) return false
  const normalized = raw.trim().toLowerCase()
  const on = toggle.onValue.trim().toLowerCase()
  if (normalized === on) return true
  // service_tier 额外兼容 priority
  return toggle.key === 'service_tier'
}

/** 列表行 / 点击：优先 map；无 map 时仅当前模型继承会话级 Fast。 */
export function isFastEnabledForModel(
  overrides: Record<string, unknown> | null | undefined,
  modelId: string,
  currentModelId?: string | null,
  toggle: ModelFastToggle = CODEX_FAST_TOGGLE,
): boolean {
  const id = modelId.trim()
  if (!id) return false
  const map = parseFastByModel(overrides)
  if (Object.prototype.hasOwnProperty.call(map, id)) return map[id]
  const currentId = (currentModelId ?? '').trim()
  return Boolean(
    currentId
    && id === currentId
    && Object.keys(map).length === 0
    && isFastParamEnabled(overrides, toggle),
  )
}

export function isFastOnValue(
  value: unknown,
  toggle: ModelFastToggle,
): boolean {
  if (!isFastOptionValue(value)) return false
  const normalized = value.trim().toLowerCase()
  if (normalized === toggle.onValue.trim().toLowerCase()) return true
  return toggle.key === 'service_tier'
}

/** 写入/清除某模型 Fast，并同步当前生效参数（假定已切到该模型）。 */
export function writeFastForModel(
  overrides: Record<string, unknown> | null | undefined,
  modelId: string,
  enabled: boolean,
  toggle: ModelFastToggle = CODEX_FAST_TOGGLE,
): ScalarOverrides {
  const next = cloneScalarOverrides(overrides)
  const id = modelId.trim()
  const map = parseFastByModel(next)
  if (id) map[id] = enabled
  writeFastMap(next, map)
  if (enabled) next[toggle.key] = toggle.onValue
  else delete next[toggle.key]
  clearSiblingFastParams(next, toggle.key)
  return next
}

export function seedFastMapFromLegacyParam(
  overrides: Record<string, unknown> | null | undefined,
  previousModelId: string,
  toggle: ModelFastToggle = CODEX_FAST_TOGGLE,
): ScalarOverrides {
  const next = cloneScalarOverrides(overrides)
  if (Object.keys(parseFastByModel(next)).length > 0) return next
  if (!isFastParamEnabled(next, toggle)) return next
  const id = previousModelId.trim()
  if (!id) return next
  return writeFastForModel(next, id, true, toggle)
}

/** 按目标模型从 map 重算生效 Fast 参数（不改写 map）。 */
export function applyFastParamForModel(
  overrides: Record<string, unknown> | null | undefined,
  modelId: string,
  toggle: ModelFastToggle | null,
): ScalarOverrides {
  const next = cloneScalarOverrides(overrides)
  if (!toggle) {
    clearAllFastParams(next)
    return next
  }
  if (isFastEnabledForModel(next, modelId)) {
    next[toggle.key] = toggle.onValue
  } else {
    delete next[toggle.key]
  }
  clearSiblingFastParams(next, toggle.key)
  return next
}

/**
 * Django 落库只保留 thinking_*；客户端在响应后把 Fast 相关键补回。
 */
export function retainFastOverridesAfterServerPersist(
  serverOverrides: Record<string, unknown> | null | undefined,
  localPayload: Record<string, unknown> | null | undefined,
): ScalarOverrides {
  const merged = cloneScalarOverrides(serverOverrides)
  const local = cloneScalarOverrides(localPayload)
  for (const key of [FAST_BY_MODEL_KEY, LEGACY_FAST_BY_MODEL_KEY, 'service_tier', 'speed']) {
    if (Object.prototype.hasOwnProperty.call(local, key)) {
      merged[key] = local[key]
    } else {
      delete merged[key]
    }
  }
  return merged
}
