/**
 * Cell value display utilities.
 *
 * 从多处重复实现中提炼的通用格式化函数。
 */

/**
 * 将任意单元格值转换为可显示字符串。
 *
 * @param value   - 任意单元格值
 * @param options - 可选配置
 * @param options.emptyLabel - 空值占位符（默认 '-'）
 * @returns 格式化后的字符串
 *
 * @example
 * formatCellValue(null)                 // '-'
 * formatCellValue(true)                 // '✓'
 * formatCellValue(12345)               // '12,345'
 * formatCellValue([{ name: 'A' }])     // 'A'
 */
export function formatCellValue(
  value: unknown,
  options?: { emptyLabel?: string },
): string {
  const emptyLabel = options?.emptyLabel ?? '-'
  if (value === null || value === undefined) return emptyLabel
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (typeof value === 'number') return value.toLocaleString()
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return (
      value
        .map((v: unknown) =>
          typeof v === 'object' && v !== null
            ? ((v as Record<string, unknown>).name as string) ?? JSON.stringify(v)
            : String(v),
        )
        .join(', ') || emptyLabel
    )
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * 紧凑版格式化——用于空间有限的场景（如表格历史快照时间线）。
 *
 * 字符串超过 `maxLen` 截断，数组最多显示 `maxItems` 项。
 *
 * @param value   - 任意单元格值
 * @param options - 可选配置
 * @param options.emptyLabel - 空值占位符（默认 '-'）
 * @param options.maxLen     - 字符串截断长度（默认 20）
 * @param options.maxItems   - 数组最大显示项数（默认 2）
 * @returns 格式化后的紧凑字符串
 */
export function compactCellValue(
  value: unknown,
  options?: { emptyLabel?: string; maxLen?: number; maxItems?: number },
): string {
  const emptyLabel = options?.emptyLabel ?? '-'
  const maxLen = options?.maxLen ?? 20
  const maxItems = options?.maxItems ?? 2

  if (value === null || value === undefined) return emptyLabel
  if (typeof value === 'boolean') return value ? '✓' : '✗'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    return value.length > maxLen ? value.slice(0, maxLen) + '…' : value
  }
  if (Array.isArray(value)) {
    const display = value
      .slice(0, maxItems)
      .map((v: unknown) =>
        typeof v === 'object' && v !== null
          ? ((v as Record<string, unknown>).name as string) ?? '…'
          : String(v),
      )
      .join(', ')
    return display + (value.length > maxItems ? '…' : '') || emptyLabel
  }
  return '…'
}
