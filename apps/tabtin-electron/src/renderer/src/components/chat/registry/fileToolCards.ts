/**
 * 文件操作 + 代码搜索 + Git + 外部 Agent 文件类工具
 */

import type { ToolCardDescriptor, ToolOutputData } from '@tabtin/chat-client'
import { basename, truncate, getNestedArgs, unwrapData } from './toolCardUtils'

/* ─── 输出提取器 ─── */

export type ApplyPatchDiffHunk = {
  file: string
  old_start_line: number
  new_start_line: number
  old_lines: string[]
  new_lines: string[]
}

export function parseApplyPatchChanges(changes: unknown): ApplyPatchDiffHunk[] {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return []

  return Object.entries(changes as Record<string, unknown>).flatMap(([file, change]) => {
    if (!change || typeof change !== 'object') return []
    const unifiedDiff = (change as Record<string, unknown>).unified_diff
    if (typeof unifiedDiff !== 'string' || !unifiedDiff.trim()) return []

    const hunks: ApplyPatchDiffHunk[] = []
    let current: ApplyPatchDiffHunk | null = null
    for (const line of unifiedDiff.split('\n')) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (header) {
        current = {
          file,
          old_start_line: Number(header[1]),
          new_start_line: Number(header[2]),
          old_lines: [],
          new_lines: [],
        }
        hunks.push(current)
      } else if (current && line.startsWith('-') && !line.startsWith('---')) {
        current.old_lines.push(line.slice(1))
      } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
        current.new_lines.push(line.slice(1))
      }
    }
    return hunks
  })
}

export function extractDiff(output: unknown): ToolOutputData | null {
  if (!output || typeof output !== 'object') return null
  const d = unwrapData(output)

  const hunks = parseApplyPatchChanges(d.changes)
  if (hunks.length > 0) {
    const first = hunks[0]
      return {
        kind: 'diff',
        file: first.file,
        start_line: first.new_start_line,
        end_line: first.new_start_line + Math.max(first.new_lines.length - 1, 0),
        old_lines: first.old_lines,
        new_lines: first.new_lines,
        hunks,
        replacements: hunks.length,
      } as ToolOutputData
  }

  // 外部 Agent batch-edit 形态（历史 MultiEdit / patch 工具等
  // 接入时输出可能是 `data.edits[]` 数组）：合并成单个伪 hunk 让 DiffCard 直接渲染，
  // 视觉上等价 GitHub PR 多 hunks 合并 view。我们 runtime 当前的 edit_file 是单 hunk
  // schema（与现行主流 edit_file schema 一致），不会走这条；保留
  // 仅为前端 fileToolCards `MultiEdit` / `apply_patch` 大写 alias 兼容外部 Agent 历史
  // 会话回放。
  if (Array.isArray(d.edits) && d.edits.length > 0) {
    const edits = d.edits as Array<Record<string, unknown>>
    const allOldLines: string[] = []
    const allNewLines: string[] = []
    let totalReplacements = 0
    let firstStartLine = Number.MAX_SAFE_INTEGER
    let lastEndLine = 0
    for (const e of edits) {
      const oldLines = Array.isArray(e.old_lines) ? (e.old_lines as string[]) : []
      const newLines = Array.isArray(e.new_lines) ? (e.new_lines as string[]) : []
      allOldLines.push(...oldLines)
      allNewLines.push(...newLines)
      totalReplacements += Number(e.replacements ?? 1)
      const startLine = Number(e.start_line ?? 0)
      const endLine = Number(e.end_line ?? startLine)
      if (startLine > 0 && startLine < firstStartLine) firstStartLine = startLine
      if (endLine > lastEndLine) lastEndLine = endLine
    }
    if (firstStartLine === Number.MAX_SAFE_INTEGER) firstStartLine = 1
    return {
      kind: 'diff',
      file: String(d.file ?? d.path ?? ''),
      start_line: firstStartLine,
      end_line: lastEndLine || firstStartLine,
      old_lines: allOldLines,
      new_lines: allNewLines,
      replacements: totalReplacements,
    }
  }

  if (!d.old_lines && !d.old_string) return null
  const oldLines = (d.old_lines as string[]) || (typeof d.old_string === 'string' ? (d.old_string as string).split('\n') : [])
  const newLines = (d.new_lines as string[]) || (typeof d.new_string === 'string' ? (d.new_string as string).split('\n') : [])
  return {
    kind: 'diff',
    file: String(d.file ?? d.path ?? ''),
    start_line: Number(d.start_line ?? 1),
    end_line: Number(d.end_line ?? (Number(d.start_line ?? 1) + oldLines.length - 1)),
    old_lines: oldLines,
    new_lines: newLines,
    replacements: Number(d.replacements ?? 1),
  }
}

