import { describe, expect, it } from 'vitest'
import {
  createHostBoundRuntimeReporter,
  createKeyedRuntimeReporter,
  getRuntimeHostActivityScore,
  getRuntimeOwnerStrategy,
  type RuntimeReporterHostMetaBase,
} from './runtime-reporter'

interface TestMeta extends RuntimeReporterHostMetaBase {
  resourceId: string | null
  title: string | null
}

interface TestMetrics {
  value: number
  updatedAt: number
}

const DEFAULT_META: TestMeta = {
  resourceId: null,
  title: null,
  isPaneActive: false,
  isVisible: false,
  isLoading: false,
  hasError: false,
}

const mergeMeta = (prev: TestMeta, next: Partial<TestMeta>): TestMeta => ({
  resourceId: next.resourceId ?? prev.resourceId,
  title: next.title ?? prev.title,
  isPaneActive: next.isPaneActive ?? prev.isPaneActive,
  isVisible: next.isVisible ?? prev.isVisible,
  isLoading: next.isLoading ?? prev.isLoading,
  hasError: next.hasError ?? prev.hasError,
})

describe('runtime-reporter', () => {
  it('host-bound reporter 会优先选择最近活跃的 host', () => {
    const reporter = createHostBoundRuntimeReporter<TestMeta, TestMetrics, {
      ownerId: string | null
      ownerStrategy: string | null
      metricsValue: number | null
    }>({
      defaultMeta: DEFAULT_META,
      mergeMeta,
      deriveSnapshot: (hostStates) => {
        if (hostStates.length === 0) return null
        const ordered = [...hostStates].sort((left, right) => {
          const leftScore = getRuntimeHostActivityScore(left.meta, Boolean(left.metrics))
          const rightScore = getRuntimeHostActivityScore(right.meta, Boolean(right.metrics))
          if (rightScore !== leftScore) return rightScore - leftScore
          return right.metricsUpdatedAt - left.metricsUpdatedAt
        })
        const owner = ordered[0]!
        return {
          ownerId: owner.meta.resourceId,
          ownerStrategy: getRuntimeOwnerStrategy(owner.meta),
          metricsValue: owner.metrics?.value ?? null,
        }
      },
    })

    reporter.registerHost('host-hidden', {
      resourceId: 'hidden',
      isVisible: false,
    })
    reporter.publishMetrics('host-hidden', {
      value: 10,
      updatedAt: 10,
    })

    reporter.registerHost('host-active', {
      resourceId: 'active',
      isPaneActive: true,
      isVisible: true,
    })
    reporter.publishMetrics('host-active', {
      value: 20,
      updatedAt: 20,
    })

    expect(reporter.getSnapshot()).toEqual({
      ownerId: 'active',
      ownerStrategy: 'active-pane',
      metricsValue: 20,
    })
  })

  it('getRuntimeOwnerStrategy 在 isLoading 时返回 none', () => {
    expect(getRuntimeOwnerStrategy({
      isPaneActive: false,
      isVisible: false,
      isLoading: true,
      hasError: false,
    })).toBe('none')
  })

  it('getRuntimeOwnerStrategy 在 hasError 时返回 none', () => {
    expect(getRuntimeOwnerStrategy({
      isPaneActive: false,
      isVisible: false,
      isLoading: false,
      hasError: true,
    })).toBe('none')
  })

  it('getRuntimeOwnerStrategy 在 isLoading+isVisible 时优先返回 visible-pane', () => {
    expect(getRuntimeOwnerStrategy({
      isPaneActive: false,
      isVisible: true,
      isLoading: true,
      hasError: false,
    })).toBe('visible-pane')
  })

  it('getRuntimeOwnerStrategy 正常 host 返回 recent-update', () => {
    expect(getRuntimeOwnerStrategy({
      isPaneActive: false,
      isVisible: false,
      isLoading: false,
      hasError: false,
    })).toBe('recent-update')
  })

  it('keyed reporter 会在 host 换绑或卸载时清理孤儿 metrics', () => {
    const reporter = createKeyedRuntimeReporter<TestMeta, TestMetrics, {
      mountedHostCount: number
      metricKeys: string[]
    }>({
      defaultMeta: DEFAULT_META,
      mergeMeta,
      normalizeMetricKey: (value) => value?.trim() || null,
      getMetricKeyFromMeta: (meta) => meta.resourceId?.trim() || null,
      deriveSnapshot: (hostStates, metricsByKey) => ({
        mountedHostCount: hostStates.length,
        metricKeys: Array.from(metricsByKey.keys()).sort(),
      }),
    })

    reporter.registerHost('host-1', {
      resourceId: 'table-1',
      isVisible: true,
    })
    reporter.publishMetrics('table-1', {
      value: 1,
      updatedAt: 1,
    })
    expect(reporter.getSnapshot()).toEqual({
      mountedHostCount: 1,
      metricKeys: ['table-1'],
    })

    reporter.updateHost('host-1', {
      resourceId: 'table-2',
    })
    expect(reporter.getSnapshot()).toEqual({
      mountedHostCount: 1,
      metricKeys: [],
    })

    reporter.publishMetrics('table-2', {
      value: 2,
      updatedAt: 2,
    })
    reporter.unregisterHost('host-1')
    expect(reporter.getSnapshot()).toEqual({
      mountedHostCount: 0,
      metricKeys: [],
    })
  })
})
