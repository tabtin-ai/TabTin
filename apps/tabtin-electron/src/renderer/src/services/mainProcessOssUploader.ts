const UPLOAD_ID_RANDOM_SLICE_LENGTH = 8

export interface MainProcessPresignedPutResult {
  status: number
  headers: Record<string, string>
  bodyText?: string
}

export interface PutPresignedObjectViaMainProcessOptions {
  presignedUrl: string
  body: Blob
  contentType?: string
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (loaded: number, total: number) => void
}

export class MainProcessOssUploadUnavailableError extends Error {
  constructor() {
    super('Main process OSS upload channel is unavailable')
    this.name = 'MainProcessOssUploadUnavailableError'
  }
}

export class MainProcessOssUploadTimeoutError extends Error {
  constructor() {
    super('Main process OSS upload timed out')
    this.name = 'MainProcessOssUploadTimeoutError'
  }
}

function createUploadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 2 + UPLOAD_ID_RANDOM_SLICE_LENGTH)}`
}

export async function putPresignedObjectViaMainProcess(
  options: PutPresignedObjectViaMainProcessOptions,
): Promise<MainProcessPresignedPutResult> {
  const mainUploader = window.tabtin?.oss
  if (!mainUploader?.putPresignedObject) {
    throw new MainProcessOssUploadUnavailableError()
  }

  const uploadId = createUploadId()
  const timeoutController = new AbortController()
  const timeoutId = options.timeoutMs
    ? window.setTimeout(() => {
        timeoutController.abort()
        void mainUploader.cancelPresignedObject?.(uploadId)
      }, options.timeoutMs)
    : undefined

  const abortMainUpload = () => {
    timeoutController.abort()
    void mainUploader.cancelPresignedObject?.(uploadId)
  }
  options.signal?.addEventListener('abort', abortMainUpload, { once: true })

  try {
    if (options.signal?.aborted) {
      throw new Error('Upload cancelled')
    }

    const data = await options.body.arrayBuffer()
    if (options.signal?.aborted) {
      throw new Error('Upload cancelled')
    }
    if (timeoutController.signal.aborted) {
      throw new MainProcessOssUploadTimeoutError()
    }

    return await mainUploader.putPresignedObject(
      {
        uploadId,
        presignedUrl: options.presignedUrl,
        data,
        contentType: options.contentType,
      },
      (progress) => {
        options.onProgress?.(progress.loaded, progress.total)
      },
    )
  } catch (error) {
    if (timeoutController.signal.aborted && !options.signal?.aborted) {
      throw new MainProcessOssUploadTimeoutError()
    }
    throw error
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId)
    }
    options.signal?.removeEventListener('abort', abortMainUpload)
  }
}