/**
 * 解析 W2/W3 string output 形态——`buildTextReadToolResult` 与 `runLocalDocParse`
 * 把成功路径输出从 JSON envelope 改成多行明文 string 后，前端 extractor 必须能
 * 识别这条 string 形态，否则 `FileReadCardRenderer` fallback 显示
 * `card.file_content_empty` 让用户以为 LLM 拿到的也是空。
 *
 * 三种 string 形态（按优先级匹配）：
 *
 *   1. PDF / DOCX / XLSX（W3 `runLocalDocParse`）：
 *      `<system-reminder>Document: foo.pdf — N pages, MMb, parsed locally from /path</system-reminder>\n\n<正文>`
 *      → reminder 行作为 metadata 头，正文作为 `contentRaw` 主体
 *   2. read_file 空文件 / offset 越界 warning（W2 `buildTextReadToolResult`）：
 *      `<system-reminder>Warning: ...</system-reminder>`（无 body）
 *      → reminder 内容直接作为 `contentRaw` 显示
 *   3. read_file 文本成功（W2 `buildTextReadToolResult`）：
 *      `1\tcontent\n2\tcontent\n...` cat -n 多行明文
 *      → 整段作为 `content`（FileReadCard `stripLineNumbers` 兜底解析行号 + 起始行）
 *
 * **不能拿到的元信息**：`path` / `start_line` / `total_lines` / `num_lines` 在
 * string 形态下都丢失了——`FileReadCardRenderer` 从 `input.path` 补 path，行
 * 号靠前缀解析。这是与 object 形态相比唯一的视觉降级，但避免了"显示空"的产品级
 * 视觉破绽。
 */
function parseStringFileReadOutput(text: string): ToolOutputData | null {
  if (text.length === 0) return null
  const reminderMatch = text.match(
    /^<system-reminder>([\s\S]*?)<\/system-reminder>\n*([\s\S]*)$/,
  )
  if (reminderMatch) {
    const reminderText = reminderMatch[1].trim()
    const body = reminderMatch[2]
    return {
      kind: 'file_read',
      // path 由 renderer 从 input 补；extractor 拿不到 input。
      path: '',
      contentRaw: body ? `[${reminderText}]\n\n${body}` : `[${reminderText}]`,
    }
  }
  return {
    kind: 'file_read',
    path: '',
    content: text,
  }
}

export function extractFileRead(output: unknown): ToolOutputData | null {
  // W2/W3 (2026-05-10): read_file 文本成功路径 + PDF/DOCX/XLSX 解析成功路径都
  // 走多行明文 string 输出（envelope 已删）。string 分支必须先于 typeof 检查
  // 命中，否则 fallthrough 到 `typeof output !== 'object'` 直接 return null →
  // FileReadCardRenderer 走 fallback → 显示 `card.file_content_empty`。
  if (typeof output === 'string') {
    return parseStringFileReadOutput(output)
  }
  if (!output || typeof output !== 'object') return null
  const d = unwrapData(output)
  if (d.type === 'file_materialized' && d.success === true) {
    return {
      kind: 'materialized_files',
      file_count: 1,
    }
  }
  const content = d.content as string | undefined
  const contentRaw = d.contentRaw as string | undefined
  // 既没有行号化的 content，也没有 raw content，认为不是 file_read 输出。
  if (typeof content !== 'string' && typeof contentRaw !== 'string') return null
  return {
    kind: 'file_read',
    path: String(d.path ?? ''),
    content,
    contentRaw,
    start_line: typeof d.start_line === 'number' ? (d.start_line as number) : undefined,
    total_lines: typeof d.total_lines === 'number' ? (d.total_lines as number) : undefined,
    num_lines: typeof d.num_lines === 'number' ? (d.num_lines as number) : undefined,
  }
}

/**
 * T2-SEV-1 (2026-05-12)：识别 grep_search / glob_search 的"零结果固定文案"和
 * "截断说明行"，避免 UI 把它们当成"1 条匹配"误显示。
 *
 * **背景**：T2-C1 改造把 grep/glob 0 匹配从空字符串改成清晰文案：
 *   - "No matches found." (grep content mode)
 *   - "Found 0 total occurrences across 0 files." (grep count mode)
 *   - "No files found." (grep files_with_matches / glob)
 *
 * 旧 extractCodeSearch 只要 `output` 字符串非空就当结果解析，会把 "No matches
 * found." 拆成 1 行 → match_count=1 显示"找到 1 条"，跟模型看到的"0 匹配"反向。
 *
 * 同时需识别 adapter `applyHeadLimit` / glob wrapper 输出的截断说明行：
 *   - `... truncated (showing X of at least Y matches, offset=Z). ...`
 *   - `(Results are truncated: showing first N of M+ results. Consider ...)`
 *   - `(no matches in this page)` (offset 越界场景)
 */
