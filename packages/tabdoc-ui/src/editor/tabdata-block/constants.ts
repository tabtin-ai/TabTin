export const TABDATA_MIN_HEIGHT = 200
export const TABDATA_DEFAULT_HEIGHT = 400
export const TABDATA_MAX_HEIGHT = 800
export const TABDATA_KEYBOARD_STEP = 20
export const EMBED_LOADING_TIMEOUT_MS = 5_000
export const VIEW_SWITCH_TIMEOUT_MS = 10_000

/**
 * Embed 网格是否可渲染字段列。
 * - fields 已到 → ready
 * - 加载已尝试且「加载前」快照 field_count===0 → ready（合法空字段表）
 * - 切勿用 loadFields 失败后被 store 清零的 field_count 判断，否则会露出空列
 */
export function isEmbedFieldsReady(
  fieldsLength: number,
  options?: {
    loadAttempted?: boolean
    /** 发起 loadFields 之前的 table.field_count 快照 */
    expectedFieldCount?: number | null
  },
): boolean {
  if (fieldsLength > 0) return true
  if (options?.loadAttempted && options.expectedFieldCount === 0) return true
  return false
}
