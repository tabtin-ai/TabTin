import type { TableGridRuntimeApi, TableGridRow } from '@tabtin/table-engine'
import { resolveRecordId } from '@tabtin/table-engine'

type GridRuntimeApi = Pick<
  TableGridRuntimeApi<TableGridRow>,
  'getDisplayedRowAtIndex' | 'getDisplayedRowCount'
>

type GridApiRefLike = {
  current: GridRuntimeApi | null
}

type RecordLike = {
  id?: string
}

export interface CreatedRecordVisibilityResult<TRecord extends RecordLike> {
  firstVisibleRecord: TRecord | null
  hiddenRecords: TRecord[]
  visibleRecordIds: Set<string>
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export function collectDisplayedRecordIds(gridApiRef: GridApiRefLike): Set<string> {
  const api = gridApiRef.current
  const visibleRecordIds = new Set<string>()
  if (!api) {
    return visibleRecordIds
  }

  const displayedCount = api.getDisplayedRowCount?.() ?? 0
  for (let index = 0; index < displayedCount; index += 1) {
    const rowData = api.getDisplayedRowAtIndex?.(index)?.data as
      | Record<string, unknown>
      | undefined
    if (!rowData || typeof rowData !== 'object') {
      continue
    }

    const recordId = resolveRecordId(rowData)
    if (recordId) {
      visibleRecordIds.add(recordId)
    }
  }

  return visibleRecordIds
}

export async function resolveCreatedRecordVisibility<TRecord extends RecordLike>({
  gridApiRef,
  createdRecords,
  maxAttempts = 6,
  delayMs = 80,
}: {
  gridApiRef: GridApiRefLike
  createdRecords: TRecord[]
  maxAttempts?: number
  delayMs?: number
}): Promise<CreatedRecordVisibilityResult<TRecord>> {
  const recordsWithIds = createdRecords.filter(
    (record): record is TRecord & { id: string } =>
      typeof record?.id === 'string' && record.id.length > 0,
  )

  if (recordsWithIds.length === 0) {
    return {
      firstVisibleRecord: null,
      hiddenRecords: [],
      visibleRecordIds: new Set<string>(),
    }
  }

  let visibleRecordIds = new Set<string>()
  let firstVisibleRecord: TRecord | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    visibleRecordIds = collectDisplayedRecordIds(gridApiRef)
    firstVisibleRecord =
      recordsWithIds.find((record) => visibleRecordIds.has(record.id)) ?? null
    if (firstVisibleRecord) {
      break
    }
    if (attempt < maxAttempts - 1) {
      await sleep(delayMs)
    }
  }

  return {
    firstVisibleRecord,
    hiddenRecords: recordsWithIds.filter(
      (record) => !visibleRecordIds.has(record.id),
    ),
    visibleRecordIds,
  }
}