const ZERO_RESULT_OUTPUTS = new Set<string>([
  'No matches found.',
  'No files found.',
  'Found 0 total occurrences across 0 files.',
])

// T2 final reviewer R2/R3 共识：count 模式 0 匹配 adapter 输出双段复合文案
// `No matches found.\n\nFound 0 total occurrences across 0 files.`
// —— ZERO_RESULT_OUTPUTS 单行字符串 set 不命中复合文案 → 卡片把 2 行非空内容
// 当 2 条假匹配显示「找到 2 条」，跟 LLM 看到的「0 匹配」反向。
// 修：识别「整段输出 = 多个 ZERO_RESULT_OUTPUTS 行的 + truncate 行 + 空行」
function isFullZeroResultOutput(rawOutput: string): boolean {
  const trimmed = rawOutput.trim()
  if (ZERO_RESULT_OUTPUTS.has(trimmed)) return true
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  return lines.every((line) => ZERO_RESULT_OUTPUTS.has(line))
}

function isTruncationNoticeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  return (
    trimmed.startsWith('... truncated') ||
    trimmed.startsWith('(Results are truncated') ||
    trimmed === '(no matches in this page)'
  )
}

// T2 follow-up B3 (2026-05-12)：grep files_with_matches 模式 / glob_search 输出
// 现在带 `Found N files` / `Found N file (limit: 250, offset: 0)` 汇总头。
// 卡片解析路径行时要把汇总头行过滤掉，否则会被当成假匹配。
function isSummaryHeaderLine(line: string): boolean {
  const trimmed = line.trim()
  return /^Found \d+ files?(\s|$)/.test(trimmed)
}

export function extractCodeSearch(output: unknown): ToolOutputData | null {
  if (!output || typeof output !== 'object') return null
  const d = unwrapData(output)
  const matches: Array<{ file: string; line: number; text: string }> = []

  if (Array.isArray(d.matches)) {
    for (const m of d.matches as Array<Record<string, unknown>>) {
      matches.push({
        file: String(m.file ?? m.path ?? ''),
        line: Number(m.line ?? m.line_number ?? 0),
        text: String(m.text ?? m.content ?? ''),
      })
    }
  } else if (typeof d.output === 'string' && (d.output as string).length > 0) {
    const rawOutput = d.output as string
    // T2-SEV-1 + final R2/R3：零结果文案（含 count 模式双段复合） → 返回 0 匹配
    if (isFullZeroResultOutput(rawOutput)) {
      return {
        kind: 'code_search',
        matches: [],
        match_count: 0,
      }
    }
    const lines = (d.output as string).split('\n').filter(Boolean)
    for (const line of lines.slice(0, 100)) {
      // T2-SEV-1：跳过 truncate 说明行 / "(no matches in this page)"
      if (isTruncationNoticeLine(line)) continue
      // T2 follow-up B3：跳过 "Found N files" 汇总头（B3 加的 chrome 不是匹配）
      if (isSummaryHeaderLine(line)) continue
      const ci = line.indexOf(':')
      const ci2 = ci >= 0 ? line.indexOf(':', ci + 1) : -1
      if (ci2 > ci) {
        matches.push({ file: line.slice(0, ci), line: parseInt(line.slice(ci + 1, ci2), 10) || 0, text: line.slice(ci2 + 1) })
      } else {
        // T2 follow-up E2 (2026-05-12)：无 `:数字:` 边界 = 纯路径行（glob_search 输出
        // 或 grep_search files_with_matches 模式）。原行为是 file:'', text: line —— 让
        // CodeSearchCard 的 `basename(card.file)` title 显示为空，路径只在 preview。
        // 改成 file: line, text: '' —— 让 title 正常显示文件名，跟带匹配行的 grep 卡片一致
        matches.push({ file: line, line: 0, text: '' })
      }
    }
  } else if (Array.isArray(d.files)) {
    for (const f of d.files as string[]) {
      matches.push({ file: f, line: 0, text: '' })
    }
  }

  if (matches.length === 0) {
    // T2-SEV-1：明确的"无结果但工具成功"情况——total_files=0 / 文案识别命中
    // —— 返回 0 matches 让 UI 显示"无结果"而不是 null（=工具失败）
    if (typeof d.output === 'string' || typeof d.total_files === 'number') {
      return { kind: 'code_search', matches: [], match_count: 0 }
    }
    return null
  }
  return {
    kind: 'code_search',
    matches,
    // T2-SEV-1：优先用 adapter 给的 total_matches / total_files 真实总数，
    // 而不是被截断后的 matches.length（避免 UI 显示截断后数字）
    match_count: Number(
      d.count ?? d.match_count ?? d.total_matches ?? d.total_files ?? matches.length,
    ),
  }
}

