import React from 'react'
import type {
  ResourceMonitorSnapshot,
  ResourceMonitorSnapshotMode,
} from '@shared/types/resource-monitor'
import { registerResetAction } from '@/stores/sessionResetRegistry'

const MAX_HISTORY_AGE_MS = 30 * 60 * 1000
const MAX_HISTORY_SAMPLES = 120
const TREND_WINDOW_MS = 5 * 60 * 1000
const STALE_MULTIPLIER = 3
const MAX_GOVERNANCE_HISTORY_AGE_MS = 30 * 60 * 1000
const MAX_GOVERNANCE_EVENTS = 12

const POLL_INTERVAL_MS: Record<ResourceMonitorSnapshotMode, number> = {
  interactive: 2000,
  idle: 15000,
}

const MEMORY_TREND_MIN_DELTA_BYTES = 64 * 1024 * 1024
const CPU_TREND_MIN_DELTA = 15
const TREND_MIN_DELTA_PERCENT = 5

export interface ResourceMonitorHistorySample {
  collectedAt: number
  totalCpu: number
  totalMemory: number
  ramSharePercent: number
  hostUsedMemoryPercent: number
  browserCpu: number
  browserMemory: number
  browserViewCount: number
  detachedBrowserViewCount: number
  previewBrowserViewCount: number
  loadingBrowserViewCount: number
  ptySessionCount: number
  activeRuns: number
}

export type ResourceMonitorTrendDirection = 'up' | 'down' | 'steady' | 'insufficient'

export interface ResourceMonitorHistoryTrendSummary {
  direction: ResourceMonitorTrendDirection
  sampleCount: number
  from: number | null
  to: number | null
  delta: number | null
  deltaPercent: number | null
}

export interface ResourceMonitorBrowserHistorySummary {
  sampleCount: number
  from: number | null
  to: number | null
  memoryDelta: number | null
  cpuDelta: number | null
  viewCountDelta: number | null
  detachedCountDelta: number | null
  previewCountDelta: number | null
  loadingCountDelta: number | null
}

export interface ResourceMonitorHistoryState {
  samples: ResourceMonitorHistorySample[]
  latest: ResourceMonitorHistorySample | null
  sampleCount: number
  windowMs: number
  staleThresholdMs: number
  stale: boolean
  staleMs: number | null
  lastSuccessfulAt: number | null
  memoryTrend: ResourceMonitorHistoryTrendSummary
  cpuTrend: ResourceMonitorHistoryTrendSummary
  browserMemoryTrend: ResourceMonitorHistoryTrendSummary
  browserCpuTrend: ResourceMonitorHistoryTrendSummary
  browserSummary: ResourceMonitorBrowserHistorySummary
}

export interface ResourceMonitorGovernanceFeedbackItem {
  title: string
  reason: string
  error?: string | null
}

export interface ResourceMonitorGovernanceEvent {
  kind: 'browser-close'
  at: number
  attemptedCount: number
  succeeded: ResourceMonitorGovernanceFeedbackItem[]
  failed: ResourceMonitorGovernanceFeedbackItem[]
}

interface TrendMetricConfig {
  minimumDelta: number
  minimumDeltaPercent: number
}

interface ReduceHistoryOptions {
  now?: number
  maxAgeMs?: number
  maxSamples?: number
}

interface DeriveHistoryOptions {
  now?: number
  maxAgeMs?: number
  maxSamples?: number
  windowMs?: number
  staleThresholdMs?: number
}

const listeners = new Set<() => void>()
const governanceListeners = new Set<() => void>()
let historySamples: ResourceMonitorHistorySample[] = []
let governanceEvents: ResourceMonitorGovernanceEvent[] = []

const clampPositive = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

const createEmptyTrend = (): ResourceMonitorHistoryTrendSummary => ({
  direction: 'insufficient',
  sampleCount: 0,
  from: null,
  to: null,
  delta: null,
  deltaPercent: null,
})

const createEmptyBrowserSummary = (): ResourceMonitorBrowserHistorySummary => ({
  sampleCount: 0,
  from: null,
  to: null,
  memoryDelta: null,
  cpuDelta: null,
  viewCountDelta: null,
  detachedCountDelta: null,
  previewCountDelta: null,
  loadingCountDelta: null,
})

