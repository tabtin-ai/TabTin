import { describe, expect, it } from 'vitest'
import { pruneObservabilityStore } from './useTableEngineObservability'

describe('useTableEngineObservability helpers', () => {
  it('按 TTL 清理过期 bucket，并按更新时间保留最新 buckets', () => {
    const pruned = pruneObservabilityStore({
      version: 1,
      engines: {
        'canvas::table-1': {
          scrollFpsSamples: [58],
          inputLatencyMsSamples: [120],
          operationTotal: 3,
          operationErrors: 0,
          runtimeErrors: 0,
          updatedAt: 5000,
        },
        'canvas::table-2': {
          scrollFpsSamples: [48],
          inputLatencyMsSamples: [180],
          operationTotal: 4,
          operationErrors: 1,
          runtimeErrors: 0,
          updatedAt: 4000,
        },
        'canvas::table-3': {
          scrollFpsSamples: [32],
          inputLatencyMsSamples: [320],
          operationTotal: 6,
          operationErrors: 2,
          runtimeErrors: 1,
          updatedAt: 100,
        },
      },
    }, {
      now: 6000,
      ttlMs: 3000,
      maxBuckets: 2,
    })

    expect(Object.keys(pruned.engines)).toEqual([
      'canvas::table-1',
      'canvas::table-2',
    ])
  })
})
