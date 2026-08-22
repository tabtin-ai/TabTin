import { describe, expect, it } from 'vitest'

import {
  allocateRecordPositions,
  compareRecordPositions,
  effectiveRecordPosition,
  legacyToPositionId,
  isValidRecordPositionId,
  MAX_RECORD_POSITION_KEY_LENGTH,
  parseRecordPositionKey,
  projectLegacyPosition,
  type PositionableRecord,
} from '../record-position'

describe('record PositionId', () => {
  it('lifts mixed legacy values into one deterministic, ordered, unique space', () => {
    const records: PositionableRecord[] = [
      { recordId: 'z', legacyPosition: 'b0I' },
      { recordId: 'a', legacyPosition: 'b0I' },
      { recordId: 'number-2', legacyPosition: 2 },
      { recordId: 'number-1', legacyPosition: 1 },
    ]
    const before = structuredClone(records)

    const ordered = records.slice().sort(compareRecordPositions)

    expect(ordered.map(record => record.recordId)).toEqual(['number-1', 'number-2', 'a', 'z'])
    expect(effectiveRecordPosition(records[0])).not.toBe(effectiveRecordPosition(records[1]))
    expect(records).toEqual(before)
  })

  it('normalizes -0 with 0 and degrades NaN without hiding the record', () => {
    expect(legacyToPositionId(-0, 'same')).toBe(legacyToPositionId(0, 'same'))
    const records = [
      { recordId: 'finite', legacyPosition: 0 },
      { recordId: 'string', legacyPosition: 'a0' },
      { recordId: 'nan', legacyPosition: Number.NaN },
    ].sort(compareRecordPositions)
    expect(records.map(record => record.recordId)).toEqual(['finite', 'string', 'nan'])
  })

  it('orders infinities, UTF-16 prefixes, NULs, and lone surrogates deterministically', () => {
    const records: PositionableRecord[] = [
      { recordId: 'malformed', legacyPosition: Number.NaN },
      { recordId: 'surrogate', legacyPosition: '\uD800' },
      { recordId: 'prefix-long', legacyPosition: 'a\0' },
      { recordId: 'prefix', legacyPosition: 'a' },
      { recordId: 'positive-infinity', legacyPosition: Infinity },
      { recordId: 'negative-infinity', legacyPosition: -Infinity },
    ]

    const expected = [
      'negative-infinity',
      'positive-infinity',
      'prefix',
      'prefix-long',
      'surrogate',
      'malformed',
    ]
    expect(records.slice().sort(compareRecordPositions).map(record => record.recordId))
      .toEqual(expected)
    expect(records.slice().reverse().sort(compareRecordPositions).map(record => record.recordId))
      .toEqual(expected)
  })

  it('keeps every raw record id, including UUID spelling variants, injective', () => {
    const lower = '12345678-1234-4234-9234-123456789abc'
    const upper = lower.toUpperCase()
    const compact = lower.replaceAll('-', '')
    expect(legacyToPositionId('same', lower)).not.toBe(legacyToPositionId('same', upper))
    expect(legacyToPositionId('same', lower)).not.toBe(legacyToPositionId('same', compact))
    expect(
      allocateRecordPositions([], [lower], 0).allocations[0].positionId,
    ).not.toBe(
      allocateRecordPositions([], [upper], 0).allocations[0].positionId,
    )
    expect(
      allocateRecordPositions([], ['\uD800'], 0).allocations[0].positionId,
    ).not.toBe(
      allocateRecordPositions([], ['\uFFFD'], 0).allocations[0].positionId,
    )
  })

  it('cannot collide when different bounds consume an identity-token prefix', () => {
    // Regression: without a suffix-free tail, `a0` + identity("༅A") and
    // `a002` + identity("A") both produced p1:a0021020140001.
    const prefixConsumer = `${String.fromCharCode(3845)}A`
    const fromOpenBounds = allocateRecordPositions([], [prefixConsumer], 0).allocations[0]
    const fromStaleBounds = allocateRecordPositions([
      { recordId: 'left', positionId: 'p1:a002' },
      { recordId: 'right', positionId: 'p1:a0022' },
    ], ['A'], 1).allocations.find(allocation => allocation.recordId === 'A')!

    expect(fromOpenBounds.positionId).not.toBe(fromStaleBounds.positionId)
  })

  it('allocates distinct convergent positions for concurrent inserts in the same gap', () => {
    const records: PositionableRecord[] = [
      { recordId: 'left', legacyPosition: 'b0I' },
      { recordId: 'right', legacyPosition: 'b0I' },
    ]

    const first = allocateRecordPositions(records, ['new-a'], 1)
      .allocations.find(allocation => allocation.recordId === 'new-a')!
    const second = allocateRecordPositions(records, ['new-b'], 1)
      .allocations.find(allocation => allocation.recordId === 'new-b')!
    const merged = [
      ...records,
      { recordId: first.recordId, positionId: first.positionId },
      { recordId: second.recordId, positionId: second.positionId },
    ]

    expect(first.positionId).not.toBe(second.positionId)
    expect(projectLegacyPosition(first.positionId)).not.toBe(projectLegacyPosition(second.positionId))
    expect(merged.slice().sort(compareRecordPositions).map(record => record.recordId))
      .toEqual(merged.slice().reverse().sort(compareRecordPositions).map(record => record.recordId))
  })

  it('materializes only the duplicate legacy suffix needed to keep old-client order', () => {
    const plan = allocateRecordPositions([
      { recordId: 'r1', legacyPosition: 'b0I', legacyMapPosition: 'b0I' },
      { recordId: 'r2', legacyPosition: 'b0I', legacyMapPosition: 'b0I' },
      { recordId: 'r3', legacyPosition: 'b0I', legacyMapPosition: 'b0I' },
      { recordId: 'tail', legacyPosition: 'b0J', legacyMapPosition: 'b0J' },
    ], ['new-row'], 1)

    expect(plan.orderedRecordIds).toEqual(['r1', 'new-row', 'r2', 'r3', 'tail'])
    expect(plan.allocations
      .filter(allocation => !allocation.preserveLegacyProjection)
      .map(allocation => allocation.recordId))
      .toEqual(['new-row', 'r2', 'r3'])
    const legacy = new Map([
      ['r1', 'b0I'],
      ['tail', 'b0J'],
      ...plan.allocations
        .filter(allocation => !allocation.preserveLegacyProjection)
        .map(allocation => [allocation.recordId, allocation.legacyPosition] as const),
    ])
    expect([...legacy].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .map(([recordId]) => recordId))
      .toEqual(['r1', 'new-row', 'r2', 'r3', 'tail'])
  })

  it('keeps a local batch in input order', () => {
    const plan = allocateRecordPositions([
      { recordId: 'left', legacyPosition: 'a0' },
      { recordId: 'right', legacyPosition: 'a1' },
    ], ['paste-1', 'paste-2', 'paste-3'], 1)

    expect(plan.orderedRecordIds).toEqual(['left', 'paste-1', 'paste-2', 'paste-3', 'right'])
    expect(plan.allocations
      .filter(allocation => !allocation.preserveLegacyProjection)
      .map(allocation => allocation.recordId))
      .toEqual(['paste-1', 'paste-2', 'paste-3'])
    const pastedPositions = plan.allocations
      .filter(allocation => !allocation.preserveLegacyProjection)
      .map(allocation => allocation.positionId)
    expect(pastedPositions).toEqual(pastedPositions.slice().sort())
  })

  it('keeps a 150-row paste ordered without unbounded key growth', () => {
    const recordIds = Array.from({ length: 150 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    )
    const plan = allocateRecordPositions([
      { recordId: 'left', legacyPosition: 1 },
      { recordId: 'right', legacyPosition: 2 },
    ], recordIds, 1)
    const keys = plan.allocations
      .filter(allocation => !allocation.preserveLegacyProjection)
      .map(allocation => parseRecordPositionKey(allocation.positionId)!)

    expect(plan.orderedRecordIds).toEqual(['left', ...recordIds, 'right'])
    expect(keys).toEqual(keys.slice().sort())
    expect(Math.max(...keys.map(key => key.length))).toBeLessThan(MAX_RECORD_POSITION_KEY_LENGTH)
  })

  it('keeps mixed explicit and NULL positions stable regardless of input order', () => {
    const explicit = allocateRecordPositions([
      { recordId: 'left', legacyPosition: 1 },
      { recordId: 'right', legacyPosition: 3 },
    ], ['explicit'], 1).allocations.find(allocation => allocation.recordId === 'explicit')!
    const records: PositionableRecord[] = [
      { recordId: 'left', legacyPosition: 1 },
      { recordId: 'explicit', positionId: explicit.positionId, legacyPosition: 2 },
      { recordId: 'right', positionId: null, legacyPosition: 3 },
    ]

    const forward = records.slice().sort(compareRecordPositions).map(record => record.recordId)
    const reverse = records.slice().reverse().sort(compareRecordPositions).map(record => record.recordId)
    expect(forward).toEqual(['left', 'explicit', 'right'])
    expect(reverse).toEqual(forward)
  })

  it('falls back from malformed explicit ids to the legacy position', () => {
    const malformed = { recordId: 'row', positionId: 'p999:not-supported', legacyPosition: 7 }
    expect(effectiveRecordPosition(malformed)).toBe(legacyToPositionId(7, 'row'))
  })

  it('rejects unsupported and oversized PositionId envelopes at the module boundary', () => {
    expect(isValidRecordPositionId('p1:a0')).toBe(true)
    expect(isValidRecordPositionId('p2:a0')).toBe(false)
    expect(isValidRecordPositionId('p1:not:a-key')).toBe(false)
    expect(isValidRecordPositionId(`p1:a0${'1'.repeat(MAX_RECORD_POSITION_KEY_LENGTH)}`))
      .toBe(false)
  })
})
