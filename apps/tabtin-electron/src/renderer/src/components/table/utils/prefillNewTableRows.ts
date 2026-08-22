import { RecordApiService } from '@tabtin/table-core'

/**
 * 新建表格默认预填的可见空白行数量。
 *
 * ：历史上这里是 12，新建表格后前端会落库 12 条空白记录，用来让网格
 * "看起来不空"。但这些是**真实持久化的记录**，结果用户一新建表就看到
 * 12 条无业务数据的"记录"，与"新表应为空表"的预期冲突，也污染记录数 / 导出 /
 * Agent 读表。
 *
 * 修复：默认不再预填任何记录，新表即空表（0 条记录）。空白可输入行由网格
 * 自身常驻的 append row 提供（canvas grid `hasAppendRow`），无需落库占位行。
 * 保留 `count` 入参，调用方仍可显式要求预填若干行。
 */
export const MIN_NEW_TABLE_VISIBLE_ROW_COUNT = 0

export const prefillNewTableRows = async (
  tableId: string,
  options?: { count?: number }
): Promise<void> => {
  const requestedCount = options?.count ?? MIN_NEW_TABLE_VISIBLE_ROW_COUNT
  const minVisibleCount = Number.isFinite(requestedCount)
    ? Math.max(0, Math.floor(requestedCount))
    : MIN_NEW_TABLE_VISIBLE_ROW_COUNT

  if (!tableId || minVisibleCount <= 0) {
    return
  }

  const existingRecords = await RecordApiService.getRecordsByTable(tableId, { page_size: 1 })
  const existingCount = existingRecords.data?.total ?? 0
  const missingCount = Math.max(0, minVisibleCount - existingCount)

  if (missingCount <= 0) {
    return
  }

  const result = await RecordApiService.bulkCreateRecords({
    table_id: tableId,
    records: Array.from({ length: missingCount }, () => ({})),
  })

  if (result.errors.length > 0 || result.success_count < missingCount) {
    throw new Error(
      `新表空白行补齐未完成：期望 ${missingCount}，实际成功 ${result.success_count}，错误 ${result.errors.length} 条`
    )
  }
}
