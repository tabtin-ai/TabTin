export const OSS_PUT_PRESIGNED_OBJECT_CHANNEL = 'oss:put-presigned-object' as const
export const OSS_GET_PRESIGNED_OBJECT_CHANNEL = 'oss:get-presigned-object' as const
export const OSS_CANCEL_PRESIGNED_DOWNLOAD_CHANNEL = 'oss:cancel-presigned-download' as const
export const OSS_CANCEL_PRESIGNED_OBJECT_CHANNEL = 'oss:cancel-presigned-object' as const
export const OSS_PUT_PRESIGNED_OBJECT_PROGRESS_CHANNEL = 'oss:put-presigned-object:progress' as const
export const OSS_PRESIGNED_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024
/** 与 electron.vite.config.ts 的生产 ASSET_PUBLIC_DOMAIN 默认值保持一致。 */
export const TRUSTED_ASSET_CDN_HOST = 'assets.example.com'

export interface OssPutPresignedObjectPayload {
  uploadId: string
  presignedUrl: string
  data: ArrayBuffer
  contentType?: string
}

export interface OssPutPresignedObjectProgress {
  uploadId: string
  loaded: number
  total: number
}

export interface OssPutPresignedObjectResult {
  status: number
  headers: Record<string, string>
  bodyText?: string
}

export interface OssGetPresignedObjectResult {
  status: number
  headers: Record<string, string>
  data: ArrayBuffer
}

export interface OssGetPresignedObjectPayload {
  requestId: string
  presignedUrl: string
}
