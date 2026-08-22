import React, { useState, useEffect } from 'react'
import { Button } from './button'
import { Input } from './input'
import { Label } from './label'
import { Separator } from './separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { LoadingSpinner } from './loading-spinner'
import { ScrollArea } from './scroll-area'
import { OVERLAY_SURFACE_CLASS } from './overlay-surface'
import { t } from "../i18n"

export interface WorkingImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImport: (filePath: string, options: ImportOptions) => Promise<boolean>
  onPreview?: (filePath: string, options: ImportOptions) => Promise<any>
  getSupportedFormats?: () => Promise<{ import: string[], export: string[] }>
  getExcelSheetNames?: (filePath: string) => Promise<string[]>
  showOpenDialog?: (options: any) => Promise<string[] | undefined>
}

export interface ImportOptions {
  format: 'csv' | 'xlsx'
  encoding?: string
  delimiter?: string
  hasHeaders?: boolean
  sheetName?: string
  maxRows?: number
}

export const WorkingImportDialog: React.FC<WorkingImportDialogProps> = ({
  open,
  onOpenChange,
  onImport,
  onPreview,
  getSupportedFormats,
  getExcelSheetNames,
  showOpenDialog
}) => {
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [format, setFormat] = useState<'csv' | 'xlsx'>('csv')
  const [encoding, setEncoding] = useState<string>('utf8')
  const [delimiter, setDelimiter] = useState<string>(',')
  const [hasHeaders, setHasHeaders] = useState<boolean>(true)
  const [sheetName, setSheetName] = useState<string>('')
  const [maxRows, setMaxRows] = useState<number>(1000)
  const [supportedFormats, setSupportedFormats] = useState<string[]>([])
  const [excelSheets, setExcelSheets] = useState<string[]>([])
  const [previewData, setPreviewData] = useState<any>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string>('')

  useEffect(() => {
    if (open && getSupportedFormats) {
      getSupportedFormats().then(formats => {
        setSupportedFormats(formats.import.filter(fmt => fmt !== 'json'))
      }).catch(() => {
        setSupportedFormats(['csv', 'xlsx'])
      })
    }
  }, [open, getSupportedFormats])

  useEffect(() => {
    if (selectedFile && format === 'xlsx' && getExcelSheetNames) {
      getExcelSheetNames(selectedFile).then(sheets => {
        setExcelSheets(sheets)
        if (sheets.length > 0) {
          setSheetName(sheets[0])
        }
      }).catch(() => {
        setExcelSheets([])
      })
    }
  }, [selectedFile, format, getExcelSheetNames])

  const handleSelectFile = async () => {
    if (!showOpenDialog) return

    const filters = []
    if (format === 'csv') {
      filters.push({ name: 'CSV Files', extensions: ['csv'] })
    } else if (format === 'xlsx') {
      filters.push({ name: 'Excel Files', extensions: ['xlsx', 'xls'] })
    }

    try {
      const result = await showOpenDialog({
        filters,
        properties: ['openFile']
      })

      if (result && result.length > 0) {
        setSelectedFile(result[0])
        setError('')
      }
    } catch (err) {
      setError(t('importExportDialog.import.errors.selectFailed'))
    }
  }

  const handlePreview = async () => {
    if (!selectedFile || !onPreview) return

    setIsLoading(true)
    setError('')

    try {
      const options: ImportOptions = {
        format,
        encoding,
        delimiter: format === 'csv' ? delimiter : undefined,
        hasHeaders,
        sheetName: format === 'xlsx' ? sheetName : undefined,
        maxRows: 10 // 预览只显示前10行
      }

      const data = await onPreview(selectedFile, options)
      setPreviewData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('importExportDialog.import.errors.previewFailed'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleImport = async () => {
    if (!selectedFile) {
      setError(t('importExportDialog.import.errors.noFile'))
      return
    }

    setIsLoading(true)
    setError('')

    try {
      const options: ImportOptions = {
        format,
        encoding,
        delimiter: format === 'csv' ? delimiter : undefined,
        hasHeaders,
        sheetName: format === 'xlsx' ? sheetName : undefined,
        maxRows
      }

      const success = await onImport(selectedFile, options)
      if (success) {
        onOpenChange(false)
        // 重置状态
        setSelectedFile('')
        setPreviewData(null)
        setError('')
      } else {
        setError(t('importExportDialog.import.errors.failed'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('importExportDialog.import.errors.failed'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    onOpenChange(false)
    setSelectedFile('')
    setPreviewData(null)
    setError('')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-modal overlay-backdrop-blur flex items-center justify-center p-4">
      <div className={`${OVERLAY_SURFACE_CLASS} rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col`}>
        {/* 头部 */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div>
            <h2 className="text-title font-semibold text-foreground">{t('importExportDialog.import.title')}</h2>
            <p className="text-body text-muted-foreground mt-1">{t('importExportDialog.import.description')}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClose}
            className="h-8 w-8 p-0"
          >
            <span className="sr-only">{t('common.close')}</span>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Button>
        </div>

        {/* 内容 */}
        <ScrollArea className="flex-1"><div className="p-6 space-y-6">
          {/* 文件格式选择 */}
          <div className="space-y-2">
            <Label>{t('importExportDialog.import.fileFormat')}</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full justify-between">
                  {format.toUpperCase()}
                  <svg className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-full">
                {supportedFormats.map(fmt => (
                  <DropdownMenuItem
                    key={fmt}
                    onClick={() => setFormat(fmt as 'csv' | 'xlsx')}
                  >
                    {fmt.toUpperCase()}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 文件选择 */}
          <div className="space-y-2">
            <Label>{t('importExportDialog.import.fileLabel')}</Label>
            <div className="flex gap-2">
              <Input
                value={selectedFile}
                placeholder={t('importExportDialog.import.filePlaceholder')}
                readOnly
                className="flex-1"
              />
              <Button onClick={handleSelectFile}>
                {t('importExportDialog.common.browse')}
              </Button>
            </div>
          </div>

          {/* 导入选项 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('importExportDialog.import.encoding')}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-between">
                    {encoding === 'utf8' ? 'UTF-8' : encoding === 'utf16le' ? 'UTF-16LE' : 'Latin1'}
                    <svg className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => setEncoding('utf8')}>
                    UTF-8
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEncoding('utf16le')}>
                    UTF-16LE
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEncoding('latin1')}>
                    Latin1
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {format === 'csv' && (
              <div className="space-y-2">
                <Label>{t('importExportDialog.common.delimiter')}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between">
                      {delimiter === ',' ? t('importExportDialog.delimiter.comma') :
                       delimiter === ';' ? t('importExportDialog.delimiter.semicolon') :
                       delimiter === '\t' ? t('importExportDialog.delimiter.tab') : delimiter}
                      <svg className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => setDelimiter(',')}>
                      {t('importExportDialog.delimiter.comma')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDelimiter(';')}>
                      {t('importExportDialog.delimiter.semicolon')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDelimiter('\t')}>
                      {t('importExportDialog.delimiter.tab')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {format === 'xlsx' && excelSheets.length > 0 && (
              <div className="space-y-2">
                <Label>{t('importExportDialog.import.sheet')}</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" className="w-full justify-between">
                      {sheetName}
                      <svg className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {excelSheets.map(sheet => (
                      <DropdownMenuItem
                        key={sheet}
                        onClick={() => setSheetName(sheet)}
                      >
                        {sheet}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t('importExportDialog.import.maxRows')}</Label>
              <Input
                type="number"
                value={maxRows}
                onChange={(e) => setMaxRows(Number(e.target.value))}
                min={1}
                max={100000}
              />
            </div>

            <div className="flex items-center space-x-2 pt-6">
              <input
                type="checkbox"
                id="hasHeaders"
                checked={hasHeaders}
                onChange={(e) => setHasHeaders(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary focus:ring-2 focus:ring-offset-2"
              />
              <Label htmlFor="hasHeaders" className="text-body font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                {t('importExportDialog.common.includeHeaders')}
              </Label>
            </div>
          </div>

          {/* 预览按钮 */}
          {selectedFile && onPreview && (
            <>
              <Separator />
              <div>
                <Button
                  onClick={handlePreview}
                  disabled={isLoading}
                  variant="outline"
                  className="w-full"
                >
                  {isLoading ? (
                    <>
                      <LoadingSpinner size="sm" className="mr-2" />
                      {t('workingImportDialog.previewing')}
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      {t('importExportDialog.import.previewButton')}
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          {/* 预览数据 */}
          {previewData && (
            <>
              <Separator />
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-body font-medium">{t('importExportDialog.import.previewTitle')}</Label>
                  <div className="text-body text-muted-foreground">
                    {t('importExportDialog.import.previewSummary', {
                      rows: previewData.totalRows || previewData.rows?.length || 0,
                      columns: previewData.columns?.length || 0,
                    })}
                  </div>
                </div>
                <ScrollArea className="border border-border rounded-md max-h-60 bg-muted/50">
                  {previewData.columns && previewData.rows && (
                    <table className="w-full text-body">
                      <thead className="bg-muted">
                        <tr className="border-b border-border">
                          {previewData.columns.map((col: any, index: number) => (
                            <th key={index} className="text-left p-3 font-medium text-foreground">
                              {col.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.rows.slice(0, 5).map((row: any, index: number) => (
                          <tr key={index} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                            {previewData.columns.map((col: any, colIndex: number) => (
                              <td key={colIndex} className="p-3 text-foreground">
                                <div className="max-w-[200px] truncate">
                                  {String(row.data[col.id] || '')}
                                </div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </ScrollArea>
              </div>
            </>
          )}

          {/* 错误信息 */}
          {error && (
            <div className="flex items-start gap-3 p-4 text-body text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              <svg className="h-5 w-5 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>{error}</div>
            </div>
          )}
        </div></ScrollArea>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 p-6 border-t border-border bg-muted/30">
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleImport}
            disabled={!selectedFile || isLoading}
          >
            {isLoading ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                {t('workingImportDialog.importing')}
              </>
            ) : (
              <>
                <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                </svg>
                {t('importExportDialog.import.importButton')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
