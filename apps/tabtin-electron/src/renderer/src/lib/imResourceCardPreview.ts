export interface IMResourceCardTablePreview {
  columns: Array<{ key: string; label: string }>
  rows: Array<Record<string, string>>
  total_rows?: number
}

export type DocumentPreviewLineKind = 'h1' | 'h2' | 'h3' | 'body' | 'list' | 'quote'

export interface DocumentPreviewLine {
  text: string
  kind: DocumentPreviewLineKind
}

const DOC_PREVIEW_MAX_LINES = 10

/** 去掉行内 markdown 标记（粗体/斜体/行内代码/链接/图片），只保留可读文本。 */
export function stripInlineMarkdown(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片 → alt
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 文本
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体 **
    .replace(/__([^_]+)__/g, '$1') // 粗体 __
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // 斜体 *
    .replace(/~~([^~]+)~~/g, '$1') // 删除线
    .trim()
}

/**
 * 把文档开头内容解析成轻量预览行：识别 markdown 的标题 / 列表 / 引用 block，
 * 行内标记去噪。纯文本（无 markdown）退化为普通段落。去掉与标题重复的首行。
 */
export function formatDocumentPreviewLines(
  rawText: string | undefined,
  title: string | undefined,
): DocumentPreviewLine[] {
  const normalizedTitle = title?.trim().toLowerCase()
  const rawLines = (rawText ?? '').split(/\r?\n/)

  const result: DocumentPreviewLine[] = []
  let titleSkipped = false
  let inCodeFence = false

  const maybeSkipTitle = (text: string): boolean => {
    if (!titleSkipped && normalizedTitle && text.toLowerCase() === normalizedTitle) {
      titleSkipped = true
      return true
    }
    return false
  }

  for (const raw of rawLines) {
    if (result.length >= DOC_PREVIEW_MAX_LINES) break
    const line = raw.trim()
    if (!line) continue

    // 代码围栏：跳过 ``` 及其内容（预览不渲染代码块）
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue

    // 分隔线
    if (/^([-*_])\1{2,}$/.test(line)) continue

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const text = stripInlineMarkdown(heading[2])
      if (!text || maybeSkipTitle(text)) continue
      const level = heading[1].length
      result.push({ text, kind: level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3' })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      const text = stripInlineMarkdown(quote[1])
      if (text) result.push({ text, kind: 'quote' })
      continue
    }

    const listItem = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listItem) {
      const text = stripInlineMarkdown(listItem[2])
      if (text) result.push({ text, kind: 'list' })
      continue
    }

    const text = stripInlineMarkdown(line)
    if (!text || maybeSkipTitle(text)) continue
    result.push({ text, kind: 'body' })
  }

  return result
}

export function buildTablePreviewFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  description: string | undefined,
): IMResourceCardTablePreview | undefined {
  const fieldNames = Array.isArray(metadata?.field_names)
    ? metadata!.field_names.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : []
  if (fieldNames.length === 0) {
    const fromDescription = description
      ?.split('|')
      .map((part) => part.trim())
      .filter(Boolean)
    if (!fromDescription?.length) return undefined
    return {
      columns: fromDescription.slice(0, 4).map((label, index) => ({
        key: `col-${index}`,
        label,
      })),
      rows: [],
      total_rows: typeof metadata?.record_count === 'number' ? metadata.record_count : undefined,
    }
  }
  return {
    columns: fieldNames.slice(0, 4).map((label, index) => ({
      key: `col-${index}`,
      label,
    })),
    rows: [],
    total_rows: typeof metadata?.record_count === 'number' ? metadata.record_count : undefined,
  }
}

export function mergeTablePreview(
  stored: IMResourceCardTablePreview | undefined,
  fromMetadata: IMResourceCardTablePreview | undefined,
): IMResourceCardTablePreview | undefined {
  if (stored?.columns?.length) {
    return {
      columns: stored.columns,
      rows: stored.rows ?? [],
      total_rows: stored.total_rows ?? fromMetadata?.total_rows,
    }
  }
  return fromMetadata
}
