/**
 * XlsxViewer - XLSX 文件预览组件
 *
 * 使用 SheetJS (xlsx) 解析 XLSX 并渲染为 HTML 表格，支持多 sheet 切换
 */

import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ExternalLink, FileSpreadsheet, FunctionSquare, Table2 } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { checkFileSize, formatFileSize, MAX_OFFICE_FILE_BYTES } from '@components/shared/file-utils'
import { formatIpcErrorForUser } from '@/services/ipc-error'
import XlsxPreviewWorker from './xlsxPreview.worker?worker'
import {
  XLSX_PREVIEW_MAX_RENDER_ROWS,
  XLSX_PREVIEW_MAX_SHEETS,
  isOldXlsxFormatError,
  parseXlsxPreview,
  type XlsxPreviewParseResult,
  type XlsxPreviewSheet,
} from './xlsxPreviewParser'

interface XlsxViewerProps {
  /** 本地文件路径（tabfolder 用法）。与 data 二选一。 */
  filePath?: string
  /** 内存中的 xlsx 二进制（聊天预览用法）。优先于 filePath。 */
  data?: ArrayBuffer
  className?: string
}

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

type WorkerParseSuccess = {
  id: number
  ok: true
  result: XlsxPreviewParseResult
}

type WorkerParseFailure = {
  id: number
  ok: false
  message: string
  oldFormat: boolean
}

let parseRequestId = 0
export const XLSX_PREVIEW_WORKER_TIMEOUT_MS = 5_000

class XlsxPreviewWorkerUnavailableError extends Error {
  constructor(message = 'XLSX preview worker is unavailable') {
    super(message)
    this.name = 'XlsxPreviewWorkerUnavailableError'
  }
}

function isWorkerOldFormatError(error: unknown): boolean {
  return error instanceof Error && error.name === 'OldXlsxFormatError'
}

function isWorkerUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.name === 'XlsxPreviewWorkerUnavailableError'
}

function createAbortError(): Error {
  const error = new Error('XLSX preview parsing was cancelled')
  error.name = 'AbortError'
  return error
}

function parseXlsxPreviewInWorker(
  buffer: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<XlsxPreviewParseResult> {
  return new Promise((resolve, reject) => {
    const requestId = ++parseRequestId
    let worker: Worker
    try {
      worker = new XlsxPreviewWorker()
    } catch (error) {
      reject(new XlsxPreviewWorkerUnavailableError(error instanceof Error ? error.message : undefined))
      return
    }
    const transferable = buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer.slice(0)
    const timeout = { id: undefined as ReturnType<typeof setTimeout> | undefined }
    let settled = false
    const cleanup = () => {
      if (timeout.id !== undefined) clearTimeout(timeout.id)
      signal?.removeEventListener('abort', abortHandler)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const abortHandler = () => settle(() => reject(createAbortError()))
    if (signal?.aborted) {
      abortHandler()
      return
    }
    signal?.addEventListener('abort', abortHandler, { once: true })
    timeout.id = setTimeout(() => {
      settle(() => reject(new Error('XLSX preview parsing timed out')))
    }, XLSX_PREVIEW_WORKER_TIMEOUT_MS)
    worker.onmessage = (event: MessageEvent<WorkerParseSuccess | WorkerParseFailure>) => {
      if (event.data.id !== requestId) return
      if (event.data.ok) {
        const { result } = event.data
        settle(() => resolve(result))
        return
      }
      const error = new Error(event.data.message)
      if (event.data.oldFormat) error.name = 'OldXlsxFormatError'
      settle(() => reject(error))
    }
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'XLSX worker failed')))
    }
    worker.postMessage({ id: requestId, buffer: transferable }, [transferable])
  })
}

