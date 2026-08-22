/**
 * 把「聊天附件 / OSS FileRecord UUID」纠成可预览的 file tab meta。
 *
 * 背景：Agent 常把上传附件的 file_id 当成 resource_ref（video/file）打开；
 * ResourceRouter 落成空 meta 的 file/tabvideo tab → TabFiles 提示「当前只支持预览…」。
 * 这里在打开前查 OSS FileRecord，命中则改写成 artifact_kind=oss_file + access_url。
 */

import type { OpenResourceTabFn } from '@tabtin/resource-router'
import { localFilePreviewRegistry } from '@components/shared/file-preview/localFilePreviewRegistry'
import {
  isFileRecordId,
  resolveOssFileDetail,
} from '@/components/chat/preview/resolveOssFileAccessUrl'

type OpenParams = Parameters<OpenResourceTabFn>[1]

function resolvePreviewFileType(fileName: string, mimeType?: string, apiFileType?: string): string {
  const byName = localFilePreviewRegistry.getByPath(fileName)
  if (byName) return byName.fileType
  if (apiFileType) {
    const byApi = localFilePreviewRegistry.getByFileType(apiFileType)
    if (byApi) return byApi.fileType
  }
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('image/')) return 'image'
  return apiFileType || 'file'
}

/**
 * - file + FileRecord UUID → 补 oss_file meta
 * - tabvideo + 同 id 其实是聊天附件（非视频项目）→ 改写成 file + oss_file，避免空「未命名视频」
 * - 查不到 FileRecord → 原样返回（真·本地相对路径 / 真·TabVideo 项目）
 */
export async function enrichOssFileOpenParams(params: OpenParams): Promise<OpenParams> {
  const existingMeta = (params.meta ?? {}) as Record<string, unknown>
  if (existingMeta.artifact_kind === 'local_file') return params
  if (
    existingMeta.artifact_kind === 'oss_file'
    && typeof existingMeta.access_url === 'string'
    && existingMeta.access_url
  ) {
    return params
  }

  const candidateId =
    (typeof existingMeta.file_id === 'string' && existingMeta.file_id)
    || params.id
  if (!isFileRecordId(candidateId)) return params
  if (params.type !== 'file' && params.type !== 'tabvideo') return params

  try {
    const detail = await resolveOssFileDetail(candidateId)
    const fileType = resolvePreviewFileType(detail.fileName, detail.mimeType, detail.fileType)
    return {
      ...params,
      type: 'file',
      id: candidateId,
      title: typeof params.title === 'string' && params.title && params.title !== candidateId
        ? params.title
        : detail.fileName,
      meta: {
        ...existingMeta,
        artifact_kind: 'oss_file',
        file_id: detail.fileId,
        file_type: fileType,
        filename: detail.fileName,
        mime_type: detail.mimeType,
        openIntentHints: {
          filename: detail.fileName,
          mimeType: detail.mimeType,
          assetId: detail.fileId,
        },
        access_url: detail.url,
        source: 'oss_file_record',
      },
    }
  } catch {
    return params
  }
}
