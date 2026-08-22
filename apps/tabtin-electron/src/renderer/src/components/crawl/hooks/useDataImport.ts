/**
 * 数据导入 Hook
 *
 * 职责：
 * - 创建表格
 * - 批量导入数据
 * - 管理导入状态
 */

import { useState, useCallback } from 'react'
import type { ResourceRecord } from '@tabtin/action-tools/types'
import { TableApiService, FieldApiService, ImportExportApiService } from '@tabtin/table-core'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import type { TaskState, FieldConfig, NetworkResponse } from '../types'
import type { FieldType } from '@tabtin/table-core'
import { ResourceDownloader } from '@/services/resources/downloader'
import type { DownloadTask } from '@/services/resources/downloader'
import { directUploadBatch } from '@/services/oss-direct-uploader'
import type { UploadFileItem } from '@/services/oss-direct-uploader'
import { resourceCache } from '@/services/resources/resource-cache'
import i18n from '@/i18n'

import {
  MAX_FIELDS_PER_BULK_REQUEST,
  MAX_RECORDS_PER_IMPORT_REQUEST,
  MAX_REQUEST_RETRIES,
  splitIntoChunks,
  getErrorMessage,
  isRetryableRequestError,
  withRetry,
} from './data-import/import-utils'
import type { ImportProgress, ImportStageError } from './data-import/import-types'
import { toImportStageError } from './data-import/import-types'
import {
  buildFieldDisplayNames,
  generateTableName,
  getRandomTableIcon,
  inferFieldTypes,
} from './data-import/schema-utils'

export type { ImportProgress } from './data-import/import-types'
export { withRetry } from './data-import/import-utils'