const normalizeSample = (
  sample: ResourceMonitorHistorySample,
): ResourceMonitorHistorySample => ({
  collectedAt: Number.isFinite(sample.collectedAt) ? sample.collectedAt : 0,
  totalCpu: clampPositive(sample.totalCpu),
  totalMemory: clampPositive(sample.totalMemory),
  ramSharePercent: clampPositive(sample.ramSharePercent),
  hostUsedMemoryPercent: clampPositive(sample.hostUsedMemoryPercent),
  browserCpu: clampPositive(sample.browserCpu),
  browserMemory: clampPositive(sample.browserMemory),
  browserViewCount: clampPositive(sample.browserViewCount),
  detachedBrowserViewCount: clampPositive(sample.detachedBrowserViewCount),
  previewBrowserViewCount: clampPositive(sample.previewBrowserViewCount),
  loadingBrowserViewCount: clampPositive(sample.loadingBrowserViewCount),
  ptySessionCount: clampPositive(sample.ptySessionCount),
  activeRuns: clampPositive(sample.activeRuns),
})

const areSamplesEqual = (
  left: ResourceMonitorHistorySample[],
  right: ResourceMonitorHistorySample[],
): boolean => {
  if (left.length !== right.length) return false
  return left.every((sample, index) => {
    const other = right[index]
    if (!other) return false
    return sample.collectedAt === other.collectedAt
      && sample.totalCpu === other.totalCpu
      && sample.totalMemory === other.totalMemory
      && sample.ramSharePercent === other.ramSharePercent
      && sample.hostUsedMemoryPercent === other.hostUsedMemoryPercent
      && sample.browserCpu === other.browserCpu
      && sample.browserMemory === other.browserMemory
      && sample.browserViewCount === other.browserViewCount
      && sample.detachedBrowserViewCount === other.detachedBrowserViewCount
      && sample.previewBrowserViewCount === other.previewBrowserViewCount
      && sample.loadingBrowserViewCount === other.loadingBrowserViewCount
      && sample.ptySessionCount === other.ptySessionCount
      && sample.activeRuns === other.activeRuns
  })
}

export const summarizeResourceMonitorSnapshot = (
  snapshot: ResourceMonitorSnapshot,
): ResourceMonitorHistorySample => {
  const browserCpu = clampPositive(snapshot.browserViews.reduce((sum, view) => sum + view.cpu, 0))
  const browserMemory = clampPositive(snapshot.browserViews.reduce((sum, view) => sum + view.memory, 0))
  return {
    collectedAt: Number.isFinite(snapshot.collectedAt) ? snapshot.collectedAt : Date.now(),
    totalCpu: clampPositive(snapshot.totalCpu),
    totalMemory: clampPositive(snapshot.totalMemory),
    ramSharePercent: snapshot.host.totalMemory > 0
      ? clampPositive((snapshot.totalMemory / snapshot.host.totalMemory) * 100)
      : 0,
    hostUsedMemoryPercent: clampPositive(snapshot.host.memoryUsagePercent),
    browserCpu,
    browserMemory,
    browserViewCount: clampPositive(snapshot.browserViews.length),
    detachedBrowserViewCount: clampPositive(snapshot.browserViews.filter((view) => !view.attachedToMainWindow).length),
    previewBrowserViewCount: clampPositive(snapshot.browserViews.filter((view) => view.isPreview).length),
    loadingBrowserViewCount: clampPositive(snapshot.browserViews.filter((view) => view.isLoading).length),
    ptySessionCount: clampPositive(snapshot.ptySessions.length),
    activeRuns: clampPositive(snapshot.runSummary.activeRuns),
  }
}

export const pruneResourceMonitorHistorySamples = (
  samples: ResourceMonitorHistorySample[],
  options: ReduceHistoryOptions = {},
): ResourceMonitorHistorySample[] => {
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? MAX_HISTORY_AGE_MS
  const maxSamples = options.maxSamples ?? MAX_HISTORY_SAMPLES
  const cutoff = now - maxAgeMs

  return samples
    .map(normalizeSample)
    .filter((sample) => sample.collectedAt > 0 && sample.collectedAt >= cutoff)
    .sort((left, right) => left.collectedAt - right.collectedAt)
    .slice(-maxSamples)
}

