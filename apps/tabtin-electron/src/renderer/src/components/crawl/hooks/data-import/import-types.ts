/**
 * 数据导入类型定义
 *
 * 从 useDataImport.ts 提取。
 */

export interface ImportProgress {
  phase: 'idle' | 'creating_table' | 'creating_fields' | 'loading_cache' | 'downloading_resources' | 'importing_data' | 'uploading_resources' | 'completed' | 'error'
  message: string
  progress: number
  tableId?: string
  tableName?: string
  totalRecords?: number
  successCount?: number
  failedCount?: number

  downloadStats?: {
    total: number
    completed: number
    failed: number
    current?: string
    failedUrls?: string[]
  }

  uploadStats?: {
    total: number
    completed: number
    failed: number
    current?: string
    currentRecordId?: string
    failedUrls?: string[]
  }

  errorDetails?: {
    phase: string
    message: string
    canRetry: boolean
    canSkip: boolean
    details?: any
  }
}

export type ImportStageError = Error & {
  phase?: ImportProgress['phase']
  details?: unknown
  canRetry?: boolean
  canSkip?: boolean
}

export const toImportStageError = (
  phase: ImportProgress['phase'],
  message: string,
  details?: unknown,
  options?: { canRetry?: boolean; canSkip?: boolean }
): ImportStageError => {
  const error = new Error(message) as ImportStageError
  error.phase = phase
  error.details = details
  error.canRetry = options?.canRetry ?? true
  error.canSkip = options?.canSkip ?? false
  return error
}
