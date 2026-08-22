import React from 'react'

export type RuntimeReporterOwnerStrategy = 'active-pane' | 'visible-pane' | 'recent-update' | 'none'

export interface RuntimeReporterHostMetaBase {
  isPaneActive: boolean
  isVisible: boolean
  isLoading: boolean
  hasError: boolean
}

export interface RuntimeReporterHostState<Meta extends RuntimeReporterHostMetaBase> {
  instanceId: string
  meta: Meta
  registeredAt: number
  metaUpdatedAt: number
}

export interface HostBoundRuntimeReporterHostState<
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
> extends RuntimeReporterHostState<Meta> {
  metrics: Metrics | null
  metricsUpdatedAt: number
}

export interface RuntimeReporterMetricState<Metrics extends { updatedAt: number }> {
  key: string
  metrics: Metrics
  updatedAt: number
}

interface CreateHostBoundRuntimeReporterOptions<
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
  Snapshot,
> {
  defaultMeta: Meta
  mergeMeta: (prev: Meta, next: Partial<Meta>) => Meta
  deriveSnapshot: (
    hostStates: Array<HostBoundRuntimeReporterHostState<Meta, Metrics>>,
  ) => Snapshot | null
}

interface CreateKeyedRuntimeReporterOptions<
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
  Snapshot,
> {
  defaultMeta: Meta
  mergeMeta: (prev: Meta, next: Partial<Meta>) => Meta
  normalizeMetricKey: (value: string | null | undefined) => string | null
  getMetricKeyFromMeta: (meta: Meta) => string | null
  deriveSnapshot: (
    hostStates: Array<RuntimeReporterHostState<Meta>>,
    metricsByKey: Map<string, RuntimeReporterMetricState<Metrics>>,
  ) => Snapshot | null
}

export const createRuntimeMonitorInstanceId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const getRuntimeOwnerStrategy = (
  meta: RuntimeReporterHostMetaBase,
): RuntimeReporterOwnerStrategy => {
  if (meta.isPaneActive) return 'active-pane'
  if (meta.isVisible) return 'visible-pane'
  if (meta.isLoading || meta.hasError) return 'none'
  return 'recent-update'
}

export const getRuntimeHostActivityScore = (
  meta: RuntimeReporterHostMetaBase,
  hasMetrics: boolean,
): number => {
  let score = 0
  if (meta.isPaneActive) score += 100
  if (meta.isVisible) score += 20
  if (!meta.isLoading) score += 4
  if (!meta.hasError) score += 2
  if (hasMetrics) score += 1
  return score
}

export const countVisibleRuntimeHosts = <Meta extends RuntimeReporterHostMetaBase>(
  hostStates: Array<RuntimeReporterHostState<Meta>>,
): number => {
  return hostStates.filter((host) => host.meta.isVisible).length
}

export const countActivePaneRuntimeHosts = <Meta extends RuntimeReporterHostMetaBase>(
  hostStates: Array<RuntimeReporterHostState<Meta>>,
): number => {
  return hostStates.filter((host) => host.meta.isPaneActive).length
}

export const selectMostRecentRuntimeMetricsHost = <
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
>(
  hostStates: Array<HostBoundRuntimeReporterHostState<Meta, Metrics>>,
): HostBoundRuntimeReporterHostState<Meta, Metrics> | null => {
  return hostStates
    .filter((host) => host.metrics)
    .sort((left, right) => right.metricsUpdatedAt - left.metricsUpdatedAt)[0] ?? null
}

export function createHostBoundRuntimeReporter<
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
  Snapshot,
