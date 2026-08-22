/**
 * TabData 常量 — 与 Django constants.py 保持同步
 */

export const DEFAULT_PAGE = 1
export const DEFAULT_PAGE_SIZE = 100
export const MAX_PAGE_SIZE = 1000

export const MAX_BULK_RECORDS = 1000
export const MAX_BULK_FIELDS = 50
/** -1 = 不按请求截断；产品上限由套餐 max_records_per_table 执行（与 Django constants.py 同步） */
export const MAX_IMPORT_ROWS_PER_REQUEST = -1
export const IMPORT_FIELD_CHUNK_SIZE = 50
export const BULK_WRITE_CHUNK_SIZE = 200
export const MAX_EXPORT_ROWS = 100_000
export const MAX_EXPORT_ROWS_PDF = 5_000

export const FILE_BASED_FIELD_TYPES = new Set(['attachment'] as const)