export const reduceResourceMonitorHistory = (
  samples: ResourceMonitorHistorySample[],
  snapshot: ResourceMonitorSnapshot,
  options: ReduceHistoryOptions = {},
): ResourceMonitorHistorySample[] => {
  const nextSample = summarizeResourceMonitorSnapshot(snapshot)
  const merged = samples.filter((sample) => sample.collectedAt !== nextSample.collectedAt)
  merged.push(nextSample)
  return pruneResourceMonitorHistorySamples(merged, {
    now: Math.max(options.now ?? Date.now(), nextSample.collectedAt),
    maxAgeMs: options.maxAgeMs,
    maxSamples: options.maxSamples,
  })
}

const buildTrendSummary = (
  samples: ResourceMonitorHistorySample[],
  selectValue: (sample: ResourceMonitorHistorySample) => number,
  config: TrendMetricConfig,
  windowMs: number,
): ResourceMonitorHistoryTrendSummary => {
  const latest = samples.at(-1)
  if (!latest) return createEmptyTrend()

  const windowStart = latest.collectedAt - windowMs
  const windowSamples = samples.filter((sample) => sample.collectedAt >= windowStart)
  if (windowSamples.length < 2) {
    return {
      ...createEmptyTrend(),
      sampleCount: windowSamples.length,
    }
  }

  const first = windowSamples[0]
  const last = windowSamples[windowSamples.length - 1]
  const from = clampPositive(selectValue(first))
  const to = clampPositive(selectValue(last))
  const delta = to - from
  const deltaPercent = from > 0 ? (delta / from) * 100 : (to > 0 ? 100 : 0)
  const normalizedDeltaPercent = Number.isFinite(deltaPercent) ? deltaPercent : null

  const isMeaningfulChange = Math.abs(delta) >= config.minimumDelta
    || Math.abs(normalizedDeltaPercent ?? 0) >= config.minimumDeltaPercent

  let direction: ResourceMonitorTrendDirection = 'steady'
  if (isMeaningfulChange) {
    direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'steady'
  }

  return {
    direction,
    sampleCount: windowSamples.length,
    from,
    to,
    delta,
    deltaPercent: normalizedDeltaPercent,
  }
}

const selectWindowSamples = (
  samples: ResourceMonitorHistorySample[],
  windowMs: number,
): ResourceMonitorHistorySample[] => {
  const latest = samples.at(-1)
  if (!latest) return []
  const windowStart = latest.collectedAt - windowMs
  return samples.filter((sample) => sample.collectedAt >= windowStart)
}

const buildBrowserSummary = (
  samples: ResourceMonitorHistorySample[],
  windowMs: number,
): ResourceMonitorBrowserHistorySummary => {
  const windowSamples = selectWindowSamples(samples, windowMs)
  if (windowSamples.length < 2) {
    return {
      ...createEmptyBrowserSummary(),
      sampleCount: windowSamples.length,
    }
  }

  const first = windowSamples[0]
  const last = windowSamples[windowSamples.length - 1]
  return {
    sampleCount: windowSamples.length,
    from: first.collectedAt,
    to: last.collectedAt,
    memoryDelta: last.browserMemory - first.browserMemory,
    cpuDelta: last.browserCpu - first.browserCpu,
    viewCountDelta: last.browserViewCount - first.browserViewCount,
    detachedCountDelta: last.detachedBrowserViewCount - first.detachedBrowserViewCount,
    previewCountDelta: last.previewBrowserViewCount - first.previewBrowserViewCount,
    loadingCountDelta: last.loadingBrowserViewCount - first.loadingBrowserViewCount,
  }
}

