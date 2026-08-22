/**
 * ExportDialog — Web 端导出对话框
 *
 * 支持导出格式：CSV、Excel
 * 支持可选的字段选择（field_ids）
 * 通过 ImportExportApiService.export 下载
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  Label,
  ScrollArea,
  toast,
} from '@tabtin/smartsheet-ui'
import { ImportExportApiService, type ExportFormat, type Field } from '@tabtin/table-core'

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'excel', label: 'Excel' },
]

export interface ExportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableId: string
  tableName: string
  viewId?: string
  fields?: Field[]
}

export const ExportDialog: React.FC<ExportDialogProps> = ({
  open,
  onOpenChange,
  tableId,
  tableName,
  viewId,
  fields,
}) => {
  const { t } = useTranslation('table')
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [exporting, setExporting] = useState(false)
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(new Set())
  const [showFieldSelector, setShowFieldSelector] = useState(false)

  const exportableFields = useMemo(
    () => (fields ?? []).filter(f => !f.is_hidden),
    [fields],
  )

  useEffect(() => {
    if (open) {
      setSelectedFieldIds(new Set(exportableFields.map(f => f.id)))
      setShowFieldSelector(false)
    }
  }, [open, exportableFields])

  const selectedFieldIdsRef = useRef(selectedFieldIds)
  selectedFieldIdsRef.current = selectedFieldIds

  const allSelected = selectedFieldIds.size === exportableFields.length
  const noneSelected = selectedFieldIds.size === 0

  const toggleField = useCallback((fieldId: string) => {
    setSelectedFieldIds(prev => {
      const next = new Set(prev)
      if (next.has(fieldId)) {
        next.delete(fieldId)
      } else {
        next.add(fieldId)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedFieldIds(new Set())
    } else {
      setSelectedFieldIds(new Set(exportableFields.map(f => f.id)))
    }
  }, [allSelected, exportableFields])

  const handleExport = useCallback(async () => {
    setExporting(true)
    try {
      const ids = selectedFieldIdsRef.current
      const isAllSelected = ids.size === exportableFields.length
      const fieldIds = showFieldSelector && !isAllSelected && ids.size > 0
        ? Array.from(ids)
        : undefined

      const blob = await ImportExportApiService.export(format, {
        table_id: tableId,
        view_id: viewId,
        include_headers: true,
        field_ids: fieldIds,
      })
      const filename = ImportExportApiService.generateFilename(tableName, format)
      ImportExportApiService.downloadFile(blob, filename)
      toast({ title: t('export.success', { defaultValue: 'Export successful' }) })
      onOpenChange(false)
    } catch (e) {
      console.error('[ExportDialog] export failed', e)
      toast({
        title: t('export.failed', { defaultValue: 'Export failed' }),
        description: e instanceof Error ? e.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setExporting(false)
    }
  }, [format, tableId, viewId, tableName, onOpenChange, t, showFieldSelector, exportableFields.length])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('export.title', { defaultValue: 'Export data' })}</DialogTitle>
          <DialogDescription>
            {t('export.desc', { defaultValue: 'Select a format to export current view data.' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('export.format', { defaultValue: 'Format' })}</Label>
            <div className="flex gap-2">
              {EXPORT_FORMATS.map(f => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  className={`flex-1 rounded-md border px-3 py-2 text-body font-medium transition-colors ${
                    format === f.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-foreground hover:bg-accent'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {exportableFields.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  {t('export.fields', { defaultValue: 'Export fields' })}
                  {showFieldSelector && !allSelected && (
                    <span className="ml-1.5 text-body font-normal text-muted-foreground">
                      ({selectedFieldIds.size}/{exportableFields.length})
                    </span>
                  )}
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-body"
                  onClick={() => setShowFieldSelector(prev => !prev)}
                >
                  {showFieldSelector
                    ? t('export.collapseFieldSelector', { defaultValue: 'Collapse' })
                    : t('export.selectFields', { defaultValue: 'Select fields' })}
                </Button>
              </div>

              {showFieldSelector && (
                <div className="rounded-md border border-border">
                  <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                    />
                    <span className="text-body text-muted-foreground">
                      {t('export.selectAllFields', {
                        defaultValue: 'Select all ({{count}}/{{total}})',
                        count: selectedFieldIds.size,
                        total: exportableFields.length,
                      })}
                    </span>
                  </div>
                  <ScrollArea className="max-h-[200px]">
                    <div className="space-y-0.5 p-2">
                      {exportableFields.map(f => (
                        <label
                          key={f.id}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-accent/50 cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedFieldIds.has(f.id)}
                            onCheckedChange={() => toggleField(f.id)}
                          />
                          <span className="truncate">{f.name}</span>
                          <span className="ml-auto shrink-0 text-caption text-muted-foreground">
                            {f.field_type}
                          </span>
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            onClick={() => void handleExport()}
            disabled={exporting || (showFieldSelector && noneSelected)}
          >
            {exporting
              ? t('export.exporting', { defaultValue: 'Exporting...' })
              : t('export.download', { defaultValue: 'Download' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
