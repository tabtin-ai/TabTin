/**
 * useFileIdImageUrl — 把 wire v2 ImageBlock 的 `file_id` source 解析成可渲染 URL。
 *
 * 背景：agent 生成的图片以 `{ type: 'file_id', file_id }` 形式下发，
 * block 本身不带 URL，旧实现直接 placeholder「图片暂不可用」。这里通过
 * `GET /api/services/oss/files/{file_id}`（jwt_auth，返回 access_url / cdn_url）
 * 解析出真实 URL，供 `<img src>` 与下载入口复用。
 *
 * 设计：
 *   - URL 请求、过期判断与 in-flight 去重统一交给 resolveOssFileDetail。
 *   - 图片只需 URL（不像 Office/PDF 要 ArrayBuffer），不在此处缓存整文件。
 *   - 失败 / 未命中返回 error，调用方回落到 placeholder。
 */

import { useEffect, useState } from 'react'
import { useAuthStore } from '@/stores/useAuthStore'
import {
  _clearOssFileAccessUrlCache,
  peekCachedOssFileDetail,
  resolveOssFileDetail,
} from '../preview/resolveOssFileAccessUrl'
import type { OssFileDetail } from '../preview/resolveOssFileAccessUrl'

interface ResolvedFileImage {
  url: string
  name: string
  mimeType?: string
  fileSize?: number
}

interface FileIdImageState {
  data: ResolvedFileImage | null
  loading: boolean
  error: string | null
}

interface InternalFileIdImageState extends FileIdImageState {
  fileId: string | null
  userId: string | null
}

function toResolvedFileImage(detail: OssFileDetail): ResolvedFileImage {
  return {
    url: detail.url,
    name: detail.fileName,
    mimeType: detail.mimeType,
    fileSize: detail.fileSize,
  }
}

/**
 * 按 file_id 解析图片 URL。共享 resolver 负责缓存和临期换链。
 *
 * fileId 为空时直接返回 loading=false / data=null，调用方走 placeholder。
 */
export function useFileIdImageUrl(fileId: string | undefined | null): FileIdImageState {
  const normalizedFileId = fileId || null
  const userId = useAuthStore(state => state.user?.id ? String(state.user.id) : null)
  const createState = (): InternalFileIdImageState => {
    const cached = fileId ? peekCachedOssFileDetail(fileId) : undefined
    return {
      data: cached ? toResolvedFileImage(cached) : null,
      loading: Boolean(fileId && !cached),
      error: null,
      fileId: normalizedFileId,
      userId,
    }
  }
  const [state, setState] = useState<InternalFileIdImageState>(createState)

  useEffect(() => {
    if (!fileId) {
      setState({ data: null, loading: false, error: null, fileId: null, userId })
      return
    }
    let cancelled = false
    const cached = peekCachedOssFileDetail(fileId)
    if (cached) {
      setState({
        data: toResolvedFileImage(cached),
        loading: false,
        error: null,
        fileId,
        userId,
      })
      return
    }
    setState({ data: null, loading: true, error: null, fileId, userId })
    void resolveOssFileDetail(fileId)
      .then(detail => {
        if (cancelled) return
        setState({
          data: toResolvedFileImage(detail),
          loading: false,
          error: null,
          fileId,
          userId,
        })
      })
      .catch(err => {
        if (!cancelled) {
          setState({
            data: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            fileId,
            userId,
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [fileId, userId])

  if (state.fileId !== normalizedFileId || state.userId !== userId) {
    return createState()
  }
  return state
}

/** 测试用：清空共享 URL / detail 缓存。 */
export function _clearFileIdUrlCache(): void {
  _clearOssFileAccessUrlCache()
}
