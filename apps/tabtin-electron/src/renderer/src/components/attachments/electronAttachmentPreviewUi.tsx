/**
 * TabData 附件字段 Electron 预览 UI
 *
 * 替换表格引擎默认 FilePreviewDialog：后者对 xlsx/docx/pdf 走 renderer
 * fetch(assets.example.com)，打包态 origin=tabtin-file://app 会 CORS 失败。
 * 这里把附件列表交给聊天已验证的 ResourcePreview Lightbox
 * （getAttachmentBuffer → 主进程 fetchBuffer）。
 */

import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import type {
  AttachmentPreviewDialogRef,
  AttachmentPreviewFile,
  AttachmentPreviewUi,
} from '@tabtin/table-engine-canvas'
import type { TableGridAttachmentAccessContext } from '@tabtin/table-engine'
import { AttachmentApiService } from '@tabtin/table-core'
import { createLogger } from '@/utils/logger'
import { inferPreviewableKind } from '@components/chat/preview/inferPreviewableKind'
import type { PreviewResource } from '@components/chat/preview/types'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import { getCachedChatMediaObjectUrl } from '@components/chat/preview/chatMediaHttpCache'
import { resolveOssFileAccessUrl } from '@components/chat/preview/resolveOssFileAccessUrl'

const log = createLogger('AttachmentPreviewUi')

function mergeAccessContext(
  base: TableGridAttachmentAccessContext | undefined,
  local: TableGridAttachmentAccessContext | undefined,
): TableGridAttachmentAccessContext {
  return { ...base, ...local }
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { status?: unknown; statusCode?: unknown }
  const status = candidate.status ?? candidate.statusCode
  return typeof status === 'number' ? status : undefined
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * 仅在「路由不可用」时回退 OSS 文件详情换签：
 * - 405：旧后端对该 POST 返回 Method Not Allowed（预发真实证据）
 * - 404 且无业务 code：框架级缺路由（HTML/空 body），不是 TabData 资源 404
 *
 * 新后端对 AttachmentReference/FileRecord 缺失会返回带 envelope code
 * （如 NOT_FOUND）的 404——必须保持终态，避免绕过 TabData 授权。
 */
function isLegacyAccessRouteUnavailable(error: unknown): boolean {
  const status = getHttpStatus(error)
  if (status === 405) return true
  if (status === 404) return getErrorCode(error) == null
  return false
}

async function resolveTabDataAttachmentUrl(
  fileId: string,
  context: TableGridAttachmentAccessContext,
): Promise<string> {
  if (!context.tableId) {
    throw new Error('TabData attachment access requires table context')
  }
  try {
    const result = await AttachmentApiService.resolveAccessUrl({
      file_id: fileId,
      table_id: context.tableId,
      field_id: context.fieldId,
      record_id: context.recordId,
      reference_id: context.referenceId,
    })
    return result.url
  } catch (error) {
    if (!isLegacyAccessRouteUnavailable(error)) {
      throw error
    }
    const status = getHttpStatus(error)
    log.warn('TabData attachment access route unavailable; using legacy OSS access', {
      status,
      hasFileId: true,
    })
    return resolveOssFileAccessUrl(fileId, { forceRefresh: true })
  }
}

export async function resolveElectronAttachmentThumbnailUrl(
  file: AttachmentPreviewFile,
  baseContext?: TableGridAttachmentAccessContext,
): Promise<string> {
  const sourceUrl =
    file.assetFileId
      ? await resolveTabDataAttachmentUrl(
          file.assetFileId,
          mergeAccessContext(baseContext, file.accessContext),
        )
      : file.src
  if (!sourceUrl) {
    return ''
  }
  return getCachedChatMediaObjectUrl({
    url: sourceUrl,
    fileId: file.assetFileId,
    mimeType: file.mimetype,
  })
}

export function mapAttachmentPreviewFiles(
  files: AttachmentPreviewFile[],
): PreviewResource[] {
  return files
    .filter((file) => Boolean(file.src))
    .map((file) => {
      const kind =
        inferPreviewableKind(file.mimetype, file.name || file.src) ?? 'file'
      return {
        id: `tabdata-att:${file.fileId}`,
        kind,
        url: file.src,
        name: file.name || 'attachment',
        mimeType: file.mimetype,
        fileId: file.assetFileId,
      } satisfies PreviewResource
    })
}

export async function resolveAttachmentPreviewFiles(
  files: AttachmentPreviewFile[],
  baseContext?: TableGridAttachmentAccessContext,
): Promise<AttachmentPreviewFile[]> {
  return Promise.all(files.map(async (file) => {
    if (!file.assetFileId) return file
    try {
      return {
        ...file,
        src: await resolveTabDataAttachmentUrl(
          file.assetFileId,
          mergeAccessContext(baseContext, file.accessContext),
        ),
      }
    } catch {
      return file
    }
  }))
}

const ElectronAttachmentPreviewDialog = forwardRef<
  AttachmentPreviewDialogRef,
  { files: AttachmentPreviewFile[]; accessContext?: TableGridAttachmentAccessContext }
>(function ElectronAttachmentPreviewDialog({ files, accessContext }, ref) {
  const filesRef = useRef(files)
  filesRef.current = files

  useImperativeHandle(
    ref,
    () => ({
      openPreview: (fileId: string) => {
        void resolveAttachmentPreviewFiles(filesRef.current, accessContext).then((resolvedFiles) => {
          const resources = mapAttachmentPreviewFiles(resolvedFiles)
          if (resources.length === 0) {
            log.warn('openPreview skipped: no previewable files', { fileId })
            return
          }
          const resourceId = `tabdata-att:${fileId}`
          const index = Math.max(
            0,
            resources.findIndex((resource) => resource.id === resourceId),
          )
          const opened = useResourcePreviewStore
            .getState()
            .open(resources, index, { showNavMeta: true })
          if (!opened) {
            log.warn('openPreview failed to open lightbox', {
              fileId,
              count: resources.length,
            })
          } else {
            log.info('openPreview', {
              fileId,
              index,
              kind: resources[index]?.kind,
              count: resources.length,
            })
          }
        })
      },
    }),
    [accessContext],
  )

  // 实际 UI 由全局 ChatResourcePreviewModal 承载
  return null
})

const PassthroughProvider: React.FC<{ children?: React.ReactNode }> = ({
  children,
}) => <>{children}</>

export async function loadElectronAttachmentPreviewUi(
  accessContext?: TableGridAttachmentAccessContext,
): Promise<AttachmentPreviewUi> {
  const ContextualDialog = forwardRef<AttachmentPreviewDialogRef, { files: AttachmentPreviewFile[] }>(
    function ContextualDialog(props, ref) {
      return <ElectronAttachmentPreviewDialog {...props} ref={ref} accessContext={accessContext} />
    },
  )
  return {
    Dialog: ContextualDialog,
    Provider: PassthroughProvider,
    resolveThumbnailUrl: (file) => resolveElectronAttachmentThumbnailUrl(file, accessContext),
  }
}
