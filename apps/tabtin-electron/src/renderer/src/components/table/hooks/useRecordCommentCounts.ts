import React from 'react'
import {
  RecordCommentApiService,
  type RecordCommentCountsResponse,
  type RecordCommentStatusFilter,
} from '@tabtin/table-core'

const COMMENT_COUNTS_BATCH_SIZE = 100

export interface RecordCommentCountsGateway {
  listCounts: (
    tableId: string,
    recordIds: string[],
    status?: RecordCommentStatusFilter,
  ) => Promise<RecordCommentCountsResponse>
}

export interface UseRecordCommentCountsOptions {
  tableId: string | null
  recordIds: string[]
  enabled?: boolean
  gateway?: RecordCommentCountsGateway
  subscribe?: (onChange: () => void) => () => void
}

export function useRecordCommentCounts({
  tableId,
  recordIds,
  enabled = true,
  gateway = RecordCommentApiService,
  subscribe,
}: UseRecordCommentCountsOptions) {
  const recordIdsKey = React.useMemo(
    () => [...new Set(recordIds.filter(Boolean))].sort().join(','),
    [recordIds],
  )
  const normalizedRecordIds = React.useMemo(
    () => recordIdsKey ? recordIdsKey.split(',') : [],
    [recordIdsKey],
  )
  const [counts, setCounts] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const requestEpochRef = React.useRef(0)

  const refresh = React.useCallback(async () => {
    if (!enabled || !tableId || normalizedRecordIds.length === 0) {
      requestEpochRef.current += 1
      setCounts({})
      setLoading(false)
      setError(null)
      return
    }

    const requestEpoch = ++requestEpochRef.current
    setLoading(true)
    setError(null)
    try {
      const batches: string[][] = []
      for (let index = 0; index < normalizedRecordIds.length; index += COMMENT_COUNTS_BATCH_SIZE) {
        batches.push(normalizedRecordIds.slice(index, index + COMMENT_COUNTS_BATCH_SIZE))
      }
      const responses = await Promise.all(
        batches.map((batch) => gateway.listCounts(tableId, batch, 'open')),
      )
      if (requestEpochRef.current !== requestEpoch) return
      setCounts(Object.assign({}, ...responses.map((response) => (
        response.thread_counts ?? response.counts
      ))))
    } catch (cause) {
      if (requestEpochRef.current !== requestEpoch) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestEpochRef.current === requestEpoch) setLoading(false)
    }
  }, [enabled, gateway, normalizedRecordIds, tableId])

  React.useEffect(() => {
    void refresh()
    return () => {
      requestEpochRef.current += 1
    }
  }, [refresh])

  React.useEffect(() => subscribe?.(() => { void refresh() }), [refresh, subscribe])

  return { counts, loading, error, refresh }
}
