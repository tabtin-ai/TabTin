import {
  DEFAULT_MAX_CREDITS_PER_RUN,
  DEFAULT_MAX_TURNS,
} from '@tabtin/agent-runtime/runtime-defaults'
import {
  hasNumericExecutionLimits,
  isExecutionLimitsEnabled,
  type ExecutionLimitsShape,
} from '@tabtin/app-shell/agent-config-v2'

export type ExecLimitsShape = ExecutionLimitsShape

/**
 * 启用执行限制时的推荐初值——复用 runtime-defaults SSoT。
 * 仅作 UI 预填 /「填入推荐值」，不再表示「未配置必套硬墙」。
 */
export const PRODUCT_DEFAULT_MAX_ITERATIONS = DEFAULT_MAX_TURNS
export const PRODUCT_DEFAULT_MAX_CREDITS = String(DEFAULT_MAX_CREDITS_PER_RUN)

/** @deprecated 使用 `hasNumericExecutionLimits`；保留别名以免调用方断裂 */
export function hasCustomExecutionLimits(limits: ExecLimitsShape | null | undefined): boolean {
  return hasNumericExecutionLimits(limits)
}

export { isExecutionLimitsEnabled, hasNumericExecutionLimits }

/**
 * 把落库形状摊成面板展示值；数值缺省时展示推荐初值（不代表已启用）。
 */
export function resolveExecutionLimitsDisplay(
  limits: ExecLimitsShape | null | undefined,
): { maxIterations: string; maxCredits: string } {
  return {
    maxIterations:
      limits?.max_iterations_per_run != null
        ? String(limits.max_iterations_per_run)
        : String(PRODUCT_DEFAULT_MAX_ITERATIONS),
    maxCredits:
      limits?.max_credits_per_run != null
        ? String(limits.max_credits_per_run)
        : PRODUCT_DEFAULT_MAX_CREDITS,
  }
}

/**
 * 启用状态下保存前校验并归一。
 *
 * 显式点「保存」即存字面值（即便等于推荐初值）——尊重用户的显式选择。
 */
export function normalizeExecutionLimitsForPersist(
  maxIterations: string,
  maxCredits: string,
): { iterValue: number | null; credValue: string | null } | { error: 'invalid' } {
  const iterRaw = maxIterations.trim()
  const credRaw = maxCredits.trim()

  if (iterRaw === '' || credRaw === '') {
    return { error: 'invalid' }
  }

  const iterValue = Number(iterRaw)
  if (isNaN(iterValue) || iterValue < 1 || !Number.isInteger(iterValue)) {
    return { error: 'invalid' }
  }
  if (isNaN(Number(credRaw)) || Number(credRaw) <= 0) {
    return { error: 'invalid' }
  }

  return {
    iterValue,
    credValue: credRaw,
  }
}
