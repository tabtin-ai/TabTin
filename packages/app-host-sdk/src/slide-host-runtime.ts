export interface TabSlideLaunchContext {
  organizationId: string | null
  spaceId: string | null
  projectId: string | null
}

export interface TabSlideCreateDraftProjectInput {
  organizationId: string | null
  spaceId: string | null
  title?: string
  preset?: string
}

export interface TabSlideSaveProjectInput {
  projectId: string
  payload: unknown
}

export interface TabSlideSyncThumbnailInput {
  projectId: string
  blob: Blob
}

export interface TabSlideUploadAssetInput {
  file: File
  purpose: 'image' | 'video' | 'audio'
}

export interface TabSlideRegisterBeforeCloseFlushInput {
  flush: () => Promise<void>
}

/**
 * TabSlide 宿主运行时契约。
 *
 * 目标：
 * - 把保存、缩略图、上传、全屏、关闭前 flush 等职责从 UI 壳中抽离
 * - 让 Electron / Web 共用同一套 controller
 */
export interface TabSlideHostRuntime {
  getLaunchContext(): TabSlideLaunchContext
  createDraftProject(input: TabSlideCreateDraftProjectInput): Promise<{ projectId: string }>
  saveProject(input: TabSlideSaveProjectInput): Promise<void>
  syncThumbnail(input: TabSlideSyncThumbnailInput): Promise<void>
  uploadAsset(input: TabSlideUploadAssetInput): Promise<{ url: string }>
  setFullscreen?(input: { enabled: boolean }): Promise<void>
  registerBeforeCloseFlush?(input: TabSlideRegisterBeforeCloseFlushInput): () => void
}
