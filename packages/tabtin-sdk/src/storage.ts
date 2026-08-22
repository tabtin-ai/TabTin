import { HttpClient } from './http.js'
import type {
  ApiResponse,
  DeleteResult,
  DownloadUrlResult,
  FileInfo,
  PresignedUploadResult,
  StorageListResult,
  StorageListOptions,
  TabTinError,
  UploadOptions,
} from './types.js'

/**
 * Storage handle — returned by `tabtin.from('tableName').storage`.
 *
 * Provides file upload, download, list, and delete operations
 * for attachments stored against a table.
 *
 * ```ts
 * const tabtin = createClient({ baseURL, token })
 * await tabtin.init()
 *
 * // Upload a file
 * const { data } = await tabtin.from('任务').storage.upload('附件', file, 'report.pdf')
 *
 * // List files
 * const { data } = await tabtin.from('任务').storage.list()
 *
 * // Download URL
 * const { data } = await tabtin.from('任务').storage.getDownloadUrl('file-uuid')
 *
 * // Delete
 * await tabtin.from('任务').storage.delete('file-uuid')
 * ```
 */
export class StorageHandle {
  private http: HttpClient
  private pathPrefix: string

  constructor(http: HttpClient, pathPrefix: string) {
    this.http = http
    this.pathPrefix = pathPrefix
  }

  /**
   * Upload a file via multipart form data.
   * Accepts a Blob, ArrayBuffer, or Uint8Array as the file content.
   *
   * In Node.js you can pass `Buffer` (which extends `Uint8Array`).
   */
  async upload(
    fieldId: string,
    file: Blob | ArrayBuffer | Uint8Array,
    fileName: string,
    options?: UploadOptions,
  ): Promise<ApiResponse<FileInfo>> {
    try {
      const formData = new FormData()
      formData.append('field_id', fieldId)
      const blob =
        file instanceof Blob
          ? file
          : new Blob([file instanceof ArrayBuffer ? file : (file as BlobPart)])
      formData.append('file', blob, fileName)
      if (options?.record_id) {
        formData.append('record_id', options.record_id)
      }
      if (options?.is_public !== undefined) {
        formData.append('is_public', String(options.is_public))
      }

      const result = await this.http.postForm<FileInfo>(
        `${this.pathPrefix}/storage/upload`,
        formData,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Get a presigned URL for direct-to-cloud upload.
   * Useful for large files — the client uploads directly to object storage.
   */
  async getPresignedUploadUrl(
    fieldId: string,
    fileName: string,
    fileSize: number,
    mimeType: string,
    options?: UploadOptions,
  ): Promise<ApiResponse<PresignedUploadResult>> {
    try {
      const result = await this.http.post<PresignedUploadResult>(
        `${this.pathPrefix}/storage/presigned-upload`,
        {
          field_id: fieldId,
          file_name: fileName,
          file_size: fileSize,
          mime_type: mimeType,
          record_id: options?.record_id,
        },
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Complete a presigned upload after the file has been uploaded to the presigned URL.
   */
  async completePresignedUpload(uploadItemId: string): Promise<ApiResponse<FileInfo>> {
    try {
      const result = await this.http.post<FileInfo>(
        `${this.pathPrefix}/storage/presigned-upload/${uploadItemId}/complete`,
        {},
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Get a presigned download URL for a file.
   */
  async getDownloadUrl(fileId: string): Promise<ApiResponse<DownloadUrlResult>> {
    try {
      const result = await this.http.get<DownloadUrlResult>(
        `${this.pathPrefix}/storage/${fileId}/download`,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * List files attached to this table.
   */
  async list(options?: StorageListOptions): Promise<ApiResponse<StorageListResult>> {
    try {
      const query: Record<string, unknown> = {}
      if (options?.field_id) query.field_id = options.field_id
      if (options?.record_id) query.record_id = options.record_id
      if (options?.page) query.page = options.page
      if (options?.page_size) query.page_size = options.page_size

      const result = await this.http.get<StorageListResult>(
        `${this.pathPrefix}/storage`,
        Object.keys(query).length > 0 ? query : undefined,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Get file metadata by ID.
   */
  async getFileInfo(fileId: string): Promise<ApiResponse<FileInfo>> {
    try {
      const result = await this.http.get<FileInfo>(
        `${this.pathPrefix}/storage/${fileId}`,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }

  /**
   * Delete a file by ID.
   */
  async delete(fileId: string): Promise<ApiResponse<DeleteResult>> {
    try {
      const result = await this.http.delete<DeleteResult>(
        `${this.pathPrefix}/storage/${fileId}`,
      )
      return { data: result, error: null }
    } catch (err) {
      return { data: null, error: err as TabTinError }
    }
  }
}
