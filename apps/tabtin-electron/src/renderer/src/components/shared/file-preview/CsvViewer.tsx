import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, FileSpreadsheet } from 'lucide-react'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import { LOCAL_TEXT_PREVIEW_BYTES } from '@components/shared/file-utils'

const DEFAULT_MAX_ROWS = 500

export interface ParsedCsvPreview {
  headers: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
}

export interface ParseCsvPreviewOptions {
  delimiter?: string
  hasHeader?: boolean
  maxRows?: number
}

interface CsvViewerProps {
  filePath?: string
  fileName?: string
  content?: string
  truncated?: boolean
  className?: string
}

type CsvViewerState =
  | { status: 'loading' }
  | { status: 'ready'; content: string; truncated?: boolean }
  | { status: 'error'; message: string }

function encodeCol(n: number): string {
  let s = ''
  let idx = n + 1
  while (idx > 0) {
    idx--
    s = String.fromCharCode(65 + (idx % 26)) + s
    idx = Math.floor(idx / 26)
  }
  return s
}

function parseCsvRows(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  const pushCell = () => {
    row.push(cell)
    cell = ''
  }

  const pushRow = () => {
    pushCell()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    const next = content[i + 1]

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (ch === delimiter && !inQuotes) {
      pushCell()
      continue
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++
      pushRow()
      continue
    }

    cell += ch
  }

  if (cell.length > 0 || row.length > 0 || content.length > 0) {
    pushRow()
  }

  return rows
}

export function parseCsvPreview(
  content: string,
  options: ParseCsvPreviewOptions = {},
): ParsedCsvPreview {
  const delimiter = options.delimiter ?? ','
  const hasHeader = options.hasHeader ?? true
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const rawRows = parseCsvRows(content, delimiter)
    .filter((row) => row.some((cell) => cell.length > 0))

  if (rawRows.length === 0) {
    return { headers: [], rows: [], totalRows: 0, truncated: false }
  }

  const dataRows = hasHeader ? rawRows.slice(1) : rawRows
  const baseHeaders = hasHeader ? rawRows[0] : []
  const maxCols = Math.max(
    baseHeaders.length,
    ...dataRows.map((row) => row.length),
  )
  const headers = Array.from({ length: maxCols }, (_, idx) => {
    const header = baseHeaders[idx]
    return hasHeader ? (header || encodeCol(idx)) : encodeCol(idx)
  })
  const rows = dataRows
    .slice(0, maxRows)
    .map((row) => Array.from({ length: maxCols }, (_, idx) => row[idx] ?? ''))

  return {
    headers,
    rows,
    totalRows: dataRows.length,
    truncated: dataRows.length > maxRows,
  }
}

export const CsvViewer: React.FC<CsvViewerProps> = ({
  filePath,
  fileName = 'data.csv',
  content,
  truncated,
  className,
}) => {
  const [state, setState] = useState<CsvViewerState>(
    content !== undefined
      ? { status: 'ready', content, truncated }
      : { status: 'loading' },
  )

  useEffect(() => {
    if (content !== undefined) {
      setState({ status: 'ready', content, truncated })
      return
    }
    if (!filePath) {
      setState({ status: 'error', message: 'CSV 文件不可用' })
      return
    }

    let cancelled = false
    const readFilePreview = window.tabtin?.fileSystem?.readFilePreview
    setState({ status: 'loading' })

    if (!readFilePreview) {
      setState({ status: 'error', message: '文件预览服务不可用' })
      return () => {
        cancelled = true
      }
    }

    readFilePreview(filePath, { maxBytes: LOCAL_TEXT_PREVIEW_BYTES })
      .then((result) => {
        if (cancelled) return
        if (result?.success === false) {
          throw new Error(result.error || 'CSV 预览失败')
        }
        const preview = result?.data
        if (preview?.kind !== 'text') {
          throw new Error('此文件无法作为 CSV 预览')
        }
        setState({
          status: 'ready',
          content: preview.content ?? '',
          truncated: preview.truncated,
        })
      })
      .catch((err) => {
        if (cancelled) return
        setState({
          status: 'error',
          message: formatIpcErrorForUser(err, 'CSV 预览失败'),
        })
      })

    return () => {
      cancelled = true
    }
  }, [content, filePath, truncated])

  const parsed = useMemo(
    () => {
      if (state.status !== 'ready') return null
      const looksLikeTsv = /\.tsv(\?|#|$)/i.test(fileName) || /\.tsv(\?|#|$)/i.test(filePath ?? '')
      return parseCsvPreview(state.content, { delimiter: looksLikeTsv ? '\t' : ',' })
    },
    [fileName, filePath, state],
  )

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center text-center', className)}>
        <AlertCircle className="mb-2 h-6 w-6 text-destructive/45" strokeWidth={1} />
        <p className="text-body text-destructive/65">{state.message}</p>
        {filePath && (
          <button
            type="button"
            onClick={() => void window.tabtin?.openPath?.(filePath)}
            className="mt-3 flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-caption text-primary transition-colors hover:bg-primary/20"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            用系统应用打开
          </button>
        )}
      </div>
    )
  }

  if (!parsed || parsed.headers.length === 0) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center', className)}>
        <FileSpreadsheet className="mb-2 h-8 w-8 text-muted-foreground/20" strokeWidth={1} />
        <p className="text-body text-muted-foreground/45">CSV 文件为空</p>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <ScrollArea className="min-h-0 flex-1" scrollBar="both">
        <div className="min-w-full">
          <table className="border-separate border-spacing-0 text-body">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 h-8 w-12 border-b border-r border-border/40 bg-muted text-center font-medium text-muted-foreground/60">
                  {' '}
                </th>
                {parsed.headers.map((header, idx) => (
                  <th
                    key={`${header}-${idx}`}
                    className="sticky top-0 z-10 h-8 min-w-[128px] max-w-[280px] border-b border-r border-border/35 bg-muted px-2 text-left font-medium text-muted-foreground/75"
                  >
                    <span className="block truncate">{header || encodeCol(idx)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((row, rowIdx) => (
                <tr key={rowIdx}>
                  <th className="sticky left-0 z-10 h-8 w-12 border-b border-r border-border/35 bg-muted/30 text-center font-medium tabular-nums text-muted-foreground/65">
                    {rowIdx + 1}
                  </th>
                  {parsed.headers.map((_, colIdx) => (
                    <td
                      key={colIdx}
                      className="h-8 min-w-[128px] max-w-[280px] border-b border-r border-border/20 px-2 align-middle text-foreground/85"
                    >
                      <span className="block whitespace-pre-wrap break-words">
                        {row[colIdx] || ''}
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ScrollArea>
      {(parsed.truncated || state.truncated) && (
        <div className="shrink-0 border-t border-border/30 px-3 py-1.5 text-center text-caption text-muted-foreground/60">
          仅展示前 {parsed.rows.length} 行，完整内容请用系统应用打开{fileName ? `：${fileName}` : ''}
        </div>
      )}
    </div>
  )
}

CsvViewer.displayName = 'CsvViewer'
