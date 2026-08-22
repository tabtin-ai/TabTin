/**
 * 视口帧序列聚合与阈值断言（纯函数，无 DOM / React 依赖）。
 */

import type { ConversationViewportFrame } from './types'

export type ViewportMetricProfile = 'follow-latest' | 'anchored-reading'

export type ViewportMetrics = {
  frameCount: number
  followErrorP95: number
  followErrorMax: number
  maxSingleFrameTargetError: number
  maxWritesPerFrame: number
  anchorDriftMax: number
  modeViolations: number
  invalidSampleCount: number
  /** follow-latest 且非 user 写入时，turn-ended 相邻帧 |ΔscrollTop| 最大值。 */
  turnEndJumpMax: number
}

export type ViewportMetricsAssertion =
  | { ok: true }
  | { ok: false; violations: string[] }

/** P95：ceil(n * 0.95) - 1；空数组为 0。 */
function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1)
  return sorted[index] ?? 0
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function maxOrZero(values: number[]): number {
  return values.reduce((maximum, value) => Math.max(maximum, value), 0)
}

function hasInvalidSample(frame: ConversationViewportFrame): boolean {
  const requiredSamples = [
    frame.scrollTop,
    frame.scrollHeight,
    frame.clientHeight,
    frame.writesThisFrame,
  ]
  const optionalSamples = [
    frame.followError,
    frame.targetOffset,
    frame.anchorTop,
  ]

  return frame.mode.startsWith('invalid:')
    || requiredSamples.some(value => !Number.isFinite(value))
    || optionalSamples.some(value => value !== undefined && !Number.isFinite(value))
}

export function computeViewportMetrics(
  frames: ConversationViewportFrame[],
): ViewportMetrics {
  const followErrors = frames
    .map(item => item.followError)
    .filter(isFiniteNumber)
  const nonUserFollowErrors = frames
    .filter(item => item.source !== 'user')
    .map(item => item.followError)
    .filter(isFiniteNumber)
  const finiteWrites = frames
    .map(item => item.writesThisFrame)
    .filter(isFiniteNumber)

  let anchorDriftMax = 0
  let modeViolations = 0
  let turnEndJumpMax = 0

  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]!
    const current = frames[index]!

    // 锚点漂移只比较相同 anchor key 的相邻帧
    if (
      previous.anchorMessageKey
      && previous.anchorMessageKey === current.anchorMessageKey
      && isFiniteNumber(previous.anchorTop)
      && isFiniteNumber(current.anchorTop)
    ) {
      anchorDriftMax = Math.max(
        anchorDriftMax,
        Math.abs(current.anchorTop - previous.anchorTop),
      )
    }

    // 仅统计两个正常产品模式之间的非法切换。invalid:* 由
    // invalidSampleCount 统一归因，避免同一探针解析错误重复报 mode violation。
    if (
      previous.mode === 'anchored-reading'
      && current.mode === 'follow-latest'
      && current.reason !== 'follow-latest'
    ) {
      modeViolations += 1
    }

    // turn-end 跳变：follow-latest、当前非 user，且相邻帧任一 reason 为 turn-ended。
    // 非法几何仍由 invalidSampleCount 单独失败，这里只在有限 scrollTop 上取 max。
    if (
      current.mode === 'follow-latest'
      && current.source !== 'user'
      && (previous.reason === 'turn-ended' || current.reason === 'turn-ended')
      && isFiniteNumber(previous.scrollTop)
      && isFiniteNumber(current.scrollTop)
    ) {
      turnEndJumpMax = Math.max(
        turnEndJumpMax,
        Math.abs(current.scrollTop - previous.scrollTop),
      )
    }
  }

  return {
    frameCount: frames.length,
    followErrorP95: percentile(followErrors, 0.95),
    followErrorMax: maxOrZero(followErrors),
    maxSingleFrameTargetError: maxOrZero(nonUserFollowErrors),
    maxWritesPerFrame: maxOrZero(finiteWrites),
    anchorDriftMax,
    modeViolations,
    invalidSampleCount: frames.filter(hasInvalidSample).length,
    turnEndJumpMax,
  }
}

export function assertViewportMetrics(
  metrics: ViewportMetrics,
  profile: ViewportMetricProfile,
): ViewportMetricsAssertion {
  const violations: string[] = []

  if (metrics.invalidSampleCount > 0) {
    violations.push(
      `invalidSampleCount expected 0, received ${metrics.invalidSampleCount}`,
    )
  }

  if (metrics.maxWritesPerFrame > 1) {
    violations.push(
      `maxWritesPerFrame expected <= 1, received ${metrics.maxWritesPerFrame}`,
    )
  }

  if (profile === 'follow-latest') {
    if (metrics.followErrorP95 > 4) {
      violations.push(
        `followErrorP95 expected <= 4, received ${metrics.followErrorP95}`,
      )
    }
    if (metrics.maxSingleFrameTargetError > 12) {
      violations.push(
        `maxSingleFrameTargetError expected <= 12, received ${metrics.maxSingleFrameTargetError}`,
      )
    }
    if (metrics.turnEndJumpMax > 24) {
      violations.push(
        `turnEndJumpMax expected <= 24, received ${metrics.turnEndJumpMax}`,
      )
    }
  } else {
    if (metrics.anchorDriftMax > 2) {
      violations.push(
        `anchorDriftMax expected <= 2, received ${metrics.anchorDriftMax}`,
      )
    }
    if (metrics.modeViolations > 0) {
      violations.push(
        `modeViolations expected 0, received ${metrics.modeViolations}`,
      )
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

export type { ConversationViewportFrame } from './types'
