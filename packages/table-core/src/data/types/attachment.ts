export interface AttachmentUploadFileInput {
  file_name: string
  file_size: number
  mime_type?: string
  chunk_size?: number
  is_public?: boolean
  /** 文件 SHA-256 hash（hex），传入后后端支持秒传 */
  file_hash?: string
}

export interface AttachmentUploadTaskRequest {
  table_id: string
  field_id: string
  record_id?: string
  files: AttachmentUploadFileInput[]
}

export interface AttachmentUploadFileOut {
  upload_item_id: string
  file_name: string
  file_size: number
  chunk_size: number
  total_parts: number
  object_key: string
  upload_id?: string
}

export interface AttachmentUploadTaskResponse {
  task_id: string
  task_type: 'single' | 'batch' | 'chunk'
  files: AttachmentUploadFileOut[]
}

export interface AttachmentPartUploadResponse {
  upload_item_id: string
  part_number: number
  etag: string
  completed_parts: number
  total_parts: number
  uploaded_size: number
}

export interface AttachmentReference {
  reference_id: string
  file_id: string
  table_id?: string
  field_id?: string
  record_id?: string
  name: string
  url?: string
  size?: number
  mime_type?: string
  bucket?: string
  key?: string
  extra?: Record<string, any>
  created_at?: string
  updated_at?: string
  created_by?: string
  thumbnail_url?: string
  smThumbnailUrl?: string
  lgThumbnailUrl?: string
  preview_url?: string
}

export interface AttachmentCompleteResponse {
  upload_item_id: string
  file_id: string
  reference: AttachmentReference
  status: string
}

export interface AttachmentReuseRequest {
  file_id: string
  table_id: string
  field_id: string
  record_id: string
}

export interface AttachmentReuseResponse extends AttachmentReference {}

export interface AttachmentAccessRequest {
  file_id: string
  table_id: string
  field_id?: string
  record_id?: string
  reference_id?: string
}

export interface AttachmentAccessResponse {
  reference_id: string
  file_id: string
  url: string
  expires_in: number | null
}

export interface AttachmentRemoveResponse {
  reference_id: string
  deleted_file_id?: string | null
}

export interface AttachmentFieldConversionRequest {
  target_type: string
  target_options?: Record<string, any>
  force?: boolean
  async_mode?: boolean
}

export interface AttachmentFieldConversionResponse {
  success?: boolean
  field_id?: string
  from_type?: string
  to_type?: string
  message?: string
  error?: string
  task_id?: string
  affected_records?: number
  converted_count?: number
  forced_null_count?: number
  modified_records?: number
}