export function extractFileWrite(output: unknown): ToolOutputData | null {
  if (!output || typeof output !== 'object') return null
  const d = unwrapData(output)
  if (!d.path) return null
  return { kind: 'file_write', path: String(d.path), size: typeof d.size === 'number' ? d.size : undefined }
}

/* ─── 描述符 ─── */

export const FILE_TOOL_CARDS: Record<string, ToolCardDescriptor> = {
  /* ── 文件操作 (high risk) ─── */
  edit_file: {
    id: 'diff', category: 'tool', labelKey: 'chat.card.diff', icon: 'FilePenLine',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'DiffCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? basename(String(args.path ?? '')) : null },
    extractOutput: extractDiff,
  },
  write_file: {
    id: 'file_write', category: 'tool', labelKey: 'chat.card.write_file', icon: 'FileText',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'FileWriteCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? basename(String(args.path ?? '')) : null },
    extractOutput: extractFileWrite,
  },
  delete_file: {
    id: 'file_delete', category: 'tool', labelKey: 'chat.card.delete_file', icon: 'FileX2',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'FileDeleteCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? basename(String(args.path ?? '')) : null },
  },

  /* ── 文件读取 (low risk) ─── */
  read_file: {
    id: 'file_read', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'FileReadCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      if (!args) return null
      const p = String(args.path ?? '')
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      const range = offset || limit ? ` (${offset || 1}\u2013${(offset || 1) + (limit || 0) - 1})` : ''
      return `${basename(p)}${range}`
    },
    extractOutput: extractFileRead,
  },

  /* ── 代码搜索 (low risk) ─── */
  grep_search: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'CodeSearchCard',
    compactSummary: (input) => {
      const args = getNestedArgs(input)
      if (!args) return null
      return `/${args.pattern ?? ''}/${args.glob ? ` ${args.glob}` : ''}`
    },
    extractOutput: extractCodeSearch,
  },
  glob_search: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'CodeSearchCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args ? String(args.glob_pattern ?? '') : null },
    extractOutput: extractCodeSearch,
  },
  semantic_search: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'CodeSearchCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.query ? truncate(String(args.query), 50) : null },
    extractOutput: extractCodeSearch,
  },

  /* ── 文档解析 ─── */
  // W7：parse_document 改造为双层结果（parsing/pending/success/partial 状态机），
  // 主视觉走 RICH_CONTENT 推送的 `document_excerpt` 卡片，tool_call 行卡片仅作为
  // secondary "查看原始调用"。此前 FileReadCard 在 parsing/pending 时无 content 字段
  // 会显示空——改用 GenericToolCard 让用户看到 status / message 等结构化字段而不是空。
  parse_document: {
    id: 'doc_parse', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },

  /* ── Git ─── */
  git_status: {
    id: 'git', category: 'tool', labelKey: 'chat.card.git_status', icon: 'GitBranch',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  git_diff: {
    id: 'git', category: 'tool', labelKey: 'chat.card.git_diff', icon: 'GitCompare',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
    compactSummary: (input) => { const args = getNestedArgs(input); return args?.path ? basename(String(args.path)) : null },
  },

  /* ── 外部 Agent 文件类工具 ─── */
  Edit: {
    id: 'diff', category: 'tool', labelKey: 'chat.card.diff', icon: 'FilePenLine',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'DiffCard', extractOutput: extractDiff,
  },
  apply_patch: {
    id: 'diff', category: 'tool', labelKey: 'chat.card.diff', icon: 'FilePenLine',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'DiffCard', extractOutput: extractDiff,
  },
  Read: {
    id: 'file_read', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'FileReadCard', extractOutput: extractFileRead,
  },
  cat: {
    id: 'file_read', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'FileReadCard', extractOutput: extractFileRead,
  },
  Grep: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'CodeSearchCard', extractOutput: extractCodeSearch,
  },
  Glob: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'Search',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'CodeSearchCard', extractOutput: extractCodeSearch,
  },
  Write: {
    id: 'file_write', category: 'tool', labelKey: 'chat.card.write_file', icon: 'FileText',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'FileWriteCard', extractOutput: extractFileWrite,
  },
  LS: {
    id: 'code_search', category: 'tool', labelKey: 'chat.card.code_search', icon: 'FolderTree',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  MultiEdit: {
    id: 'diff', category: 'tool', labelKey: 'chat.card.diff', icon: 'FilePenLine',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'DiffCard', extractOutput: extractDiff,
  },
  NotebookRead: {
    id: 'file_read', category: 'tool', labelKey: 'chat.card.read_file', icon: 'FileText',
    riskLevel: 'safe', defaultCollapsed: true, renderer: 'GenericToolCard',
  },
  NotebookEdit: {
    id: 'diff', category: 'tool', labelKey: 'chat.card.diff', icon: 'FilePenLine',
    riskLevel: 'strict', defaultCollapsed: false, renderer: 'GenericToolCard',
  },
}
