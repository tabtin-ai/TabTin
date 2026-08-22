export interface RipgrepSearchRange {
  /** 相对于返回行文本的 0-based JavaScript 字符偏移。 */
  start: number
  end: number
}

export type RipgrepCaseMode = 'smart' | 'sensitive' | 'insensitive'

/** 与 ripgrep smart-case 尽量一致的 Unicode 大写字母检测。 */
export function hasUnicodeUppercase(value: string): boolean {
  return /\p{Lu}/u.test(value)
}

export interface RipgrepSearchByteRange {
  /** 相对于完整文件内容的 0-based UTF-8 字节偏移。 */
  start: number
  end: number
}

export interface RipgrepSearchReplacement {
  /** 相对于完整文件内容的 0-based UTF-8 字节范围。 */
  byteRange: RipgrepSearchByteRange
  /** 相对于返回行文本的 0-based JavaScript 字符范围。 */
  range: RipgrepSearchRange
  /** rg 返回的原始 submatch 文本。 */
  matchText: string
  /** rg 按 Rust replacement 语法计算出的替换预览；空字符串表示合法删除。 */
  replacement?: string
  /** 预览字段缺失时的明确错误，不能据此生成写回 edit。 */
  replacementError?: 'missing_preview'
}

/** 普通侧栏搜索：单文件默认匹配行上限（rg --max-count）。 */
export const RIPGREP_DEFAULT_PER_FILE_MAX_COUNT = 50
/** 单文件「加载更多」再搜时的匹配行上限。 */
export const RIPGREP_LOAD_MORE_PER_FILE_MAX_COUNT = 500

export interface RipgrepSearchOptions {
  cwd: string
  pattern: string
  /** 旧调用仍使用单个 include glob。 */
  glob?: string
  includeGlobs?: string[]
  excludeGlob?: string
  excludeGlobs?: string[]
  maxResults?: number
  /**
   * 单文件匹配行上限（rg --max-count）。
   * 普通搜索默认 50；替换预览不传 max-count；加载更多可传更高值。
   */
  maxCount?: number
  /**
   * 仅搜索该文件（绝对路径，或相对 cwd）。
   * 用于「加载更多」；此时跳过目录级 exclude glob，避免已展示文件被护栏挡掉。
   */
  searchPath?: string
  includePathMatches?: boolean
  /** undefined=rg smart-case，true=case-sensitive，false=ignore-case。 */
  matchCase?: boolean
  wholeWord?: boolean
  isRegex?: boolean
  /** 兼容早期实验调用方；isRegex 优先。 */
  useRegex?: boolean
  includeIgnored?: boolean
  /** 可选的 rg replacement 表达式；由主进程按搜索模式决定是否转义 `$`。 */
  replace?: string
  /** renderer 取消搜索时使用；旧调用可以不传。 */
  requestId?: string
}

export interface RipgrepSearchResult {
  file: string
  line: number
  /** 0-based 字符列，供 renderer/Monaco 使用；不是 rg 的 UTF-8 字节列。 */
  column: number
  text: string
  matchText: string
  isDirectory?: boolean
  matchKind?: 'content' | 'path'
  ranges?: RipgrepSearchRange[]
  byteRange?: RipgrepSearchByteRange
  /** 保留旧字段，同时传递同一行中的全部 submatch 替换预览。 */
  replacements?: RipgrepSearchReplacement[]
  replacement?: string
  replacementError?: 'missing_preview'
  isBinary?: boolean
}

export interface RipgrepSearchSuccess {
  success: true
  results: RipgrepSearchResult[]
  /**
   * 任一搜索维度未完整（内容或文件名遍历）。
   * 旧调用方继续读这个字段；替换门禁应改看 contentTruncated。
   */
  truncated?: boolean
  /** 内容搜索 / 结果容量 / max-buffer 导致内容结果不完整；唯一可阻断替换的信号。 */
  contentTruncated?: boolean
  /** 仅文件名/目录名遍历未完成；不阻断已完整预览的内容替换。 */
  pathMatchesTruncated?: boolean
}

export interface RipgrepSearchFailure {
  success: false
  results: RipgrepSearchResult[]
  error?: string
  errorCode?: string
  canceled?: boolean
}

export type RipgrepSearchResponse = RipgrepSearchSuccess | RipgrepSearchFailure

export interface ReplaceInFilesEdit {
  file: string
  byteStart: number
  byteEnd: number
  expectedText: string
  replacement: string
}

export type ReplaceInFileStatus = 'success' | 'skipped' | 'failed'

export interface ReplaceInFileResult {
  file: string
  status: ReplaceInFileStatus
  replacementCount: number
  reason?: string
}

export interface ReplaceInFilesRequest {
  rootPath: string
  edits: ReplaceInFilesEdit[]
}

export interface ReplaceInFilesResponse {
  success: boolean
  status?: 'complete' | 'partial' | 'failed'
  files: ReplaceInFileResult[]
  totalReplacements: number
  error?: string
}
