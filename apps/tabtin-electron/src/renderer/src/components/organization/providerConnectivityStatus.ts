/**
 * 渠道顶部状态标签的展示态。
 *
 * 最近一次「测试连接」结果优先于聚合 runtime_status，避免探测失败时
 * 仍因历史 healthy 显示「连通正常」。
 */
export type ProviderConnectivityDisplayStatus =
  | 'paused'
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unknown'

export type ProviderLatestProbe = {
  type: 'success' | 'error'
}

export type ProviderDegradedReason =
  | 'recent_failures'
  | 'slow_response'
  | 'recovering'
  | 'unstable'

/**
 * `degraded` 是运行态，不等于“最近失败”：高延迟和熔断恢复期也会进入该状态。
 * 用已公开的健康统计把用户可见原因拆开，避免 100% 成功率旁仍显示“近期有失败”。
 */
export function resolveProviderDegradedReason(options: {
  healthSuccessRate?: number | null
  healthAverageLatencyMs?: number | null
  healthConsecutiveFailures?: number | null
}): ProviderDegradedReason {
  const consecutiveFailures = options.healthConsecutiveFailures ?? 0
  if (consecutiveFailures > 0) return 'recent_failures'
  if (consecutiveFailures < 0) return 'recovering'
  if (
    options.healthSuccessRate === 100
    && (options.healthAverageLatencyMs ?? 0) > 0
  ) {
    return 'slow_response'
  }
  return 'unstable'
}

export function resolveProviderConnectivityStatus(options: {
  routingEnabled: boolean
  runtimeStatus?: 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | null
  latestProbe?: ProviderLatestProbe | null
}): ProviderConnectivityDisplayStatus {
  if (!options.routingEnabled) return 'paused'

  if (options.latestProbe?.type === 'success') return 'healthy'
  if (options.latestProbe?.type === 'error') return 'unhealthy'

  switch (options.runtimeStatus) {
    case 'healthy':
      return 'healthy'
    case 'degraded':
      return 'degraded'
    case 'unhealthy':
      return 'unhealthy'
    default:
      return 'unknown'
  }
}
