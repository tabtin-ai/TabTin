import {
  isOldXlsxFormatError,
  parseXlsxPreview,
  type XlsxPreviewParseResult,
} from './xlsxPreviewParser'

type WorkerRequest = {
  id: number
  buffer: ArrayBuffer
}

type WorkerSuccess = {
  id: number
  ok: true
  result: XlsxPreviewParseResult
}

type WorkerFailure = {
  id: number
  ok: false
  message: string
  oldFormat: boolean
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, buffer } = event.data
  try {
    const result = parseXlsxPreview(buffer)
    self.postMessage({ id, ok: true, result } satisfies WorkerSuccess)
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      oldFormat: isOldXlsxFormatError(error),
    } satisfies WorkerFailure)
  }
}
