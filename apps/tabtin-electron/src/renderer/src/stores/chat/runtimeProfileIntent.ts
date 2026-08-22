/**
 * Runtime Profile 客户端意图（W2d + 按模型隔离）。
 *
 * - 发往 main / updateModelParams 时传 v2，不把兼容投影的 reasoning_effort 当意图回写
 * - **不**把 schema / Catalog 默认 thinking_mode 写入运输层（PP-only 无 thinking_mode）
 * - thinking / performance 按模型 map 隔离，切模型时不串到未配置过的模型（见 runtimeProfileByModel）
 * - 兼容旧后端 v1 响应，不抛异常
 */

export type ModelParamValue = string | number | boolean | null
export type ModelParamOverrides = Record<string, ModelParamValue>

const THINKING_MODES = new Set(['off', 'standard', 'deep'])
const PERFORMANCE_PROFILES = new Set(['fast', 'balanced', 'quality'])
const MODE_TO_EFFORT: Record<string, string> = {
  off: 'off',
  standard: 'medium',
  deep: 'high',
}

/** 可由 thinking_mode 推导、不应回写为意图的投影键。 */
const PROJECTED_KEYS = new Set([
  'reasoning_effort',
  'reasoning.effort',
  'thinking_mode',
  'v',
])

const FORBIDDEN_LEGACY_KEYS = new Set([
  'speed',
  'speed_mode',
  'answer_mode',
  'response_mode',
])

/** 扁平 scalar 归一化（兼容旧客户端任意 key）。 */
export function normalizeModelParamOverrides(
  input?: ModelParamOverrides | null,
): ModelParamOverrides {
  const normalized: ModelParamOverrides = {}
  if (!input || typeof input !== 'object') return normalized
  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey.trim()
    if (!key || value === null) continue
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      normalized[key] = value
    }
  }
  return normalized
}

/**
 * 转为发往后端 / main 的 v2 意图。
 * 不重新生成可推导的 reasoning_effort；仅保留无法由 mode 表达的高级覆盖。
 * 无显式 thinking_mode / v1 effort 时，不注入默认 thinking_mode。
 */
export function toRuntimeProfileV2ForTransport(
  input?: ModelParamOverrides | null,
): ModelParamOverrides {
  const raw = normalizeModelParamOverrides(input)
  if (Object.keys(raw).length === 0) return {}

  try {
    const modeRaw = raw.thinking_mode
    if (typeof modeRaw === 'string' && THINKING_MODES.has(modeRaw.trim().toLowerCase())) {
      return canonicalizeV2(modeRaw.trim().toLowerCase(), raw)
    }

    if (typeof raw.reasoning_effort === 'string') {
      return upgradeV1EffortToV2(raw.reasoning_effort, raw)
    }

    // 无思考意图：保留 performance 等，绝不写 standard
    return packageIntentWithoutThinkingMode(raw)
  } catch {
    // 旧后端畸形响应不得拖垮客户端
    return raw
  }
}

/**
 * ChatGPT Codex / 本机订阅模型：思考强度是一等意图。
 * 必须保留 `reasoning_effort`（出网 → Responses `reasoning.effort`），
 * **禁止**升级成 `thinking_mode`——否则右栏高亮读不到、看起来像点不动。
 */
export function toCodexModelParamsForTransport(
  input?: ModelParamOverrides | null,
): ModelParamOverrides {
  const raw = normalizeModelParamOverrides(input)
  if (Object.keys(raw).length === 0) return {}

  const out: ModelParamOverrides = {}

  if (typeof raw.reasoning_effort === 'string') {
    const effort = raw.reasoning_effort.trim().toLowerCase()
    if (effort) out.reasoning_effort = effort
  }

  // 有显式 effort 时不再带 thinking_mode，避免 resolveReasoningEffort 双源打架
  if (!out.reasoning_effort && typeof raw.thinking_mode === 'string') {
    const mode = raw.thinking_mode.trim().toLowerCase()
    if (THINKING_MODES.has(mode)) out.thinking_mode = mode
  }

  appendNonThinkingIntentKeys(out, raw)
  if (Object.keys(out).length === 0) return {}
  return { v: 2, ...out }
}

/** 合并 session 持久化 + 乐观选择，再收成 v2。 */
export function mergeRuntimeProfileSources(
  sessionOverrides?: ModelParamOverrides | null,
  selectionOverrides?: ModelParamOverrides | null,
): ModelParamOverrides {
  return toRuntimeProfileV2ForTransport({
    ...normalizeModelParamOverrides(sessionOverrides),
    ...normalizeModelParamOverrides(selectionOverrides),
  })
}

export function runtimeProfileOrNull(
  profile: ModelParamOverrides,
): ModelParamOverrides | null {
  return Object.keys(profile).length > 0 ? profile : null
}

function canonicalizeV2(
  thinkingMode: string,
  raw: ModelParamOverrides,
): ModelParamOverrides {
  const out: ModelParamOverrides = {
    v: 2,
    thinking_mode: thinkingMode,
  }

  const effort = typeof raw.reasoning_effort === 'string'
    ? raw.reasoning_effort.trim().toLowerCase()
    : null
  const derived = MODE_TO_EFFORT[thinkingMode]
  // 仅保留 mode 推不出的高级覆盖（low / max）
  if (
    effort
    && effort !== derived
    && (effort === 'low' || effort === 'max')
  ) {
    out.reasoning_effort = effort
  }

  appendNonThinkingIntentKeys(out, raw)
  return out
}

/** PP / budget / 其它安全 scalar；无有效键时返回 {}（不单独写 v）。 */
function packageIntentWithoutThinkingMode(
  raw: ModelParamOverrides,
): ModelParamOverrides {
  const out: ModelParamOverrides = {}
  appendNonThinkingIntentKeys(out, raw)
  if (Object.keys(out).length === 0) return {}
  return { v: 2, ...out }
}

function appendNonThinkingIntentKeys(
  out: ModelParamOverrides,
  raw: ModelParamOverrides,
): void {
  for (const [key, value] of Object.entries(raw)) {
    if (PROJECTED_KEYS.has(key)) continue
    if (FORBIDDEN_LEGACY_KEYS.has(key)) continue
    if (key === 'performance_profile') {
      const profile = normalizePerformanceProfile(value)
      if (profile) out.performance_profile = profile
      continue
    }
    out[key] = value
  }
}

function normalizePerformanceProfile(
  value: ModelParamValue | undefined,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return PERFORMANCE_PROFILES.has(normalized) ? normalized : null
}

function upgradeV1EffortToV2(
  effortRaw: string,
  raw: ModelParamOverrides,
): ModelParamOverrides {
  const effort = effortRaw.trim().toLowerCase()
  if (effort === 'off' || effort === 'none' || effort === 'disabled') {
    return canonicalizeV2('off', raw)
  }
  if (effort === 'low') {
    return canonicalizeV2('standard', { ...raw, reasoning_effort: 'low' })
  }
  if (effort === 'medium') {
    return canonicalizeV2('standard', { ...raw, reasoning_effort: null })
  }
  if (effort === 'high') {
    return canonicalizeV2('deep', { ...raw, reasoning_effort: null })
  }
  if (effort === 'max') {
    return canonicalizeV2('deep', { ...raw, reasoning_effort: 'max' })
  }
  // xhigh / 未知：宽松 deep，不带非法 effort
  return canonicalizeV2('deep', { ...raw, reasoning_effort: null })
}
