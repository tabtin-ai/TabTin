/**
 * Electron 宿主的 TabDocEditorConfig 实现
 *
 * 将 Electron 特有的 auth/collab/image-upload/event-stream 能力
 * 适配为 TabDoc 共享包的 Port 接口。
 */
import type {
  TabDocImageUploadPort,
  TabDocHtmlUploadPort,
  TabDocAuthPort,
} from '@tabtin/tabdoc-ui'
import { isHtmlUploadFile } from '@tabtin/tabdoc-ui/editor'
import { getAuthToken } from '@/adapters/api-adapter-instance'
import { useAuthStore } from '@/stores/useAuthStore'
import { directUpload } from '@/services/oss-direct-uploader'
import { validateUploadFile, UPLOAD_PRESETS, formatFileSize } from '@/constants/upload'
import { createLogger } from '@/utils/logger'

const htmlUploadLog = createLogger('TabDocHtmlUpload')

/**
 * HTML 嵌入块上传大小上限 = 10MB。
 * 交互式前端上传保守取值，不与 CLI 侧 100MB 对齐——避免用户在编辑器里拖入超大 HTML 卡死渲染。
 */
const HTML_UPLOAD_MAX_BYTES = 10 * 1024 * 1024

/** HTML 上传校验：类型（.html/.htm 或 text/html）+ 大小。reason 与共享 runHtmlUpload 的 toast 分支约定对齐。 */
function validateHtmlUploadFile(file: File): { valid: boolean; reason?: string } {
  if (!isHtmlUploadFile(file)) {
    return { valid: false, reason: 'fileTypeNotAllowed' }
  }
  if (file.size > HTML_UPLOAD_MAX_BYTES) {
    return { valid: false, reason: `fileTooLarge:${Math.round(HTML_UPLOAD_MAX_BYTES / (1024 * 1024))}` }
  }
  return { valid: true }
}

export function normalizeUploadFileName(fileName: string): string {
  const normalized = fileName.split(/[\\/]/).filter(Boolean).pop()
  return normalized || fileName
}

export const electronAuthPort: TabDocAuthPort = {
  getAccessToken: () => getAuthToken(),
  refreshAccessToken: async () => {
    await useAuthStore.getState().refreshAuthToken()
    return getAuthToken()
  },
  getCurrentUser: () => {
    const user = useAuthStore.getState().user
    if (!user) return null
    return {
      id: user.id,
      nickname: user.nickname,
      username: user.username,
      email: user.email,
    }
  },
}

export const electronImageUploadPort: TabDocImageUploadPort = {
  upload: async (file, options) => {
    const validation = validateUploadFile(file, 'IMAGE')
    if (!validation.valid) {
      throw new Error(validation.reason ?? 'File validation failed')
    }
    const result = await directUpload(file, normalizeUploadFileName(file.name), {
      folder: options.folder ?? 'tabdoc/images',
      module: options.module ?? 'tabdoc',
      contextType: options.contextType ?? 'document',
      contextId: options.contextId,
      isPublic: false,
    })
    const url = result.accessUrl
    if (!url || !result.fileId) {
      throw new Error('Image upload completed without a usable private file reference')
    }
    return {
      url,
      fileId: result.fileId,
      ...(result.fileKey ? { fileKey: result.fileKey } : {}),
    }
  },
  validate: (file) => {
    const result = validateUploadFile(file, 'IMAGE')
    return {
      valid: result.valid,
      reason: result.reason,
      maxSizeLabel: formatFileSize(UPLOAD_PRESETS.IMAGE.maxSize),
    }
  },
}

export const electronHtmlUploadPort: TabDocHtmlUploadPort = {
  upload: async (file, options) => {
    const validation = validateHtmlUploadFile(file)
    if (!validation.valid) {
      throw new Error(validation.reason ?? 'HTML file validation failed')
    }
    const fileName = normalizeUploadFileName(file.name)
    const startedAt = Date.now()
    htmlUploadLog.info(
      `html upload start name=${fileName} size=${file.size} document=${options.documentId ?? '-'}`,
    )
    try {
      // contextType 'document' 对齐 ；#7767 强制私有上传，渲染走授权 Blob。
      const result = await directUpload(file, fileName, {
        folder: 'tabdoc/html',
        module: 'tabdoc',
        contextType: 'document',
        contextId: options.documentId,
        isPublic: false,
      })
      htmlUploadLog.info(
        `html upload done name=${fileName} fileId=${result.fileId} (${Date.now() - startedAt}ms)`,
      )
      return { url: '', fileId: result.fileId }
    } catch (err) {
      htmlUploadLog.error(
        `html upload failed name=${fileName} (${Date.now() - startedAt}ms):`,
        err,
      )
      throw err
    }
  },
  validate: (file) => {
    const result = validateHtmlUploadFile(file)
    return {
      valid: result.valid,
      reason: result.reason,
      maxSizeLabel: formatFileSize(HTML_UPLOAD_MAX_BYTES),
    }
  },
}

/**
 * 配置 TabDataBlock 的嵌入渲染器（需在 TabDoc 编辑器挂载前调用一次）。
 * 将 Electron 特有的 TableEmbedHost 注入到共享包的 TabDataBlockView 中。
 */
export function configureElectronTabDataBlockEmbed(): void {
  import('@tabtin/tabdoc-ui/editor').then(({ configureTabDataBlockView }) =>
    import('../components/editor/tabdata-block/TableEmbedHost').then(({ TableEmbedHost }) =>
      import('react').then((React) => {
        configureTabDataBlockView({
          renderTableEmbed: (props) =>
            React.createElement(TableEmbedHost, {
              tableId: props.tableId,
              viewId: props.viewId,
              title: props.title,
              maxHeight: props.maxHeight,
              onOpenInTab: props.onOpenInTab,
              onDelete: props.onDelete,
              onUpdateAttributes: props.onUpdateAttributes,
              surfaceId: props.surfaceId,
              isSurfaceActive: props.isSurfaceActive,
            }),
        })
      }),
    ),
  )
}
