import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RecordCommentCountsResponse } from '@tabtin/table-core'
import {
  useRecordCommentCounts,
  type RecordCommentCountsGateway,
} from './useRecordCommentCounts'

describe('useRecordCommentCounts', () => {
  it('batches visible record ids and merges the authoritative counts', async () => {
    const gateway: RecordCommentCountsGateway = {
      listCounts: vi.fn(async (_tableId, recordIds): Promise<RecordCommentCountsResponse> => ({
        counts: Object.fromEntries(recordIds.map((id) => [id, 2])),
        thread_counts: Object.fromEntries(recordIds.map((id) => [id, 1])),
      })),
    }
    const recordIds = Array.from({ length: 205 }, (_, index) => `record-${index}`)

    const { result } = renderHook(() => useRecordCommentCounts({
      tableId: 'table-1',
      recordIds,
      gateway,
    }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(gateway.listCounts).toHaveBeenCalledTimes(3)
    expect(gateway.listCounts).toHaveBeenCalledWith(
      'table-1',
      expect.any(Array),
      'open',
    )
    expect(Object.keys(result.current.counts)).toHaveLength(205)
    expect(result.current.counts['record-0']).toBe(1)
  })

  it('refreshes the same batch after a realtime invalidation', async () => {
    let onChange: (() => void) | undefined
    const subscribe = vi.fn((callback: () => void) => {
      onChange = callback
      return () => undefined
    })
    const gateway: RecordCommentCountsGateway = {
      listCounts: vi.fn(async (): Promise<RecordCommentCountsResponse> => ({
        counts: { 'record-1': 2 },
      })),
    }
    const { result } = renderHook(() => useRecordCommentCounts({
      tableId: 'table-1',
      recordIds: ['record-1'],
      gateway,
      subscribe,
    }))
    await waitFor(() => expect(result.current.counts['record-1']).toBe(2))

    await act(async () => onChange?.())

    await waitFor(() => expect(gateway.listCounts).toHaveBeenCalledTimes(2))
  })

  it('re-queries the deduplicated loaded set after incremental records arrive', async () => {
    const gateway: RecordCommentCountsGateway = {
      listCounts: vi.fn(async (_tableId, recordIds): Promise<RecordCommentCountsResponse> => ({
        counts: Object.fromEntries(recordIds.map((id) => [id, 1])),
      })),
    }
    const { result, rerender } = renderHook(
      ({ recordIds }) => useRecordCommentCounts({
        tableId: 'table-1',
        recordIds,
        gateway,
      }),
      { initialProps: { recordIds: ['record-1'] } },
    )
    await waitFor(() => expect(result.current.counts).toEqual({ 'record-1': 1 }))

    rerender({ recordIds: ['record-2', 'record-1', 'record-2'] })

    await waitFor(() => expect(result.current.counts).toEqual({
      'record-1': 1,
      'record-2': 1,
    }))
    expect(gateway.listCounts).toHaveBeenLastCalledWith(
      'table-1',
      ['record-1', 'record-2'],
      'open',
    )
  })
})
