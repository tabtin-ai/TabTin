/**
 * Runtime Profile downgrade notice（W2f PR2）。
 *
 * 与 legacy `feature=reasoning` + omit_reasoning_param 文案分流：
 * 仅当 `extras.stage === 'runtime_profile'` 时走本映射。
 * **禁止**据此回写 Session `thinking_mode`。
 */

import type {
  Model,
  ModelParamOverrides,
  RuntimeProfileThinkingMode,
} from '@tabtin/chat-client'
import type { CapabilityBanner } from '@/stores/useChatRuntimeStore'
import { getCatalogThinkingCapability } from '../composer/thinkingModeCapability'
import { shouldShowReasoningEffortSelector } from '../model/ReasoningEffortSelector'

export const RUNTIME_PROFILE_STAGE = 'runtime_profile'

export type RuntimeProfileNoticeReason =
  | 'effort_level_unavailable'
  | 'thinking_off_unsupported'
  | 'thinking_not_controllable'
  | 'output_budget_exceeds_model_max'

type Translate = (key: string, opts?: Record<string, unknown>) => string

export type RuntimeProfileBannerDraft = Omit<CapabilityBanner, 'id' | 'receivedAt'>

export function isRuntimeProfileCapabilityBanner(
  banner: Pick<CapabilityBanner, 'feature' | 'extras'>,
): boolean {
  return readExtrasStage(banner.extras) === RUNTIME_PROFILE_STAGE
}

/** banner 文案：优先服务端 message；否则按 reason 映射。非 RP stage 返回 null。 */
export function resolveRuntimeProfileBannerMessage(
  banner: Pick<CapabilityBanner, 'message' | 'feature' | 'fallback_to' | 'extras'>,
  t: Translate,
): string | null {
  if (!isRuntimeProfileCapabilityBanner(banner)) return null

  if (typeof banner.message === 'string' && banner.message.trim()) {
    return banner.message.trim()
  }

  const reason = readExtrasReason(banner.extras)
  return messageForReason(reason, t, banner.extras)
}

export function messageForReason(
  reason: string | undefined,
  t: Translate,
  extras?: Record<string, unknown>,
): string {
  switch (reason) {
    case 'thinking_off_unsupported':
      return t('capability.banner.runtimeProfile.offUnsupported', {
        defaultValue: '该模型始终思考，本轮已按最低强度执行。',
      })
    case 'thinking_not_controllable':
      return t('capability.banner.runtimeProfile.notControllable', {
        defaultValue: '当前模型不支持调节思考强度。',
      })
    case 'output_budget_exceeds_model_max':
      return t('capability.banner.runtimeProfile.outputBudgetClamped', {
        defaultValue: '输出长度已按当前模型上限调整。',
      })
    case 'effort_level_unavailable': {
      const requested = readExtrasString(extras, 'requested')
      if (requested === 'max') {
        return t('capability.banner.runtimeProfile.maxUnsupported', {
          defaultValue: '当前模型不支持你选择的思考强度，本轮已按可用档执行。',
        })
      }
      return t('capability.banner.runtimeProfile.effortUnavailable', {
        defaultValue: '当前模型不支持你选择的思考强度，本轮已按可用档执行。',
      })
    }
    default:
      return t('capability.banner.runtimeProfile.generic', {
        defaultValue: '当前模型已按可用的思考能力调整本轮设置。',
      })
  }
}

/**
 * 切模型后即时预判（不调 resolver、不改 intent）。
 * 仅依据 Catalog modes + Session thinking_mode / max 覆盖。
 */
export function predictRuntimeProfileNoticesOnModelSwitch(
  overrides: ModelParamOverrides | null | undefined,
  newModel: Model | null | undefined,
): RuntimeProfileBannerDraft[] {
  const intentMode = readIntentThinkingMode(overrides)
  const hasMaxOverride = typeof overrides?.reasoning_effort === 'string'
    && overrides.reasoning_effort.trim().toLowerCase() === 'max'

  const capability = getCatalogThinkingCapability(newModel)
  const modelLabel = newModel?.display_name || newModel?.name || newModel?.model_name
  // Codex 等用 runtime_controls.reasoning_effort 调节强度，不算「不支持」
  const hasReasoningEffortControl = shouldShowReasoningEffortSelector(newModel)

  if (!capability) {
    if (hasReasoningEffortControl) return []
    // unsupported：off / 空意图静默；standard/deep/max 出 notice
    if (
      intentMode === 'standard'
      || intentMode === 'deep'
      || hasMaxOverride
    ) {
      return [buildDraft({
        reason: 'thinking_not_controllable',
        fallback_to: 'not_controllable',
        model: modelLabel,
        requested: intentMode ?? (hasMaxOverride ? 'max' : undefined),
      })]
    }
    return []
  }

  const drafts: RuntimeProfileBannerDraft[] = []

  if (intentMode === 'off' && !capability.modes.includes('off')) {
    drafts.push(buildDraft({
      reason: 'thinking_off_unsupported',
      fallback_to: 'lowest_effort',
      model: modelLabel,
      requested: 'off',
    }))
  }

  if (
    intentMode
    && intentMode !== 'off'
    && !capability.modes.includes(intentMode)
  ) {
    drafts.push(buildDraft({
      reason: 'effort_level_unavailable',
      fallback_to: capability.defaultMode,
      model: modelLabel,
      requested: intentMode,
    }))
  }

  // Catalog 不暴露 effort_levels：max 是否可用留给发消息 SSE（reason + requested=max）
  return drafts
}

/** 供单测：确认预测逻辑不碰 overrides 引用内容。 */
export function assertIntentUnchanged(
  before: ModelParamOverrides | null | undefined,
  after: ModelParamOverrides | null | undefined,
): boolean {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null)
}

function readIntentThinkingMode(
  overrides: ModelParamOverrides | null | undefined,
): RuntimeProfileThinkingMode | null {
  const raw = overrides?.thinking_mode
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'off' || normalized === 'standard' || normalized === 'deep') {
    return normalized
  }
  return null
}

function buildDraft(args: {
  reason: RuntimeProfileNoticeReason
  fallback_to: string
  model?: string
  requested?: string
}): RuntimeProfileBannerDraft {
  return {
    kind: 'downgrade',
    feature: 'reasoning',
    fallback_to: args.fallback_to,
    // 即时 banner 用产品文案常量；渲染时仍走 resolveRuntimeProfileBannerMessage
    message: undefined,
    model: args.model,
    extras: {
      stage: RUNTIME_PROFILE_STAGE,
      reason: args.reason,
      ...(args.requested ? { requested: args.requested } : {}),
      source: 'model_switch_predict',
    },
  }
}

function readExtrasStage(extras?: Record<string, unknown>): string | undefined {
  return readExtrasString(extras, 'stage')
}

function readExtrasReason(extras?: Record<string, unknown>): string | undefined {
  return readExtrasString(extras, 'reason')
}

function readExtrasString(
  extras: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = extras?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
