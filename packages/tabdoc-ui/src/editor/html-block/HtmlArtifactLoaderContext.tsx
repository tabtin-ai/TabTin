import { createContext, useContext } from 'react'

export interface TabDocHtmlArtifactLoadRequest {
  fileId: string
  documentId?: string
  shareId?: string
  password?: string
  signal?: AbortSignal
}

/**
 * Narrow loader for private HTML artifacts .
 * Hosts fetch authorized bytes; HtmlBlockView turns them into short-lived blob URLs.
 */
export type TabDocHtmlArtifactLoader = (
  request: TabDocHtmlArtifactLoadRequest,
) => Promise<Blob>

const HtmlArtifactLoaderContext = createContext<TabDocHtmlArtifactLoader | null>(null)

export const HtmlArtifactLoaderProvider = HtmlArtifactLoaderContext.Provider

export function useHtmlArtifactLoaderOptional(): TabDocHtmlArtifactLoader | null {
  return useContext(HtmlArtifactLoaderContext)
}