export const deriveResourceMonitorHistoryState = (
  samples: ResourceMonitorHistorySample[],
  options: DeriveHistoryOptions = {},
): ResourceMonitorHistoryState => {
  const now = options.now ?? Date.now()
  const normalizedSamples = pruneResourceMonitorHistorySamples(samples, {
    now,
    maxAgeMs: options.maxAgeMs,
    maxSamples: options.maxSamples,
  })
  const latest = normalizedSamples.at(-1) ?? null
  const staleThresholdMs = options.staleThresholdMs ?? POLL_INTERVAL_MS.idle * STALE_MULTIPLIER
  const staleMs = latest ? Math.max(0, now - latest.collectedAt) : null
  const windowMs = options.windowMs ?? TREND_WINDOW_MS

  return {
    samples: normalizedSamples,
    latest,
    sampleCount: normalizedSamples.length,
    windowMs,
    staleThresholdMs,
    stale: staleMs !== null && staleMs > staleThresholdMs,
    staleMs,
    lastSuccessfulAt: latest?.collectedAt ?? null,
    memoryTrend: buildTrendSummary(
      normalizedSamples,
      (sample) => sample.totalMemory,
      {
        minimumDelta: MEMORY_TREND_MIN_DELTA_BYTES,
        minimumDeltaPercent: TREND_MIN_DELTA_PERCENT,
      },
      windowMs,
    ),
    cpuTrend: buildTrendSummary(
      normalizedSamples,
      (sample) => sample.totalCpu,
      {
        minimumDelta: CPU_TREND_MIN_DELTA,
        minimumDeltaPercent: TREND_MIN_DELTA_PERCENT,
      },
      windowMs,
    ),
    browserMemoryTrend: buildTrendSummary(
      normalizedSamples,
      (sample) => sample.browserMemory,
      {
        minimumDelta: MEMORY_TREND_MIN_DELTA_BYTES,
        minimumDeltaPercent: TREND_MIN_DELTA_PERCENT,
      },
      windowMs,
    ),
    browserCpuTrend: buildTrendSummary(
      normalizedSamples,
      (sample) => sample.browserCpu,
      {
        minimumDelta: CPU_TREND_MIN_DELTA,
        minimumDeltaPercent: TREND_MIN_DELTA_PERCENT,
      },
      windowMs,
    ),
    browserSummary: buildBrowserSummary(normalizedSamples, windowMs),
  }
}

const emitChange = (): void => {
  listeners.forEach((listener) => listener())
}

const emitGovernanceChange = (): void => {
  governanceListeners.forEach((listener) => listener())
}

export const recordResourceMonitorHistorySnapshot = (
  snapshot: ResourceMonitorSnapshot,
): void => {
  const nextSamples = reduceResourceMonitorHistory(historySamples, snapshot)
  if (areSamplesEqual(historySamples, nextSamples)) return
  historySamples = nextSamples
  emitChange()
}

export const clearResourceMonitorHistory = (): void => {
  historySamples = []
  emitChange()
}

registerResetAction('resource-monitor-history', 'reset', clearResourceMonitorHistory)

const pruneResourceMonitorGovernanceEvents = (
  events: ResourceMonitorGovernanceEvent[],
  now: number = Date.now(),
): ResourceMonitorGovernanceEvent[] => {
  const cutoff = now - MAX_GOVERNANCE_HISTORY_AGE_MS
  return events
    .filter((event) => event.at >= cutoff)
    .sort((left, right) => left.at - right.at)
    .slice(-MAX_GOVERNANCE_EVENTS)
}

export const recordResourceMonitorGovernanceEvent = (
  event: ResourceMonitorGovernanceEvent,
): void => {
  governanceEvents = pruneResourceMonitorGovernanceEvents([...governanceEvents, event], event.at)
  emitGovernanceChange()
}

export const clearResourceMonitorGovernanceHistory = (): void => {
  governanceEvents = []
  emitGovernanceChange()
}

registerResetAction('resource-monitor-governance-history', 'reset', clearResourceMonitorGovernanceHistory)

export const subscribeResourceMonitorHistory = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const subscribeResourceMonitorGovernanceHistory = (listener: () => void): (() => void) => {
  governanceListeners.add(listener)
  return () => {
    governanceListeners.delete(listener)
  }
}

export const getResourceMonitorHistorySamples = (): ResourceMonitorHistorySample[] => {
  return historySamples
}

export const getResourceMonitorGovernanceEvents = (): ResourceMonitorGovernanceEvent[] => {
  return governanceEvents
}

export const useResourceMonitorHistory = (
  mode: ResourceMonitorSnapshotMode,
): ResourceMonitorHistoryState => {
  const samples = React.useSyncExternalStore(
    subscribeResourceMonitorHistory,
    getResourceMonitorHistorySamples,
    () => [],
  )

  return React.useMemo(() => {
    return deriveResourceMonitorHistoryState(samples, {
      now: Date.now(),
      staleThresholdMs: POLL_INTERVAL_MS[mode] * STALE_MULTIPLIER,
    })
  }, [samples, mode])
}

export const useResourceMonitorGovernanceHistory = (): ResourceMonitorGovernanceEvent[] => {
  return React.useSyncExternalStore(
    subscribeResourceMonitorGovernanceHistory,
    getResourceMonitorGovernanceEvents,
    () => [],
  )
}
