import { describe, expect, it } from 'vitest'
import {
  resolveProviderConnectivityStatus,
  resolveProviderDegradedReason,
} from './providerConnectivityStatus'

describe('resolveProviderConnectivityStatus ', () => {
  it('shows paused when routing is disabled', () => {
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: false,
        runtimeStatus: 'healthy',
        latestProbe: { type: 'success' },
      }),
    ).toBe('paused')
  })

  it('prefers latest probe failure over stale healthy runtime_status', () => {
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: true,
        runtimeStatus: 'healthy',
        latestProbe: { type: 'error' },
      }),
    ).toBe('unhealthy')
  })

  it('prefers latest probe success over stale unhealthy runtime_status', () => {
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: true,
        runtimeStatus: 'unhealthy',
        latestProbe: { type: 'success' },
      }),
    ).toBe('healthy')
  })

  it('falls back to runtime_status when no probe result', () => {
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: true,
        runtimeStatus: 'degraded',
      }),
    ).toBe('degraded')
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: true,
        runtimeStatus: 'healthy',
      }),
    ).toBe('healthy')
    expect(
      resolveProviderConnectivityStatus({
        routingEnabled: true,
        runtimeStatus: 'unknown',
      }),
    ).toBe('unknown')
  })
})

describe('resolveProviderDegradedReason ', () => {
  it('reports slow response instead of a failure when every check succeeded', () => {
    expect(
      resolveProviderDegradedReason({
        healthSuccessRate: 100,
        healthAverageLatencyMs: 6532,
        healthConsecutiveFailures: 0,
      }),
    ).toBe('slow_response')
  })

  it('keeps recent failures and recovery observation distinguishable', () => {
    expect(
      resolveProviderDegradedReason({
        healthSuccessRate: 90.91,
        healthAverageLatencyMs: 120,
        healthConsecutiveFailures: 1,
      }),
    ).toBe('recent_failures')
    expect(
      resolveProviderDegradedReason({
        healthSuccessRate: 90.91,
        healthAverageLatencyMs: 120,
        healthConsecutiveFailures: -1,
      }),
    ).toBe('recovering')
  })
})
