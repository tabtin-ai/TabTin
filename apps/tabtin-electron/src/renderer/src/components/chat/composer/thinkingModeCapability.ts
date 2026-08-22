/**
 * ThinkingModeChip / ThinkingModeSelector 纯逻辑（W2f）。
 * 数据源仅 Catalog `runtime_profile.thinking` + Session `thinking_mode` 意图。
 */

import type {
  Model,
  ModelParamOverrides,
  ModelRuntimeControl,
  ModelRuntimeProfileThinking,
  RuntimeProfileThinkingMode,
} from '@tabtin/chat-client'

export const THINKING_MODE_VALUES: readonly RuntimeProfileThinkingMode[] = [
  'off',
  'standard',
  'deep',
] as const

const THINKING_MODE_SET = new Set<string>(THINKING_MODE_VALUES)

export type CatalogThinkingCapability = {
  modes: RuntimeProfileThinkingMode[]
  defaultMode: RuntimeProfileThinkingMode
  /** 始终开启、无可点档（只读展示）。 */
  alwaysOn: boolean
  /** 仅 off + standard：UI 展示「关闭 / 开启」，非强度梯子。 */
  binaryToggle: boolean
}

/** Catalog 是否应渲染思考区（可点开关、强度档、或只读始终开启）。 */
export function getCatalogThinkingCapability(
  model: Model | null | undefined,
): CatalogThinkingCapability | null {
  const thinking = model?.runtime_profile?.thinking as ModelRuntimeProfileThinking | undefined
  if (!thinking || thinking.supported !== true) return null

  const modes = (thinking.modes ?? []).filter(
    (mode): mode is RuntimeProfileThinkingMode => (
      typeof mode === 'string' && THINKING_MODE_SET.has(mode)
    ),
  )

  const alwaysOn = thinking.always_on === true
  if (modes.length === 0) {
    if (!alwaysOn) return null
    return {
      modes: [],
      defaultMode: 'standard',
      alwaysOn: true,
      binaryToggle: false,
    }
  }

  const defaultRaw = thinking.default_mode
  const defaultMode = (
    typeof defaultRaw === 'string' && THINKING_MODE_SET.has(defaultRaw)
      && modes.includes(defaultRaw as RuntimeProfileThinkingMode)
      ? defaultRaw
      : modes.includes('standard')
        ? 'standard'
        : modes[0]
  ) as RuntimeProfileThinkingMode

  const binaryToggle = (
    modes.length === 2
    && modes.includes('off')
    && modes.includes('standard')
    && !modes.includes('deep')
  )

  return { modes, defaultMode, alwaysOn: false, binaryToggle }
}

/**
 * 当前展示意图：只读 `thinking_mode`，缺省用 Catalog default_mode。
 * 不读 reasoning_effort / resolved runtime。
 * 若当前意图不在 modes 内（如历史 deep 落到仅 off/standard 的模型），回落 default。
 */
export function resolveActiveThinkingMode(
  overrides: ModelParamOverrides | null | undefined,
  defaultMode: RuntimeProfileThinkingMode,
  modes?: readonly RuntimeProfileThinkingMode[],
): RuntimeProfileThinkingMode {
  const raw = overrides?.thinking_mode
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase()
    if (THINKING_MODE_SET.has(normalized)) {
      const mode = normalized as RuntimeProfileThinkingMode
      if (!modes || modes.length === 0 || modes.includes(mode)) {
        return mode
      }
      // 历史 deep → 二进制模型：视为开启（standard）
      if (mode === 'deep' && modes.includes('standard')) {
        return 'standard'
      }
      return defaultMode
    }
  }
  return defaultMode
}

/** 思考类旧 runtime_controls：有 runtime_profile 芯片时隐藏，避免双写。 */
export function isThinkingRelatedRuntimeControl(
  control: ModelRuntimeControl | null | undefined,
): boolean {
  if (!control) return false
  const key = String(control.key || '').trim().toLowerCase()
  const path = String(control.param_path || '').trim().toLowerCase()
  const haystack = `${key} ${path}`
  return (
    haystack.includes('reasoning')
    || haystack.includes('thinking')
    || key === 'reasoning_effort'
    || path === 'reasoning_effort'
  )
}

export function thinkingModeControlChange(
  mode: RuntimeProfileThinkingMode,
): { key: 'thinking_mode'; value: RuntimeProfileThinkingMode } {
  return { key: 'thinking_mode', value: mode }
}
