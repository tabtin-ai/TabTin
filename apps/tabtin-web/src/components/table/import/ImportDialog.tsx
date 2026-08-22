/**
 * ImportDialog — Web 端数据导入对话框
 *
 * 对齐 Electron 的 ImportContainer：
 * - 使用 @tabtin/smartsheet-ui 的 DataImportDialog UI 组件
 * - 通过 @tabtin/table-core 的 ImportExportApiService 调用 API
 * - 所有 store 操作通过 props 回调注入，保持组件可共享性
 */

import React, { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DataImportDialog,
  type DataImportPreviewResponse,
  type DataImportConfig,
  type DataImportResult,
  type DataImportField,
} from '@tabtin/smartsheet-ui'
import { ImportExportApiService, isImportResultError } from '@tabtin/table-core'
import type { Field } from '@tabtin/table-core'

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * table-core ImportPreviewResponse → smartsheet-ui DataImportPreviewResponse
 *
 * table-core 的 stats 多了 total_validation_issues 字段，
 * smartsheet-ui 不需要它。此函数做显式映射而非裸 as 断言，
 * 确保一端类型变更时在编译期暴露。
 */
function toDataImportPreviewResponse(
  raw: Awaited<ReturnType<typeof ImportExportApiService.previewImport>>,
): DataImportPreviewResponse {
  return {
    preview_data: raw.preview_data,
    field_mapping: raw.field_mapping,
    validation_issues: raw.validation_issues,
    stats: {
      total_rows: raw.stats.total_rows,
      preview_rows: raw.stats.preview_rows,
      field_count: raw.stats.field_count,
    },
  }
}

function toDataImportResult(
  raw: Awaited<ReturnType<typeof ImportExportApiService.import>>,
): DataImportResult {
  return {
    created_count: raw.created_count,
    updated_count: raw.updated_count,
    skipped_count: raw.skipped_count,
    error_summary: raw.error_summary,
    errors: raw.errors,
  }
}

export interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tableId: string
  tableName: string
  fields: Field[]
  onImportComplete?: () => void | Promise<void>
}

export const ImportDialog: React.FC<ImportDialogProps> = ({
  open,
  onOpenChange,
  tableId,
  tableName,
  fields,
  onImportComplete,
}) => {
  const { t } = useTranslation('table')

  const uiFields: DataImportField[] = useMemo(
    () =>
      fields.map((field) => ({
        id: field.id,
        name: field.name,
        field_type: field.field_type,
      })),
    [fields],
  )

  const handlePreview = useCallback(
    async (file: File): Promise<DataImportPreviewResponse> => {
      try {
        const response = await ImportExportApiService.previewImport(file, tableId)

        if (!response || typeof response !== 'object') {
          throw new Error(t('import.errors.responseInvalid', { defaultValue: 'Invalid response data' }))
        }
        if (!response.stats) {
          throw new Error(t('import.errors.missingStats', { defaultValue: 'Missing statistics' }))
        }
        if (!response.field_mapping) {
          throw new Error(t('import.errors.missingFieldMapping', { defaultValue: 'Missing field mapping' }))
        }

        return toDataImportPreviewResponse(response)
      } catch (error: unknown) {
        throw new Error(getErrorMessage(error) || t('import.errors.previewFailed', { defaultValue: 'Preview failed' }))
      }
    },
    [tableId, t],
  )

  const handleImport = useCallback(
    async (config: DataImportConfig): Promise<DataImportResult> => {
      try {
        const result = await ImportExportApiService.import(config.file, tableId, {
          skipErrors: config.skipErrors,
          updateExisting: config.updateExisting,
          primaryKeyField: config.primaryKeyField,
        })

        if (onImportComplete) {
          await onImportComplete()
        }

        return toDataImportResult(result)
      } catch (error: unknown) {
        // 保留结构化导入结果，供失败页展示明细
        if (isImportResultError(error)) {
          throw error
        }
        throw new Error(getErrorMessage(error) || t('import.errors.importFailed', { defaultValue: 'Import failed' }))
      }
    },
    [tableId, onImportComplete, t],
  )

  const handleDownloadTemplate = useCallback(async (format: 'xlsx' | 'csv' | 'json' = 'csv'): Promise<void> => {
    try {
      // 优先本地按字段生成，保证 JSON 为可导入对象数组（避免后端返回 CSV 却存成 .json）
      let blob: Blob
      try {
        blob = ImportExportApiService.buildTemplateFromFields(
          fields.map((field) => ({
            name: field.name,
            field_type: field.field_type,
            config: (field as { config?: Record<string, unknown> | null }).config ?? null,
          })),
          format,
        )
      } catch (localError) {
        if (format === 'xlsx') {
          throw localError
        }
        blob = await ImportExportApiService.downloadTemplate(tableId, format)
      }
      const filename =
        format === 'xlsx'
          ? `${tableName}_template.xlsx`
          : format === 'json'
            ? `${tableName}_template.json`
            : `${tableName}_template.csv`
      ImportExportApiService.downloadFile(blob, filename)
    } catch (error: unknown) {
      throw new Error(getErrorMessage(error) || t('import.errors.templateDownloadFailed', { defaultValue: 'Failed to download template' }))
    }
  }, [fields, tableId, tableName, t])

  return (
    <DataImportDialog
      open={open}
      onOpenChange={onOpenChange}
      tableId={tableId}
      fields={uiFields}
      onPreview={handlePreview}
      onImport={handleImport}
      onDownloadTemplate={handleDownloadTemplate}
    />
  )
}
