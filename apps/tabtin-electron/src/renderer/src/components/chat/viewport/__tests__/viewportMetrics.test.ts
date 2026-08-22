import { describe, expect, it } from 'vitest'
import {
  assertViewportMetrics,
  computeViewportMetrics,
  type ConversationViewportFrame,
} from '../viewportMetrics'

const frame = (
  frameNumber: number,
  overrides: Partial<ConversationViewportFrame> = {},
): ConversationViewportFrame => ({
  ts: frameNumber * 16,
  frame: frameNumber,
  scopeKey: 'session-viewport',
  mode: 'follow-latest',
  reason: 'sample',
  source: 'unknown',
  scrollTop: 400,
  scrollHeight: 1000,
  clientHeight: 600,
  targetOffset: 400,
  followError: 0,
  writesThisFrame: 0,
  ...overrides,
})

describe('viewportMetrics', () => {
  it('computes P95 follow error and maximum writes per frame', () => {
    const frames = Array.from({ length: 20 }, (_, index) =>
      frame(index, {
        followError: index === 19 ? 8 : index % 5,
        writesThisFrame: index === 10 ? 2 : 1,
      }),
    )

    expect(computeViewportMetrics(frames)).toMatchObject({
      frameCount: 20,
      followErrorP95: 4,
      followErrorMax: 8,
      maxSingleFrameTargetError: 8,
      maxWritesPerFrame: 2,
      invalidSampleCount: 0,
    })
  })

  it('returns zeros for empty input', () => {
    expect(computeViewportMetrics([])).toEqual({
      frameCount: 0,
      followErrorP95: 0,
      followErrorMax: 0,
      maxSingleFrameTargetError: 0,
      maxWritesPerFrame: 0,
      anchorDriftMax: 0,
      modeViolations: 0,
      invalidSampleCount: 0,
      turnEndJumpMax: 0,
    })
  })

  it('computes turnEndJumpMax from follow-latest non-user turn-ended adjacent frames', () => {
    const metrics = computeViewportMetrics([
      frame(0, { reason: 'turn-ended', scrollTop: 100, followError: 0 }),
      frame(1, {
        reason: 'turn-ended',
        scrollTop: 140,
        followError: 0,
        source: 'programmatic',
      }),
    ])

    expect(metrics.turnEndJumpMax).toBe(40)
  })

  it('passes follow profile when turnEndJumpMax is 0 or at the 24px threshold', () => {
    const zeroJump = computeViewportMetrics([
      frame(0, { reason: 'turn-ended', scrollTop: 100, source: 'programmatic' }),
      frame(1, { reason: 'layout-changed', scrollTop: 100, source: 'programmatic' }),
    ])
    expect(zeroJump.turnEndJumpMax).toBe(0)
    expect(assertViewportMetrics(zeroJump, 'follow-latest')).toEqual({ ok: true })

    const atThreshold = computeViewportMetrics([
      frame(0, { reason: 'streaming-tick', scrollTop: 100, source: 'programmatic' }),
      frame(1, { reason: 'turn-ended', scrollTop: 124, source: 'programmatic' }),
    ])
    expect(atThreshold.turnEndJumpMax).toBe(24)
    expect(assertViewportMetrics(atThreshold, 'follow-latest')).toEqual({ ok: true })
  })

  it('fails follow profile when turnEndJumpMax > 24', () => {
    const metrics = computeViewportMetrics([
      frame(0, { reason: 'turn-ended', scrollTop: 100, followError: 0 }),
      frame(1, {
        reason: 'turn-ended',
        scrollTop: 140,
        followError: 0,
        source: 'programmatic',
      }),
    ])
    expect(metrics.turnEndJumpMax).toBe(40)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toMatchObject({
      ok: false,
      violations: expect.arrayContaining([
        expect.stringContaining('turnEndJumpMax'),
      ]),
    })
  })

  it('excludes non-turn, user-sourced, and non-follow modes from turnEndJumpMax', () => {
    const metrics = computeViewportMetrics([
      // non-turn pair: ignored
      frame(0, { reason: 'streaming-tick', scrollTop: 0, source: 'programmatic' }),
      frame(1, { reason: 'content-resize', scrollTop: 100, source: 'programmatic' }),
      // user source on current: ignored
      frame(2, { reason: 'turn-ended', scrollTop: 100, source: 'programmatic' }),
      frame(3, { reason: 'turn-ended', scrollTop: 200, source: 'user' }),
      // anchored-reading mode: ignored for jump metric
      frame(4, {
        mode: 'anchored-reading',
        reason: 'turn-ended',
        scrollTop: 200,
        source: 'programmatic',
      }),
      frame(5, {
        mode: 'anchored-reading',
        reason: 'turn-ended',
        scrollTop: 280,
        source: 'programmatic',
      }),
    ])

    expect(metrics.turnEndJumpMax).toBe(0)
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({ ok: true })
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({ ok: true })
  })

  it('still fails via invalidSampleCount when turn-end frames have invalid geometry', () => {
    const metrics = computeViewportMetrics([
      frame(0, { reason: 'turn-ended', scrollTop: 100, source: 'programmatic' }),
      frame(1, {
        reason: 'turn-ended',
        scrollTop: Number.NaN,
        source: 'programmatic',
      }),
    ])

    expect(metrics.invalidSampleCount).toBe(1)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: ['invalidSampleCount expected 0, received 1'],
    })
  })

  it('computes maxSingleFrameTargetError from finite non-user follow errors', () => {
    const metrics = computeViewportMetrics([
      frame(0, { followError: 7, source: 'programmatic' }),
      frame(1, { followError: 100, source: 'user' }),
      frame(2, { followError: 11, source: 'virtualizer' }),
    ])

    expect(metrics.followErrorMax).toBe(100)
    expect(metrics.maxSingleFrameTargetError).toBe(11)
  })

  it('ignores anchor drift when adjacent frames change anchor key', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 120,
      }),
      frame(1, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-2',
        anchorTop: 200,
      }),
    ])

    expect(metrics.anchorDriftMax).toBe(0)
  })

  it('counts mode violation when anchored exits without follow-latest reason', () => {
    const metrics = computeViewportMetrics([
      frame(0, { mode: 'anchored-reading', reason: 'browse-history' }),
      frame(1, { mode: 'follow-latest', reason: 'content-resize' }),
    ])

    expect(metrics.modeViolations).toBe(1)
  })

  it('counts follow source send as a mode violation because reason is the event type', () => {
    const metrics = computeViewportMetrics([
      frame(0, { mode: 'anchored-reading', reason: 'user-browse-up' }),
      frame(1, { mode: 'follow-latest', reason: 'send' }),
    ])

    expect(metrics.modeViolations).toBe(1)
  })

  it('does not count mode violation when anchored exits with follow-latest reason', () => {
    const metrics = computeViewportMetrics([
      frame(0, { mode: 'anchored-reading', reason: 'browse-history' }),
      frame(1, { mode: 'follow-latest', reason: 'follow-latest' }),
    ])

    expect(metrics.modeViolations).toBe(0)
    expect(metrics.invalidSampleCount).toBe(0)
  })

  it('fails every profile for an invalid probe mode without double-counting transitions', () => {
    const metrics = computeViewportMetrics([
      frame(0, { mode: 'anchored-reading', reason: 'user-browse-up' }),
      frame(1, { mode: 'invalid:missing', reason: 'sample' }),
      frame(2, { mode: 'follow-latest', reason: 'follow-latest' }),
    ])

    expect(metrics.invalidSampleCount).toBe(1)
    expect(metrics.modeViolations).toBe(0)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: ['invalidSampleCount expected 0, received 1'],
    })
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({
      ok: false,
      violations: ['invalidSampleCount expected 0, received 1'],
    })
  })

  it('counts an invalid mode and non-finite values in the same frame once', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        mode: 'invalid:missing',
        followError: Number.NaN,
        scrollTop: Number.POSITIVE_INFINITY,
      }),
    ])

    expect(metrics.invalidSampleCount).toBe(1)
  })

  it('passes follow profile at the design thresholds (inclusive equality)', () => {
    const metrics = computeViewportMetrics(
      Array.from({ length: 20 }, (_, index) =>
        frame(index, {
          followError: index === 19 ? 12 : 4,
          source: 'programmatic',
        }),
      ),
    )

    expect(metrics.followErrorP95).toBe(4)
    expect(metrics.maxSingleFrameTargetError).toBe(12)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({ ok: true })
  })

  it('allows a large scrollTop catch-up when target error stays within threshold', () => {
    const metrics = computeViewportMetrics([
      frame(0, { scrollTop: 100, followError: 0 }),
      frame(1, {
        scrollTop: 10_000,
        followError: 4,
        source: 'programmatic',
      }),
    ])

    expect(metrics.maxSingleFrameTargetError).toBe(4)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({ ok: true })
  })

  it('fails follow profile when a frame writes scroll twice', () => {
    const metrics = computeViewportMetrics([
      frame(0, { writesThisFrame: 2 }),
    ])

    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: ['maxWritesPerFrame expected <= 1, received 2'],
    })
  })

  it('fails follow profile above P95 and target error thresholds with exact messages', () => {
    const metrics = computeViewportMetrics(
      Array.from({ length: 20 }, (_, index) =>
        frame(index, {
          followError: index === 19 ? 13 : 5,
          source: 'programmatic',
          writesThisFrame: 1,
        }),
      ),
    )

    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: [
        'followErrorP95 expected <= 4, received 5',
        'maxSingleFrameTargetError expected <= 12, received 13',
      ],
    })
  })

  it('fails on a non-user target error above twelve even when P95 passes', () => {
    const metrics = computeViewportMetrics(
      Array.from({ length: 20 }, (_, index) =>
        frame(index, {
          followError: index === 19 ? 13 : 0,
          source: 'programmatic',
        }),
      ),
    )

    expect(metrics.followErrorP95).toBe(0)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: ['maxSingleFrameTargetError expected <= 12, received 13'],
    })
  })

  it('counts each frame with non-finite samples once and fails every profile', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        followError: Number.NaN,
        scrollTop: Number.POSITIVE_INFINITY,
        writesThisFrame: Number.NEGATIVE_INFINITY,
      }),
      frame(1, {
        targetOffset: Number.NaN,
        anchorTop: Number.POSITIVE_INFINITY,
      }),
    ])

    expect(metrics).toMatchObject({
      followErrorP95: 0,
      followErrorMax: 0,
      maxSingleFrameTargetError: 0,
      maxWritesPerFrame: 0,
      anchorDriftMax: 0,
      invalidSampleCount: 2,
    })
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({
      ok: false,
      violations: ['invalidSampleCount expected 0, received 2'],
    })
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({
      ok: false,
      violations: ['invalidSampleCount expected 0, received 2'],
    })
  })

  it('does not count undefined optional fields as invalid samples', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        followError: undefined,
        targetOffset: undefined,
        anchorTop: undefined,
      }),
    ])

    expect(metrics.invalidSampleCount).toBe(0)
    expect(assertViewportMetrics(metrics, 'follow-latest')).toEqual({ ok: true })
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({ ok: true })
  })

  it('fails anchored profile when the anchor drifts more than two pixels', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 120,
      }),
      frame(1, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 123,
      }),
    ])

    expect(metrics.anchorDriftMax).toBe(3)
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({
      ok: false,
      violations: ['anchorDriftMax expected <= 2, received 3'],
    })
  })

  it('passes anchored profile at drift equality and zero mode violations', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 120,
        writesThisFrame: 1,
      }),
      frame(1, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 122,
        writesThisFrame: 1,
      }),
    ])

    expect(metrics.anchorDriftMax).toBe(2)
    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({ ok: true })
  })

  it('fails anchored profile when modeViolations are present', () => {
    const metrics = computeViewportMetrics([
      frame(0, {
        mode: 'anchored-reading',
        anchorMessageKey: 'message-1',
        anchorTop: 120,
      }),
      frame(1, {
        mode: 'follow-latest',
        reason: 'streaming-tick',
        anchorMessageKey: 'message-1',
        anchorTop: 120,
      }),
    ])

    expect(assertViewportMetrics(metrics, 'anchored-reading')).toEqual({
      ok: false,
      violations: ['modeViolations expected 0, received 1'],
    })
  })
})