async function parseWorkbookPreview(
  buffer: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<XlsxPreviewParseResult> {
  try {
    return await parseXlsxPreviewInWorker(buffer, signal)
  } catch (error) {
    if (isWorkerUnavailableError(error)) {
      // Vitest/jsdom 和部分旧内嵌运行时可能没有 Worker；只有 Worker 无法
      // 创建时才主线程兜底。Worker 内解析失败不能同步重试，避免坏文件拖垮 UI。
      if (signal?.aborted) throw createAbortError()
      return parseXlsxPreview(buffer)
    }
    throw error
  }
}

export const XlsxViewer: React.FC<XlsxViewerProps> = ({ filePath, data, className }) => {
  const { t } = useTranslation('context')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sheets, setSheets] = useState<XlsxPreviewSheet[]>([])
  const [activeSheetIndex, setActiveSheetIndex] = useState(0)
  const [activeCell, setActiveCell] = useState({ row: 0, col: 0 })
  const [sheetsLimited, setSheetsLimited] = useState(false)
  const [formulaCalculation, setFormulaCalculation] = useState({ cached: 0, calculated: 0, unavailable: 0 })
  const [fileTooLargeSize, setFileTooLargeSize] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const abortController = new AbortController()

    const load = async () => {
      setLoading(true)
      setError(null)
      setFileTooLargeSize(null)
      setSheets([])
      setActiveSheetIndex(0)
      setActiveCell({ row: 0, col: 0 })
      setSheetsLimited(false)
      setFormulaCalculation({ cached: 0, calculated: 0, unavailable: 0 })

      try {
        // readBinaryFile（W2-β 契约）可能返 ArrayBuffer 或 Uint8Array（Node Buffer
        // 经 IPC 到达 renderer 时为 Uint8Array）；下游 `new Uint8Array(buffer)` 两者皆收，
        // 故 buffer 用并集类型，避免 TS lib 收紧后的 ArrayBuffer/Uint8Array 不兼容。
        let buffer: ArrayBuffer | Uint8Array
        if (data) {
          if (data.byteLength > MAX_OFFICE_FILE_BYTES) {
            setFileTooLargeSize(data.byteLength)
            return
          }
          buffer = data
        } else if (filePath) {
          const sizeCheck = await checkFileSize(filePath)
          if (cancelled) return
          if (!sizeCheck.ok) {
            setFileTooLargeSize(sizeCheck.size)
            return
          }

          // contract W2-β：旧 envelope `{success, data, error}` 改为 invokeIpc 直接
          // 返 `{ data }` 或 throw —— cancellation guard 同 DocxViewer 模式：
          // catch 块也走 cancelled 检查，避免组件卸载后 setError。
          let result: { data?: ArrayBuffer | Uint8Array } | undefined
          try {
            result = await window.tabtin.fileSystem.readBinaryFile(filePath)
          } catch (err) {
            if (!cancelled) {
              setError(formatIpcErrorForUser(err, t('folder.errors.xlsxLoadFailed')))
            }
            return
          }
          if (cancelled) return

          if (!result?.data) {
            setError(t('folder.errors.xlsxLoadFailed'))
            return
          }
          buffer = result.data
        } else {
          return
        }

        const result = await parseWorkbookPreview(buffer, abortController.signal)
        if (cancelled) return

        setSheets(result.sheets)
        setSheetsLimited(result.sheetsLimited)
        setFormulaCalculation(result.formulaCalculation)
      } catch (err) {
        if (!cancelled) {
          if (isOldXlsxFormatError(err) || isWorkerOldFormatError(err)) {
            setError(t('folder.errors.xlsxFormatUnsupported'))
          } else {
            setError(err instanceof Error ? err.message : t('folder.errors.xlsxLoadFailed'))
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [filePath, data, t])

  const activeSheet = useMemo(() => {
    if (sheets.length === 0) return undefined
    const idx = Math.min(Math.max(0, activeSheetIndex), sheets.length - 1)
    return sheets[idx]
  }, [sheets, activeSheetIndex])

  const effectiveSheetIndex =
    sheets.length > 0 ? Math.min(Math.max(0, activeSheetIndex), sheets.length - 1) : 0
  const activeCellLabel = activeSheet
    ? `${encodeCol(Math.min(activeCell.col, Math.max(0, activeSheet.maxCols - 1)))}${Math.min(activeCell.row, Math.max(0, activeSheet.totalRows - 1)) + 1}`
    : 'A1'
  const activeCellValue = activeSheet?.cells[activeCell.row]?.[activeCell.col] ?? ''

  if (loading) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }

  if (fileTooLargeSize !== null) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full gap-3', className)}>
        <AlertCircle className="h-8 w-8 text-warning/40" strokeWidth={1} />
        <div className="text-center">
          <p className="text-body text-foreground/60">
            {t('folder.errors.fileTooLarge', 'File is too large to preview')}
          </p>
          <p className="text-caption text-muted-foreground/40 mt-1">
            {t('folder.errors.fileTooLargeDetail', {
              size: formatFileSize(fileTooLargeSize),
              limit: formatFileSize(MAX_OFFICE_FILE_BYTES),
              defaultValue: 'File size: {{size}}, preview limit: {{limit}}',
            })}
          </p>
        </div>
        {filePath && (
          <button
            type="button"
            onClick={() => window.tabtin.openPath(filePath!)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-caption bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('folder.labels.openWithSystemApp', 'Open with system app')}
          </button>
        )}
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full', className)}>
        <AlertCircle className="h-6 w-6 text-destructive/40 mb-2" strokeWidth={1} />
        <p className="text-body text-destructive/60">{error}</p>
      </div>
    )
  }

  if (!sheets.length || !activeSheet) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full', className)}>
        <FileSpreadsheet className="h-8 w-8 text-muted-foreground/20 mb-2" strokeWidth={1} />
        <p className="text-body text-muted-foreground/40">{t('folder.status.xlsxEmpty')}</p>
      </div>
    )
  }

  const isTruncated = activeSheet.totalRows > XLSX_PREVIEW_MAX_RENDER_ROWS

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/40 px-3 py-1.5">
        {sheets.map((sheet, idx) => (
          <button
            key={sheet.name}
            onClick={() => {
              setActiveSheetIndex(idx)
              setActiveCell({ row: 0, col: 0 })
            }}
            className={cn(
              'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-body font-medium transition-colors',
              idx === effectiveSheetIndex
                ? 'bg-muted text-foreground shadow-sm'
                : 'text-muted-foreground/80 hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <Table2 className="h-3.5 w-3.5" />
            <span className="max-w-[160px] truncate">{sheet.name}</span>
          </button>
        ))}
        {sheetsLimited && (
          <span className="shrink-0 px-2 text-caption text-muted-foreground/45">
            {t('folder.status.xlsxSheetsLimited', { max: XLSX_PREVIEW_MAX_SHEETS })}
          </span>
        )}
      </div>

      {(formulaCalculation.cached > 0 || formulaCalculation.calculated > 0 || formulaCalculation.unavailable > 0) && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 px-3 py-1.5 text-caption">
          {formulaCalculation.cached > 0 && (
            <span className="text-muted-foreground/60">
              {t('folder.status.xlsxFormulasCached', {
                count: formulaCalculation.cached,
                defaultValue: 'Showing {{count}} formula result(s) saved in the file.',
              })}
            </span>
          )}
          {formulaCalculation.calculated > 0 && (
            <span className="text-foreground/65">
              {t('folder.status.xlsxFormulasCalculated', {
                count: formulaCalculation.calculated,
                defaultValue: 'TabTin calculated {{count}} formula(s) locally for this preview. Results were not saved to the file.',
              })}
            </span>
          )}
          {formulaCalculation.unavailable > 0 && (
            <span className="text-warning/80">
              {t('folder.status.xlsxFormulasUnavailable', {
                count: formulaCalculation.unavailable,
                defaultValue: '{{count}} formula(s) have no saved result and cannot be calculated in preview. Open the file in a spreadsheet app.',
              })}
            </span>
          )}
        </div>
      )}

      <div className="grid shrink-0 grid-cols-[72px_1fr] items-center border-b border-border/30 bg-background">
        <div className="border-r border-border/30 px-3 py-2 text-body text-muted-foreground/75 tabular-nums">
          {activeCellLabel}
        </div>
        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
          <FunctionSquare className="h-4 w-4 shrink-0 text-muted-foreground/35" />
          <div className="min-w-0 flex-1 truncate text-body text-foreground/75">
            {activeCellValue || '\u00A0'}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0" scrollBar="both">
        {activeSheet.maxCols === 0 && activeSheet.cells.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32">
            <FileSpreadsheet className="h-6 w-6 text-muted-foreground/20 mb-2" strokeWidth={1} />
            <p className="text-caption text-muted-foreground/40">
              {t('folder.status.xlsxSheetEmpty')}
            </p>
          </div>
        ) : (
          <div className="min-w-full">
            <table className="border-separate border-spacing-0 text-body">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-floating h-8 w-12 border-b border-r border-border/40 bg-muted text-center font-medium text-muted-foreground/60">
                    {' '}
                  </th>
                  {Array.from({ length: activeSheet.maxCols }, (_, colIdx) => (
                    <th
                      key={colIdx}
                      className="sticky top-0 z-sticky h-8 min-w-[128px] border-b border-r border-border/35 bg-muted px-2 text-center font-medium text-muted-foreground/75"
                    >
                      {encodeCol(colIdx)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activeSheet.cells.map((row, rowIdx) => (
                  <tr key={rowIdx}>
                    <th className="sticky left-0 z-sticky h-8 w-12 border-b border-r border-border/35 bg-muted/30 text-center font-medium text-muted-foreground/65 tabular-nums">
                      {rowIdx + 1}
                    </th>
                    {Array.from({ length: activeSheet.maxCols }, (_, colIdx) => {
                      const cell = row[colIdx] ?? ''
                      const selected = activeCell.row === rowIdx && activeCell.col === colIdx
                      return (
                      <td
                        key={colIdx}
                        onClick={() => setActiveCell({ row: rowIdx, col: colIdx })}
                        className={cn(
                          'h-8 min-w-[128px] max-w-[280px] cursor-cell border-b border-r border-border/20 px-2 align-middle text-foreground/85',
                          'whitespace-pre-wrap break-words hover:bg-muted/20',
                          // eslint-disable-next-line tabtin/no-design-system-violations -- z-[1] 为选中单元格相对其余单元格的行内局部堆叠（抬起 outline），非跨组件层级，语义 z scale 不适用
                          selected && 'relative z-[1] bg-accent/10 outline outline-2 outline-accent/80 outline-offset-[-2px]',
                        )}
                      >
                        {cell || ''}
                      </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            {isTruncated && (
              <div className="sticky bottom-0 bg-gradient-to-t from-background to-transparent p-3 text-center">
                <span className="text-caption text-muted-foreground/60 bg-muted/40 px-2 py-0.5 rounded-full">
                  {t('folder.status.xlsxTruncated', {
                    shown: XLSX_PREVIEW_MAX_RENDER_ROWS,
                    total: activeSheet.totalRows,
                  })}
                </span>
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

XlsxViewer.displayName = 'XlsxViewer'
