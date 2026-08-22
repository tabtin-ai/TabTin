export type ObserveStatus = 'ok' | 'empty' | 'skipped' | 'error'

/** act 内嵌观察成功：先用清单；缺目标再 glance 一次；正文走 print/fetch。 */
export const ACT_OBSERVE_OK_HINT =
  'observe_status=ok：本响应已含 observed_elements，先用清单里的 ref 继续 act；'
  + '要用的目标不在清单里时再 glance 一次（--tree/--screenshot 也走 glance）。'
  + '读正文用 tabtin browser print --save <path> 或 tabtin fetch。'

/** act 内嵌观察失败/空：glance 补观察。 */
export const ACT_OBSERVE_RETRY_HINT =
  'observe_status 为 empty/error：请 glance 一次补观察后再 act；读正文仍用 print --save / tabtin fetch，不要靠 glance 抠正文。'

export function resolveObserveStatus(opts: {
  observeRequested: boolean
  observation?: { observed_elements?: unknown } | undefined
  observeFailed: boolean
}): { observe_status: ObserveStatus; patch: Record<string, unknown> } {
  if (!opts.observeRequested) {
    return {
      observe_status: 'skipped',
      patch: { observe_status: 'skipped' },
    }
  }

  if (opts.observeFailed) {
    return {
      observe_status: 'error',
      patch: { observe_status: 'error' },
    }
  }

  const elements = opts.observation?.observed_elements
  if (!Array.isArray(elements)) {
    return {
      observe_status: 'error',
      patch: { observe_status: 'error' },
    }
  }

  if (elements.length === 0) {
    return {
      observe_status: 'empty',
      patch: { observe_status: 'empty', observed_elements: [] },
    }
  }

  return {
    observe_status: 'ok',
    patch: { observe_status: 'ok', observed_elements: elements },
  }
}

function composeActObserveHint(
  observeStatus: ObserveStatus,
  baseHint: string | undefined,
): string | undefined {
  const statusHint =
    observeStatus === 'ok'
      ? ACT_OBSERVE_OK_HINT
      : observeStatus === 'empty' || observeStatus === 'error'
        ? ACT_OBSERVE_RETRY_HINT
        : undefined
  if (!statusHint && !baseHint) return undefined
  if (!statusHint) return baseHint
  if (!baseHint) return statusHint
  // 状态提示置前，截断 preview 第一眼可见
  return `${statusHint} ${baseHint}`
}

/**
 * act 内嵌观察合并：`resolveObserveStatus` 产出 observe_status + observed_elements；
 * hint / login_required 单独透传，并按 observe_status 叠加路由提示。
 */
export function mergeActEmbedObserve(
  actData: Record<string, unknown>,
  opts: {
    observeRequested: boolean
    observation?: Record<string, unknown> | undefined
    observeFailed: boolean
  },
): Record<string, unknown> {
  const { observe_status, patch } = resolveObserveStatus({
    observeRequested: opts.observeRequested,
    observation: opts.observation,
    observeFailed: opts.observeFailed,
  })
  const merged: Record<string, unknown> = { ...actData, ...patch }
  const baseHint =
    typeof opts.observation?.hint === 'string' && opts.observation.hint
      ? opts.observation.hint
      : undefined
  const hint = composeActObserveHint(observe_status, baseHint)
  if (hint) merged.hint = hint
  if (opts.observation?.login_required !== undefined) {
    merged.login_required = opts.observation.login_required
  }
  return merged
}
