import React from 'react'
import {
  type DocumentPreviewLine,
  type IMResourceCardTablePreview,
  formatDocumentPreviewLines,
} from '@/lib/imResourceCardPreview'

const TABLE_PREVIEW_MAX_ROWS = 4
const TABLE_PREVIEW_MAX_COLS = 4

/** "v1"、"v12" 等纯版本号占位符，或 "3 行 · 5 字段" 等元数据回落，不作为正文显示。 */
function isMetadataFallback(text: string | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (/^v\d+$/.test(t)) return true
  if (/^\d+\s+行\s*[·•]\s*\d+\s+字段$/.test(t)) return true
  return false
}

export const DocumentPreviewBody: React.FC<{
  text?: string
  title?: string
  emptyLabel: string
}> = ({ text, title, emptyLabel }) => {
  const effectiveText = isMetadataFallback(text) ? undefined : text
  const lines = formatDocumentPreviewLines(effectiveText, title)
  if (!lines.length) {
    return (
      <div className="space-y-2 py-1">
        <div className="h-3 w-4/5 rounded bg-foreground/[0.06]" />
        <div className="h-2.5 w-full rounded bg-foreground/[0.05]" />
        <div className="h-2.5 w-11/12 rounded bg-foreground/[0.05]" />
        <div className="h-2.5 w-10/12 rounded bg-foreground/[0.04]" />
        <p className="pt-1 text-caption text-muted-foreground/60">{emptyLabel}</p>
      </div>
    )
  }

  return (
    <div className="space-y-1 text-body leading-[1.55] text-foreground/85">
      {lines.map((line, index) => (
        <PreviewLine key={`${line.text}-${index}`} line={line} />
      ))}
    </div>
  )
}

const PreviewLine: React.FC<{ line: DocumentPreviewLine }> = ({ line }) => {
  switch (line.kind) {
    case 'h1':
      return <p className="text-body font-semibold text-foreground">{line.text}</p>
    case 'h2':
      return <p className="text-body font-semibold text-foreground">{line.text}</p>
    case 'h3':
      return <p className="text-body font-medium text-foreground/90">{line.text}</p>
    case 'list':
      return (
        <div className="flex gap-1.5">
          <span className="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-foreground/40" />
          <span className="min-w-0 flex-1">{line.text}</span>
        </div>
      )
    case 'quote':
      return (
        <p className="border-l-2 border-border/60 pl-2 italic text-muted-foreground">
          {line.text}
        </p>
      )
    default:
      return <p className="whitespace-pre-wrap">{line.text}</p>
  }
}

export const TablePreviewBody: React.FC<{
  snapshot?: IMResourceCardTablePreview
  emptyLabel: string
}> = ({ snapshot, emptyLabel }) => {
  const columns = (snapshot?.columns ?? []).slice(0, TABLE_PREVIEW_MAX_COLS)
  if (!columns.length) {
    return (
      <div className="py-2 text-caption text-muted-foreground/60">{emptyLabel}</div>
    )
  }

  const rows = (snapshot?.rows ?? []).slice(0, TABLE_PREVIEW_MAX_ROWS)
  const placeholderRowCount = rows.length > 0 ? 0 : Math.min(3, TABLE_PREVIEW_MAX_ROWS)

  return (
    <div className="overflow-hidden rounded-md border border-border/25">
      <table className="w-full table-fixed text-caption">
        <thead>
          <tr className="border-b border-border/20 bg-muted/30">
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-2 py-1.5 text-left font-medium text-muted-foreground truncate"
                title={col.label}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/10 last:border-0">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-2 py-1 text-foreground/80 truncate"
                  title={String(row[col.key] ?? '')}
                >
                  {String(row[col.key] ?? '') || '—'}
                </td>
              ))}
            </tr>
          ))}
          {Array.from({ length: placeholderRowCount }).map((_, rowIndex) => (
            <tr key={`placeholder-${rowIndex}`} className="border-b border-border/10 last:border-0">
              {columns.map((col) => (
                <td key={col.key} className="px-2 py-1">
                  <span className="block h-2 w-3/4 rounded-full bg-foreground/[0.06]" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
