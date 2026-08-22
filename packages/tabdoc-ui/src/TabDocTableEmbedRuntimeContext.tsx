import { createContext, useContext } from 'react'
import type { RecordStore, TableStore, ViewStore } from '@tabtin/table-core'
import type { StoreApi } from 'zustand'

export interface TabDocTableEmbedStores {
  tableStore: StoreApi<TableStore>
  viewStore: StoreApi<ViewStore>
  recordStore: StoreApi<RecordStore>
}

export interface TabDocTableEmbedRuntime {
  /** Parent TabDoc used to authorize an embedded table collaboration session. */
  parentDocumentId?: string | null
  getOrCreateStores(tableId: string, surfaceId?: string): TabDocTableEmbedStores
  retainStore(tableId: string, surfaceId?: string): void
  releaseStore(tableId: string, surfaceId?: string): void
  rebuildStore(tableId: string, surfaceId?: string): void
}

const TabDocTableEmbedRuntimeContext = createContext<TabDocTableEmbedRuntime | null>(null)

export const TabDocTableEmbedRuntimeProvider = TabDocTableEmbedRuntimeContext.Provider

export function useTabDocTableEmbedRuntime(): TabDocTableEmbedRuntime {
  const runtime = useContext(TabDocTableEmbedRuntimeContext)
  if (!runtime) {
    throw new Error(
      '[useTabDocTableEmbedRuntime] TabDocTableEmbedRuntime not found in context. ' +
        'Ensure TabDocTableEmbedRuntimeProvider wraps this component tree.',
    )
  }
  return runtime
}