>(
  options: CreateHostBoundRuntimeReporterOptions<Meta, Metrics, Snapshot>,
) {
  const listeners = new Set<() => void>()
  const hosts = new Map<string, HostBoundRuntimeReporterHostState<Meta, Metrics>>()
  let cachedSnapshot: Snapshot | null = null

  const emitChange = (): void => {
    cachedSnapshot = options.deriveSnapshot(Array.from(hosts.values()))
    listeners.forEach((listener) => listener())
  }

  const getOrCreateHost = (
    instanceId: string,
  ): HostBoundRuntimeReporterHostState<Meta, Metrics> => {
    const existing = hosts.get(instanceId)
    if (existing) return existing

    const now = Date.now()
    const created: HostBoundRuntimeReporterHostState<Meta, Metrics> = {
      instanceId,
      meta: { ...options.defaultMeta },
      metrics: null,
      registeredAt: now,
      metaUpdatedAt: now,
      metricsUpdatedAt: 0,
    }
    hosts.set(instanceId, created)
    return created
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const getSnapshot = (): Snapshot | null => cachedSnapshot

  return {
    registerHost(instanceId: string, meta: Partial<Meta> = {}): void {
      const host = getOrCreateHost(instanceId)
      host.meta = options.mergeMeta(host.meta, meta)
      host.metaUpdatedAt = Date.now()
      emitChange()
    },
    updateHost(instanceId: string, meta: Partial<Meta>): void {
      const host = getOrCreateHost(instanceId)
      host.meta = options.mergeMeta(host.meta, meta)
      host.metaUpdatedAt = Date.now()
      emitChange()
    },
    publishMetrics(instanceId: string, metrics: Metrics | null): void {
      const host = getOrCreateHost(instanceId)
      host.metrics = metrics
      host.metricsUpdatedAt = metrics?.updatedAt ?? Date.now()
      emitChange()
    },
    unregisterHost(instanceId: string): void {
      if (!hosts.delete(instanceId)) return
      emitChange()
    },
    subscribe,
    getSnapshot,
    useSnapshot(): Snapshot | null {
      return React.useSyncExternalStore(
        subscribe,
        getSnapshot,
        () => null,
      )
    },
  }
}

export function createKeyedRuntimeReporter<
  Meta extends RuntimeReporterHostMetaBase,
  Metrics extends { updatedAt: number },
  Snapshot,
>(
  options: CreateKeyedRuntimeReporterOptions<Meta, Metrics, Snapshot>,
) {
  const listeners = new Set<() => void>()
  const hosts = new Map<string, RuntimeReporterHostState<Meta>>()
  const metricsByKey = new Map<string, RuntimeReporterMetricState<Metrics>>()
  let cachedSnapshot: Snapshot | null = null

  const cleanupOrphanedMetrics = (rawKey: string | null | undefined): void => {
    const normalizedKey = options.normalizeMetricKey(rawKey)
    if (!normalizedKey) return
    const stillMounted = Array.from(hosts.values()).some((host) => {
      return options.getMetricKeyFromMeta(host.meta) === normalizedKey
    })
    if (!stillMounted) {
      metricsByKey.delete(normalizedKey)
    }
  }

  const emitChange = (): void => {
    cachedSnapshot = options.deriveSnapshot(Array.from(hosts.values()), metricsByKey)
    listeners.forEach((listener) => listener())
  }

  const getOrCreateHost = (instanceId: string): RuntimeReporterHostState<Meta> => {
    const existing = hosts.get(instanceId)
    if (existing) return existing

    const now = Date.now()
    const created: RuntimeReporterHostState<Meta> = {
      instanceId,
      meta: { ...options.defaultMeta },
      registeredAt: now,
      metaUpdatedAt: now,
    }
    hosts.set(instanceId, created)
    return created
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const getSnapshot = (): Snapshot | null => cachedSnapshot

  return {
    registerHost(instanceId: string, meta: Partial<Meta> = {}): void {
      const host = getOrCreateHost(instanceId)
      host.meta = options.mergeMeta(host.meta, meta)
      host.metaUpdatedAt = Date.now()
      emitChange()
    },
    updateHost(instanceId: string, meta: Partial<Meta>): void {
      const host = getOrCreateHost(instanceId)
      const previousMetricKey = options.getMetricKeyFromMeta(host.meta)
      host.meta = options.mergeMeta(host.meta, meta)
      host.metaUpdatedAt = Date.now()
      if (previousMetricKey !== options.getMetricKeyFromMeta(host.meta)) {
        cleanupOrphanedMetrics(previousMetricKey)
      }
      emitChange()
    },
    publishMetrics(metricKey: string | null | undefined, metrics: Metrics | null): void {
      const normalizedMetricKey = options.normalizeMetricKey(metricKey)
      if (!normalizedMetricKey) return

      if (!metrics) {
        metricsByKey.delete(normalizedMetricKey)
        emitChange()
        return
      }

      metricsByKey.set(normalizedMetricKey, {
        key: normalizedMetricKey,
        metrics,
        updatedAt: metrics.updatedAt,
      })
      emitChange()
    },
    unregisterHost(instanceId: string): void {
      const host = hosts.get(instanceId)
      if (!host) return
      hosts.delete(instanceId)
      cleanupOrphanedMetrics(options.getMetricKeyFromMeta(host.meta))
      emitChange()
    },
    subscribe,
    getSnapshot,
    useSnapshot(): Snapshot | null {
      return React.useSyncExternalStore(
        subscribe,
        getSnapshot,
        () => null,
      )
    },
  }
}