export function useDataImport() {
  const [importProgress, setImportProgress] = useState<ImportProgress>({
    phase: 'idle',
    message: '',
    progress: 0,
  })

  const resolvedOrganizationId = useResolvedOrganizationId()

  const createTable = useCallback(async (
    taskState: TaskState,
    spaceId: string,
    spaceName: string,
    pageTitle?: string,
    instruction?: string,
    schemaHistoryId?: string,
    fieldConfigs?: FieldConfig[]
  ): Promise<{
    success: boolean
    tableId?: string
    tableName?: string
    error?: string
    fieldMappings?: Map<string, { originalUrlField: string; attachmentField: string }>
    fieldDisplayNames?: Record<string, string>
  }> => {
    if (!resolvedOrganizationId) {
      return { success: false, error: i18n.t('crawl:dataImport.errors.organizationRequired') }
    }

    let currentPhase: ImportProgress['phase'] = 'creating_table'

    try {
      setImportProgress({
        phase: 'creating_table',
        message: i18n.t('crawl:dataImport.progress.creatingTable'),
        progress: 10,
      })

      const tableName = generateTableName(taskState, pageTitle, instruction)
      const tableIcon = getRandomTableIcon()

      // ：建表只挂 Organization
      const table = await TableApiService.createTable({
        organization_id: resolvedOrganizationId,
        name: tableName,
        description: i18n.t('crawl:dataImport.tableDescription', { taskId: taskState.taskId || '' }),
        icon: tableIcon,
        use_default_fields: false,
        schema_history_id: schemaHistoryId,
        default_source_url: taskState.url,
      })

      setImportProgress({
        phase: 'creating_fields',
        message: i18n.t('crawl:dataImport.progress.creatingFields'),
        progress: 20,
        tableId: table.id,
        tableName: table.name,
      })
      currentPhase = 'creating_fields'

      const { extractedData, schema } = taskState

      let fieldNames: string[] = []
      let fieldDisplayNames: Record<string, string> = {}
      let fieldTypes: Record<string, FieldType> = {}

      if (fieldConfigs && fieldConfigs.length > 0) {
        const enabledConfigs = fieldConfigs.filter(f => f.enabled)
        fieldNames = enabledConfigs.map(f => f.sourceField)

        for (const config of enabledConfigs) {
          fieldDisplayNames[config.sourceField] = config.displayName
          const schemaField = schema?.fields?.find((f: any) => f.name === config.sourceField)
          fieldTypes[config.sourceField] =
            (schemaField?.tabdata_type as FieldType) || (schemaField?.aitable_type as FieldType) ||
            (config.fieldType as FieldType) ||
            'text'
        }
      } else if (extractedData && extractedData.length > 0) {
        const firstRecord = extractedData[0]
        fieldNames = Object.keys(firstRecord)
        fieldDisplayNames = buildFieldDisplayNames(schema, fieldNames)
        fieldTypes = inferFieldTypes(extractedData, fieldNames)
      }

      let mediaFieldMappings: Map<string, { originalUrlField: string; attachmentField: string }> = new Map()
      const allFieldsToCreate: any[] = []

      if (fieldNames.length > 0) {
        const mediaFieldsConfig = fieldConfigs
          ? fieldConfigs.filter(f => f.enabled && f.isMediaField && f.saveToServer)
          : []

        for (const fieldName of fieldNames) {
          const fieldType = fieldTypes[fieldName] || 'text'
          const displayName = fieldDisplayNames[fieldName] || fieldName
          const mediaConfig = mediaFieldsConfig.find(mf => mf.sourceField === fieldName)

          if (mediaConfig) {
            const originalUrlFieldName =
              mediaConfig.originalUrlFieldName ||
              i18n.t('crawl:dataImport.fieldName.originalUrl', { name: mediaConfig.displayName })
            const attachmentFieldName = mediaConfig.attachmentFieldName || mediaConfig.displayName

            allFieldsToCreate.push({
              name: originalUrlFieldName,
              field_type: 'url' as FieldType,
              description: i18n.t('crawl:dataImport.fieldDescription.originalUrl', { name: mediaConfig.displayName }),
              options: {},
            })
            allFieldsToCreate.push({
              name: attachmentFieldName,
              field_type: 'attachment' as FieldType,
              description: i18n.t('crawl:dataImport.fieldDescription.attachment', { name: mediaConfig.displayName }),
              options: {},
            })
            mediaFieldMappings.set(fieldName, { originalUrlField: originalUrlFieldName, attachmentField: attachmentFieldName })
          } else {
            allFieldsToCreate.push({
              name: displayName,
              field_type: fieldType,
              description: i18n.t('crawl:dataImport.fieldDescription.sourceField', { field: fieldName }),
              options: {},
            })
          }
        }

        if (allFieldsToCreate.length > 0) {
          const fieldChunks = splitIntoChunks(allFieldsToCreate, MAX_FIELDS_PER_BULK_REQUEST)
          const chunkErrorMessages: string[] = []

          for (let chunkIndex = 0; chunkIndex < fieldChunks.length; chunkIndex += 1) {
            const chunk = fieldChunks[chunkIndex]
            let result
            try {
              result = await withRetry(
                () => FieldApiService.bulkCreateFields(table.id, { fields: chunk }),
                {
                  maxRetries: MAX_REQUEST_RETRIES,
                  onRetry: ({ retryCount, maxRetries }) => {
                    setImportProgress(prev => ({
                      ...prev,
                      phase: 'creating_fields',
                      message: `字段创建失败，正在重试（${retryCount}/${maxRetries}）...`,
                      progress: 20,
                      tableId: table.id,
                      tableName: table.name,
                    }))
                  },
                }
              )
            } catch (error) {
              throw toImportStageError(
                'creating_fields',
                `字段创建失败（第 ${chunkIndex + 1}/${fieldChunks.length} 批）：${getErrorMessage(error)}`,
                { batch: chunkIndex + 1, totalBatches: fieldChunks.length, batchSize: chunk.length },
                { canRetry: isRetryableRequestError(error), canSkip: false }
              )
            }

            if (result.errors.length > 0) {
              const prefixedErrors = result.errors.map((error: string) => `[批次 ${chunkIndex + 1}] ${error}`)
              chunkErrorMessages.push(...prefixedErrors)
            }
          }

          if (chunkErrorMessages.length > 0) {
            throw new Error(i18n.t('crawl:dataImport.errors.createFieldFailed', {
              details: chunkErrorMessages.join('; ')
            }))
          }
        }
      }

      setImportProgress({
        phase: 'idle',
        message: i18n.t('crawl:dataImport.progress.tableReady'),
        progress: 0,
        tableId: table.id,
        tableName: table.name
      })

      return { success: true, tableId: table.id, tableName: table.name, fieldMappings: mediaFieldMappings, fieldDisplayNames }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : i18n.t('crawl:dataImport.errors.createTableFailed')
      const stageError = error as ImportStageError
      setImportProgress({
        phase: 'error',
        message: errorMessage,
        progress: 0,
        errorDetails: {
          phase: stageError.phase ?? currentPhase,
          message: errorMessage,
          canRetry: stageError.canRetry ?? true,
          canSkip: stageError.canSkip ?? false,
          details: stageError.details ?? undefined,
        },
      })
      return { success: false, error: errorMessage }
    }
  }, [resolvedOrganizationId])

  const processAndImportData = useCallback(async (
    tableId: string,
    tableName: string,
    extractedData: any[],
    fieldConfigs?: FieldConfig[],
    mediaFieldMappings?: Map<string, { originalUrlField: string; attachmentField: string }>,
    fieldDisplayNames?: Record<string, string>,
    networkResponses?: NetworkResponse[],
    resourceRecords?: ResourceRecord[]
  ): Promise<{ success: boolean; successCount?: number; totalRecords?: number; error?: string }> => {
    if (!resolvedOrganizationId) return { success: false, error: i18n.t('crawl:dataImport.errors.organizationRequired') }
    if (!extractedData || extractedData.length === 0) return { success: false, error: i18n.t('crawl:dataImport.errors.noData') }

    let currentPhase: ImportProgress['phase'] = 'loading_cache'

    try {
      if (networkResponses && networkResponses.length > 0) {
        currentPhase = 'loading_cache'
        setImportProgress({ phase: 'loading_cache', message: i18n.t('crawl:dataImport.progress.loadingCache'), progress: 30, tableId, tableName })
        await resourceCache.loadFromNetworkResponses(networkResponses)
      }

      const responseByUrl = new Map<string, NetworkResponse>()
      for (const response of networkResponses || []) {
        if (response.url) {
          responseByUrl.set(response.url, response)
        }
      }
      const resourceByUrl = new Map<string, ResourceRecord>()
      const resourceById = new Map<string, ResourceRecord>()
      for (const resource of resourceRecords || []) {
        resourceById.set(resource.resourceId, resource)
        if (resource.url) {
          resourceByUrl.set(resource.url, resource)
        }
        if (resource.resolvedUrl) {
          resourceByUrl.set(resource.resolvedUrl, resource)
        }
      }

      let uploadedFilesMap: Map<number, any[]> = new Map()

      if (fieldConfigs && mediaFieldMappings && mediaFieldMappings.size > 0) {
        const mediaFields = fieldConfigs.filter(f => f.enabled && f.isMediaField && f.saveToServer)

        if (mediaFields.length > 0) {
          currentPhase = 'downloading_resources'
          setImportProgress({
            phase: 'downloading_resources',
            message: i18n.t('crawl:dataImport.progress.downloadingResources'),
            progress: 40, tableId, tableName,
            downloadStats: { total: 0, completed: 0, failed: 0 }
          })

          const downloadTasks: DownloadTask[] = []
          for (const mediaField of mediaFields) {
            extractedData.forEach((record, index) => {
              const url = record[mediaField.sourceField]
              if (url && typeof url === 'string') {
                const response = responseByUrl.get(url)
                const resource = response?.resourceId
                  ? resourceById.get(response.resourceId)
                  : resourceByUrl.get(url)
                const canUseCache =
                  resourceCache.has(url)
                  || Boolean(response?.body)
                  || Boolean(resource?.contentRef?.data)
                const isRemoteUrl = /^https?:/i.test(url)
                const canCaptureInPage = Boolean(
                  resource?.resourceId
                  && resource.viewId
                  && (
                    url.startsWith('blob:')
                    || resource.captureStatus === 'page_bound_blob'
                    || Boolean(resource.contentRef?.data)
                  )
                )

                if (canUseCache || isRemoteUrl || canCaptureInPage) {
                  downloadTasks.push({
                    url,
                    fieldName: mediaField.sourceField,
                    recordIndex: index,
                    resourceId: resource?.resourceId || response?.resourceId,
                    viewId: resource?.viewId || response?.viewId,
                    category: resource?.category || response?.category,
                    captureStatus: resource?.captureStatus || response?.captureStatus
                  })
                }
              }
            })
          }

          if (downloadTasks.length > 0) {
            const downloader = new ResourceDownloader({
              concurrency: 3, maxRetries: 3, timeout: 30000,
              onProgress: (progress) => {
                setImportProgress(prev => ({
                  ...prev,
                  progress: 40 + (progress.percentage * 0.2),
                  downloadStats: { total: progress.total, completed: progress.completed, failed: progress.failed, current: progress.current }
                }))
              }
            })

            const downloadResults = await downloader.downloadBatch(downloadTasks)
            const successfulDownloads = downloadResults.filter(r => {
              if (!r.success || !r.blob) return false
              const mime = (r.mimeType || '').toLowerCase()
              const isStreamResource =
                r.category === 'hls'
                || r.category === 'dash'
                || mime.includes('mpegurl')
                || mime.includes('dash+xml')
                || /\.m3u8(\?|#|$)/i.test(r.url)
                || /\.mpd(\?|#|$)/i.test(r.url)
              return !isStreamResource
            })

            if (successfulDownloads.length > 0) {
              currentPhase = 'uploading_resources'
              setImportProgress({
                phase: 'uploading_resources',
                message: i18n.t('crawl:dataImport.progress.uploadingResources'),
                progress: 60, tableId, tableName,
                uploadStats: { total: successfulDownloads.length, completed: 0, failed: 0 }
              })

              const filesToUpload: UploadFileItem[] = successfulDownloads.map(r => ({
                blob: r.blob!, fileName: r.fileName || 'file', originalUrl: r.url
              }))

              let completedSoFar = 0
              // 系统从网页爬取下载的资源文件，类型由下载管道校验，跳过 validateUploadFile
              const uploadResult = await directUploadBatch(
                filesToUpload.map(f => ({ file: f.blob as File, fileName: f.fileName })),
                {
                  folder: 'tabdata/attachments', module: 'tabdata', contextType: 'table_import', contextId: tableId, concurrency: 3,
                  onFileComplete: () => {
                    completedSoFar++
                    setImportProgress(prev => ({
                      ...prev,
                      progress: 60 + ((completedSoFar / filesToUpload.length) * 0.2),
                      uploadStats: { total: filesToUpload.length, completed: completedSoFar, failed: 0 },
                    }))
                  },
                },
              )

              const urlToFileMap = new Map<string, any>()
              uploadResult.results.forEach((r, idx) => {
                if (r.success && r.fileId) {
                  const originalUrl = filesToUpload[idx]?.originalUrl || ''
                  urlToFileMap.set(originalUrl, { file_id: r.fileId, url: r.accessUrl, name: r.fileName, size: r.fileSize })
                }
              })

              for (const dr of successfulDownloads) {
                const fileInfo = urlToFileMap.get(dr.url)
                if (fileInfo) {
                  if (!uploadedFilesMap.has(dr.recordIndex)) uploadedFilesMap.set(dr.recordIndex, [])
                  uploadedFilesMap.get(dr.recordIndex)!.push({ fieldName: dr.fieldName, originalUrl: dr.url, fileInfo })
                }
              }
            }

            downloader.clearCache()
            const uploadedUrls = downloadTasks.map(t => t.url)
            resourceCache.removeBatch(uploadedUrls)
          }
        }
      }

      currentPhase = 'importing_data'
      setImportProgress({ phase: 'importing_data', message: i18n.t('crawl:dataImport.progress.importingData'), progress: 80, tableId, tableName })

      const skipFields = new Set<string>()
      if (mediaFieldMappings) {
        for (const [sourceField] of mediaFieldMappings) skipFields.add(sourceField)
      }

      let recordsWithoutAttachment = 0
      const transformedData = extractedData.map((record, index) => {
        const transformed: Record<string, any> = {}
        for (const [key, value] of Object.entries(record)) {
          if (skipFields.has(key)) continue
          const displayName = fieldDisplayNames?.[key] || key
          transformed[displayName] = value
        }
        const uploadedFiles = uploadedFilesMap.get(index)
        if (uploadedFiles && uploadedFiles.length > 0) {
          for (const file of uploadedFiles) {
            const mapping = mediaFieldMappings?.get(file.fieldName)
            if (mapping) {
              transformed[mapping.originalUrlField] = file.originalUrl
              transformed[mapping.attachmentField] = [file.fileInfo]
            }
          }
        } else if (skipFields.size > 0) {
          recordsWithoutAttachment++
          for (const sourceField of skipFields) {
            const mapping = mediaFieldMappings?.get(sourceField)
            if (mapping) {
              transformed[mapping.originalUrlField] = record[sourceField] || ''
              transformed[mapping.attachmentField] = []
            }
          }
        }
        return transformed
      })

      const recordChunks = splitIntoChunks(transformedData, MAX_RECORDS_PER_IMPORT_REQUEST)
      let totalCreatedCount = 0
      let totalUpdatedCount = 0
      const importErrors: string[] = []

      for (let chunkIndex = 0; chunkIndex < recordChunks.length; chunkIndex += 1) {
        const chunk = recordChunks[chunkIndex]
        const batchNumber = chunkIndex + 1
        const totalBatches = recordChunks.length
        const baseProgress = 80 + Math.round((chunkIndex / totalBatches) * 18)

        setImportProgress(prev => ({
          ...prev, phase: 'importing_data',
          message: `正在导入数据（第 ${batchNumber}/${totalBatches} 批，${chunk.length} 条）`,
          progress: Math.min(98, baseProgress), tableId, tableName,
          totalRecords: extractedData.length,
          successCount: totalCreatedCount + totalUpdatedCount,
          failedCount: importErrors.length,
        }))

        let chunkResult
        try {
          chunkResult = await withRetry(
            () => ImportExportApiService.importJSON(tableId, JSON.stringify(chunk), { skipErrors: true, updateExisting: false }),
            {
              maxRetries: MAX_REQUEST_RETRIES,
              onRetry: ({ retryCount, maxRetries }) => {
                setImportProgress(prev => ({
                  ...prev, phase: 'importing_data',
                  message: `第 ${batchNumber}/${totalBatches} 批失败，正在重试（${retryCount}/${maxRetries}）...`,
                  progress: Math.min(98, baseProgress), tableId, tableName,
                }))
              },
            }
          )
        } catch (error) {
          throw toImportStageError(
            'importing_data',
            `数据导入失败（第 ${batchNumber}/${totalBatches} 批）：${getErrorMessage(error)}`,
            { batch: batchNumber, totalBatches, batchSize: chunk.length, importedSuccess: totalCreatedCount + totalUpdatedCount, importedFailed: importErrors.length },
            { canRetry: isRetryableRequestError(error), canSkip: false }
          )
        }

        totalCreatedCount += chunkResult.created_count
        totalUpdatedCount += chunkResult.updated_count
        if (chunkResult.errors.length > 0) {
          importErrors.push(...chunkResult.errors.map((error: any) => `[批次 ${batchNumber}] ${typeof error === 'string' ? error : error.message}`))
        }
      }

      const successCount = totalCreatedCount + totalUpdatedCount
      const failedCount = importErrors.length

      let completionMessage = i18n.t('crawl:dataImport.completion.base')
      if (failedCount > 0 && recordsWithoutAttachment > 0) {
        completionMessage = i18n.t('crawl:dataImport.completion.withFailedAndMissing', { success: successCount, failed: failedCount, missing: recordsWithoutAttachment })
      } else if (failedCount > 0) {
        completionMessage = i18n.t('crawl:dataImport.completion.withFailed', { success: successCount, failed: failedCount })
      } else if (recordsWithoutAttachment > 0) {
        completionMessage = i18n.t('crawl:dataImport.completion.withMissing', { success: successCount, missing: recordsWithoutAttachment })
      }

      setImportProgress({ phase: 'completed', message: completionMessage, progress: 100, tableId, tableName, totalRecords: extractedData.length, successCount, failedCount })
      return { success: true, successCount, totalRecords: extractedData.length }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : i18n.t('crawl:dataImport.errors.importFailed')
      const stageError = error as ImportStageError
      setImportProgress({
        phase: 'error', message: errorMessage, progress: 0, tableId, tableName,
        errorDetails: {
          phase: stageError.phase ?? currentPhase, message: errorMessage,
          canRetry: stageError.canRetry ?? true, canSkip: stageError.canSkip ?? false,
          details: stageError.details ?? undefined,
        },
      })
      return { success: false, error: errorMessage }
    }
  }, [resolvedOrganizationId])

  const importToNewTable = useCallback(async (
    taskState: TaskState,
    spaceId: string,
    spaceName: string,
    pageTitle?: string,
    instruction?: string,
    schemaHistoryId?: string,
    fieldConfigs?: FieldConfig[]
  ) => {
    const createResult = await createTable(taskState, spaceId, spaceName, pageTitle, instruction, schemaHistoryId, fieldConfigs)
    if (!createResult.success || !createResult.tableId) return { success: false, error: createResult.error }
    const importResult = await processAndImportData(
      createResult.tableId, createResult.tableName || i18n.t('crawl:dataImport.tableName.default'),
      taskState.extractedData,
      fieldConfigs,
      createResult.fieldMappings,
      createResult.fieldDisplayNames,
      taskState.networkResponses,
      taskState.resourceRecords
    )
    return { ...importResult, tableId: createResult.tableId, tableName: createResult.tableName }
  }, [createTable, processAndImportData])

  const resetImport = useCallback(() => {
    setImportProgress({ phase: 'idle', message: '', progress: 0 })
  }, [])

  return {
    importProgress,
    importToNewTable,
    createTable,
    processAndImportData,
    resetImport,
    isImporting: importProgress.phase !== 'idle' && importProgress.phase !== 'completed' && importProgress.phase !== 'error',
  }
}
