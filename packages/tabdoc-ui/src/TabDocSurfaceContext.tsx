import { createContext, useContext } from 'react'

export interface TabDocSurfaceState {
  documentId: string | null
  isPaneActive: boolean
  isVisible: boolean
}

const DEFAULT_TABDOC_SURFACE_STATE: TabDocSurfaceState = {
  documentId: null,
  isPaneActive: true,
  isVisible: true,
}

const TabDocSurfaceContext = createContext<TabDocSurfaceState>(DEFAULT_TABDOC_SURFACE_STATE)

export const TabDocSurfaceProvider = TabDocSurfaceContext.Provider

export function useTabDocSurface(): TabDocSurfaceState {
  return useContext(TabDocSurfaceContext)
}
