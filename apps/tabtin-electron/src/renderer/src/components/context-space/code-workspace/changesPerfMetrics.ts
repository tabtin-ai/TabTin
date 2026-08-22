/**
 * Changes / 连续 Diff 开发态性能埋点。
 * 仅 DEV 且未关闭 VITE_DEBUG_LOGS 时打 console；始终暴露到 window 供探针读取。
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('ChangesPerf')
const isDev = import.meta.env.DEV
const enabled = isDev && import.meta.env.VITE_DEBUG_LOGS !== 'false'

export interface ChangesPerfSnapshot {
  monacoMounts: number
  monacoActive: number
  monacoMountsByPath: Record<string, number>
  monacoDisposesByPath: Record<string, number>
  /** 连续审阅静态 Diff 区块：当前活跃数（视口预算内） */
  staticBlocksActive: number
  staticBlocksMounted: number
  activeTransitionsByPath: Record<string, number>
  activeSinceByPath: Record<string, number>
  lastStableDurationByPath: Record<string, number>
  fullStatusCalls: number
  getStatusCalls: number
  rawDiffCalls: number
  showFileCalls: number
  readPreviewCalls: number
  loadDataCalls: number
  loadDataTotalMs: number
  lastOpenAt: number | null
  lastFirstDiffReadyAt: number | null
  lastStatusRevision: number
}

const metrics: ChangesPerfSnapshot = {
  monacoMounts: 0,
  monacoActive: 0,
  monacoMountsByPath: {},
  monacoDisposesByPath: {},
  staticBlocksActive: 0,
  staticBlocksMounted: 0,
  activeTransitionsByPath: {},
  activeSinceByPath: {},
  lastStableDurationByPath: {},
  fullStatusCalls: 0,
  getStatusCalls: 0,
  rawDiffCalls: 0,
  showFileCalls: 0,
  readPreviewCalls: 0,
  loadDataCalls: 0,
  loadDataTotalMs: 0,
  lastOpenAt: null,
  lastFirstDiffReadyAt: null,
  lastStatusRevision: 0,
}

function publish(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __TABTIN_CHANGES_METRICS__?: ChangesPerfSnapshot })
    .__TABTIN_CHANGES_METRICS__ = { ...metrics }
}

type NumericMetricKey = {
  [K in keyof ChangesPerfSnapshot]: ChangesPerfSnapshot[K] extends number ? K : never
}[keyof ChangesPerfSnapshot]

function bump(key: NumericMetricKey, by = 1): void {
  metrics[key] += by
  publish()
}

export function markChangesOpened(): void {
  metrics.lastOpenAt = performance.now()
  metrics.lastFirstDiffReadyAt = null
  publish()
  if (enabled) log.debug('changes opened')
}

export function markFirstDiffReady(): void {
  if (metrics.lastFirstDiffReadyAt != null) return
  metrics.lastFirstDiffReadyAt = performance.now()
  publish()
  if (enabled && metrics.lastOpenAt != null) {
    log.debug('first diff ready', {
      ttiMs: Math.round(metrics.lastFirstDiffReadyAt - metrics.lastOpenAt),
    })
  }
}

export function trackMonacoMount(filePath?: string): void {
  bump('monacoMounts')
  bump('monacoActive')
  if (filePath) {
    metrics.monacoMountsByPath[filePath] = (metrics.monacoMountsByPath[filePath] || 0) + 1
    publish()
  }
  if (enabled) log.debug('monaco mount', { active: metrics.monacoActive })
}

export function trackMonacoDispose(filePath?: string): void {
  metrics.monacoActive = Math.max(0, metrics.monacoActive - 1)
  if (filePath) {
    metrics.monacoDisposesByPath[filePath] = (metrics.monacoDisposesByPath[filePath] || 0) + 1
  }
  publish()
}

export function trackPathActive(filePath: string, active: boolean): void {
  metrics.activeTransitionsByPath[filePath] = (metrics.activeTransitionsByPath[filePath] || 0) + 1
  if (active) {
    metrics.activeSinceByPath[filePath] = performance.now()
  } else {
    const startedAt = metrics.activeSinceByPath[filePath]
    if (startedAt !== undefined) {
      metrics.lastStableDurationByPath[filePath] = Math.max(0, performance.now() - startedAt)
      delete metrics.activeSinceByPath[filePath]
    }
  }
  publish()
}

export function trackStaticBlockMount(): void {
  bump('staticBlocksMounted')
  bump('staticBlocksActive')
  if (enabled) log.debug('static block mount', { active: metrics.staticBlocksActive })
}

export function trackStaticBlockDispose(): void {
  metrics.staticBlocksActive = Math.max(0, metrics.staticBlocksActive - 1)
  publish()
}

export function trackFullStatus(): void {
  bump('fullStatusCalls')
}

export function trackGetStatus(): void {
  bump('getStatusCalls')
}

export function trackRawDiff(): void {
  bump('rawDiffCalls')
}

export function trackShowFile(): void {
  bump('showFileCalls')
}

export function trackReadPreview(): void {
  bump('readPreviewCalls')
}

export function trackLoadData(durationMs: number): void {
  bump('loadDataCalls')
  bump('loadDataTotalMs', Math.round(durationMs))
  if (enabled) log.debug('loadData', { durationMs: Math.round(durationMs) })
}

export function trackStatusRevision(revision: number): void {
  metrics.lastStatusRevision = revision
  publish()
}

export function getChangesPerfSnapshot(): ChangesPerfSnapshot {
  return { ...metrics }
}

export function resetChangesPerfMetrics(): void {
  metrics.monacoMounts = 0
  metrics.monacoActive = 0
  metrics.monacoMountsByPath = {}
  metrics.monacoDisposesByPath = {}
  metrics.staticBlocksActive = 0
  metrics.staticBlocksMounted = 0
  metrics.activeTransitionsByPath = {}
  metrics.activeSinceByPath = {}
  metrics.lastStableDurationByPath = {}
  metrics.fullStatusCalls = 0
  metrics.getStatusCalls = 0
  metrics.rawDiffCalls = 0
  metrics.showFileCalls = 0
  metrics.readPreviewCalls = 0
  metrics.loadDataCalls = 0
  metrics.loadDataTotalMs = 0
  metrics.lastOpenAt = null
  metrics.lastFirstDiffReadyAt = null
  metrics.lastStatusRevision = 0
  publish()
}

publish()
