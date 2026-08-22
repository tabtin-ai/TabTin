import type { RipgrepCaseMode } from '@shared/ripgrep-search-types'

/** Monaco 默认的 word separator 集合，供 findMatches 的 whole-word 参数使用。 */
export const DEFAULT_WORD_SEPARATORS = ' \t~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?'

/**
 * 工程搜索点结果 → 编辑器静默高亮定位的意图形状。
 * （文件内 ⌘F 若复用本会话，再扩展字段，勿提前预留死参数。）
 */

export interface EditorFindOccurrence {
  /** 1-based 行号 */
  line: number
  /** 1-based Monaco 列（字符列）；不可靠时由会话按行内匹配回退 */
  column?: number
}

export interface EditorFindRequest {
  query: string
  /** 同一 query 再次触发时递增，强制重跑会话 */
  key: number
  /** 与工程搜索一致的大小写语义；旧调用仍可用 caseSensitive。 */
  caseMode?: RipgrepCaseMode
  caseSensitive?: boolean
  isRegex?: boolean
  wholeWord?: boolean
  preferOccurrence?: EditorFindOccurrence
}
