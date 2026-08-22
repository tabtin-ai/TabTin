/**
 * 数据导入工具函数
 *
 * 从 useDataImport.ts 提取，提供通用的分块、重试、错误处理等能力。
 */

export const MAX_FIELDS_PER_BULK_REQUEST = 50
export const MAX_RECORDS_PER_IMPORT_REQUEST = 500
export const MAX_REQUEST_RETRIES = 2
export const RETRY_BASE_DELAY_MS = 1200

export const splitIntoChunks = <T,>(items: T[], chunkSize: number): T[][] => {
  if (chunkSize <= 0) return [items]
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }
  return chunks
}

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error'
  }
}

export const extractStatusCode = (error: unknown): number | null => {
  const message = getErrorMessage(error)
  const match = message.match(/(?:status|http|失败[:：]?|code[:：]?)\s*([1-5]\d{2})/i)
  if (!match || !match[1]) return null
  const code = Number(match[1])
  return Number.isFinite(code) ? code : null
}

export const isRetryableRequestError = (error: unknown): boolean => {
  const statusCode = extractStatusCode(error)
  if (statusCode != null) {
    if (statusCode === 408 || statusCode === 429) return true
    if (statusCode >= 500) return true
    return false
  }
  const message = getErrorMessage(error).toLowerCase()
  const retryableKeywords = [
    'timeout', 'timed out', 'network', 'fetch',
    'econnreset', 'socket hang up', 'temporarily unavailable',
  ]
  return retryableKeywords.some(keyword => message.includes(keyword))
}

export const withRetry = async <T,>(
  operation: () => Promise<T>,
  options: {
    maxRetries: number
    onRetry?: (context: {
      retryCount: number
      maxRetries: number
      delayMs: number
      error: unknown
    }) => void
  }
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const shouldRetry = isRetryableRequestError(error) && attempt < options.maxRetries
      if (!shouldRetry) throw error
      const retryCount = attempt + 1
      const delayMs = RETRY_BASE_DELAY_MS * retryCount
      options.onRetry?.({ retryCount, maxRetries: options.maxRetries, delayMs, error })
      await sleep(delayMs)
    }
  }
}
