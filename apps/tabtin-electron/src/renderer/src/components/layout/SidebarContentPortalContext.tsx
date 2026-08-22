import { createContext, useContext } from 'react'

export interface SidebarContentPortalContextValue {
  enabled: boolean
  target: HTMLElement | null
}

const SidebarContentPortalCtx = createContext<SidebarContentPortalContextValue>({
  enabled: false,
  target: null,
})
SidebarContentPortalCtx.displayName = 'SidebarContentPortal'

export const SidebarContentPortalProvider = SidebarContentPortalCtx.Provider

export function useSidebarContentPortal(): SidebarContentPortalContextValue {
  return useContext(SidebarContentPortalCtx)
}
