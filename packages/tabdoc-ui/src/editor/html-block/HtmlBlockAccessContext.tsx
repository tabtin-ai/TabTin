import { createContext, useContext } from 'react'

export interface HtmlBlockAccessContextValue {
  documentId?: string
  shareId?: string
  password?: string
  /** Increment to force revoke + reload (share access recheck failure). */
  revokeEpoch?: number
}

const HtmlBlockAccessContext = createContext<HtmlBlockAccessContextValue>({})

export const HtmlBlockAccessProvider = HtmlBlockAccessContext.Provider

export function useHtmlBlockAccess(): HtmlBlockAccessContextValue {
  return useContext(HtmlBlockAccessContext)
}
