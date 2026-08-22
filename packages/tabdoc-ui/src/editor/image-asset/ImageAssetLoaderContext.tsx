import { createContext, useContext } from 'react'

export interface TabDocImageAssetLoadRequest {
  fileId: string
  documentId?: string
  shareId?: string
  password?: string
  signal?: AbortSignal
}

export interface TabDocImageAssetLoadResult {
  url: string
  expiresIn?: number | null
}

export type TabDocImageAssetLoader = (
  request: TabDocImageAssetLoadRequest,
) => Promise<TabDocImageAssetLoadResult>

export interface TabDocImageAssetPreviewRequest {
  url: string
  fileId?: string
  name?: string
}

export type TabDocImageAssetPreview = (request: TabDocImageAssetPreviewRequest) => void

const ImageAssetLoaderContext = createContext<TabDocImageAssetLoader | null>(null)
const ImageAssetPreviewContext = createContext<TabDocImageAssetPreview | null>(null)

export const ImageAssetLoaderProvider = ImageAssetLoaderContext.Provider
export const ImageAssetPreviewProvider = ImageAssetPreviewContext.Provider

export function useImageAssetLoaderOptional(): TabDocImageAssetLoader | null {
  return useContext(ImageAssetLoaderContext)
}

export function useImageAssetPreviewOptional(): TabDocImageAssetPreview | null {
  return useContext(ImageAssetPreviewContext)
}
