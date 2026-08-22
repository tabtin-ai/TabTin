import type {
  RestoreActiveSurface,
  RestoreDecision,
  RestoreGeneration,
} from './types'

export interface RestoreScopeIdentity {
  spaceId: string
  scopeKey: string
  scopeVersion: number
}

export interface RestoreScopeResult {
  restoreSettled: boolean
  desiredActiveViewId: string | null
  activeSurface: RestoreActiveSurface
  generation: RestoreGeneration
  lastDecision: RestoreDecision | null
}

export function isRestoreGenerationCurrent(
  generation: RestoreGeneration,
  identity: RestoreScopeIdentity,
): boolean {
  return (
    generation.spaceId === identity.spaceId
    && generation.scopeKey === identity.scopeKey
    && generation.scopeVersion === identity.scopeVersion
  )
}

/**
 * React 在 effect 执行前可能暂时保留上一个 scope 的 coordinator result。
 * 旧结果只能作为不可见的过渡态，不能把 active view / desktop surface 带进新 scope。
 */
export function gateRestoreResultForScope(
  result: RestoreScopeResult,
  identity: RestoreScopeIdentity,
): RestoreScopeResult {
  if (isRestoreGenerationCurrent(result.generation, identity)) return result

  return {
    ...result,
    restoreSettled: false,
    desiredActiveViewId: null,
    activeSurface: 'real_tab',
    generation: {
      ...identity,
      sequence: result.generation.sequence,
    },
    lastDecision: null,
  }
}
