import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImportExportApiService } from '@tabtin/table-core'
import { createDocument, importDocumentFileDraft, importMarkdown } from '@tabtin/tabdoc-ui/api-client'

import { getSharedAppHostClient } from '@/adapters/sharedAppHostClient'
import { apiService } from '@/services/api'
import { SpaceApiService } from '@/services/spaceApi'
import { directUpload, directUploadBatch } from '@/services/oss-direct-uploader'
import { createLogger } from '@/utils/logger'
import { createTable, tableStore } from '@stores/useTableStore'
import { useCollections } from '@/stores/useCollections'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { toast } from '@components/ui'
import { primeAttachmentBuffer } from '@components/chat/preview/attachmentBlobCache'

import { markResourceMembershipPending } from './restore/resourceMembershipPending'
import {
  formatCloudFolderUploadAccept,
  planCloudFolderUpload,
} from './cloudFolderUpload'
import {
  isStructuredTabDocImportExtension,
  isTruncatedFetchResultEnvelope,
  shouldInspectTabDocImportForFetchEnvelope,
} from './tabdocImportRouting'
import {
  RESOURCE_IMPORT_ACCEPT,
  RESOURCE_IMPORT_ACCEPT_BY_APP_ID,
  TABFILES_IMPORT_MAX_SIZE_BYTES,
  fileExtension,
  formatResourceImportFormats,
  getImportedResourceTitle,
  getImportMaxSizeBytes,
  resolveResourceImportTargetAppId,
  type CloudDriveImportAppId,
  type ImportableResourceAppId,
} from './resourceFileImportRouting'

const log = createLogger('ResourceImport')

type ResourceImportStage =
  | 'started'
  | 'table_create'
  | 'table_upload'
  | 'table_refresh'
  | 'document_preflight'
  | 'document_upload'
  | 'document_parse'
  | 'document_text_parse'
  | 'document_create'
  | 'slide_upload'
  | 'slide_poll'
  | 'completed'

type ReportImportStage = (
  stage: ResourceImportStage,
  details?: Record<string, unknown>,
) => void

class ResourceImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ResourceImportError'
  }
}

function getImportErrorCode(error: unknown): string {
  if (error instanceof ResourceImportError) return error.code
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown, errorCode?: unknown }
    const code = candidate.code ?? candidate.errorCode
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code
  }
  return error instanceof Error ? error.name : typeof error
}

function normalizeImportedPmJson(
  pmJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return (
    typeof pmJson === 'object'
    && pmJson !== null
    && (!('type' in pmJson) || pmJson.type === 'doc')
  ) ? pmJson : {}
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface SlideImportStatusResponse {
  status?: string
  task_id?: string
  stage?: string
  error?: string
  result?: {
    id?: string
    name?: string
  }
}

async function waitForPptxImport(
  taskId: string,
): Promise<NonNullable<SlideImportStatusResponse['result']>> {
  const maxAttempts = 80
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await apiService.request<SlideImportStatusResponse>({
      method: 'GET',
      url: `/tabslide/import-pptx-status/${encodeURIComponent(taskId)}/`,
    })

    if (status.status === 'completed' && status.result?.id) {
      return status.result
    }
    if (status.status === 'failed') {
      throw new Error(status.error || 'PPTX 导入失败')
    }
    await delay(1500)
  }
  throw new Error('PPTX 导入仍在处理中，请稍后刷新演示列表查看结果')
}

interface UseResourceFileImportOptions {
  spaceId: string
  organizationId: string | null | undefined
  collectionId: string | null
  tabScopeKey: string
  onImported: (appId: CloudDriveImportAppId) => void
}

export function useResourceFileImport({
  spaceId,
  organizationId,
  collectionId,
  tabScopeKey,
  onImported,
}: UseResourceFileImportOptions) {
  const { t, i18n } = useTranslation('context')
  const [importingAppId, setImportingAppId] = useState<CloudDriveImportAppId | null>(null)
  /** 区分单文件 / 文件夹导入，供工具栏 loading 挂到正确按钮 */
  const [importingKind, setImportingKind] = useState<'file' | 'folder' | null>(null)
  const importInFlightRef = useRef(false)

  const showInvalidFileType = useCallback((accept: string) => {
    const formats = formatResourceImportFormats(accept, i18n.resolvedLanguage)
    toast({
      title: t('home.assetBrowser.importInvalidType', { defaultValue: '不支持的文件类型' }),
      description: t('home.assetBrowser.importInvalidTypeDesc', {
        formats,
        defaultValue: `支持的格式：${formats}`,
      }),
      variant: 'destructive',
    })
  }, [i18n.resolvedLanguage, t])

  const openImportedResource = useCallback((
    appId: ImportableResourceAppId,
    id: string,
    title?: string,
  ) => {
    if (appId === 'tabdata') {
      useSpaceContextTabsStore.getState().openTableTab(
        tabScopeKey,
        id,
        true,
        markResourceMembershipPending(),
      )
      return
    }
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: appId,
      id,
      title,
      ...(appId === 'tabdoc' ? { meta: markResourceMembershipPending() } : {}),
    })
  }, [tabScopeKey])

  const importTableFile = useCallback(async (
    file: File,
    targetOrganizationId: string,
    reportStage: ReportImportStage,
  ) => {
    const title = getImportedResourceTitle(file.name, t('label.untitledTable'))
    reportStage('table_create')
    // ：建表只挂 Organization
    const table = await createTable({
      organization_id: targetOrganizationId,
      name: title,
      use_default_fields: false,
      collection_id: collectionId ?? undefined,
    })
    if (!table) {
      throw new Error(t('home.assetBrowser.importCreateTableFailed', {
        defaultValue: '创建表格失败',
      }))
    }

    reportStage('table_upload', { resourceId: table.id })
    await ImportExportApiService.import(file, table.id, {
      autoCreateMissingFields: true,
      skipErrors: false,
      updateExisting: false,
    })
    reportStage('table_refresh', { resourceId: table.id })
    await tableStore.getState().loadTables(targetOrganizationId)
    openImportedResource('tabdata', table.id, table.name || title)
  }, [collectionId, openImportedResource, t])

  const importDocumentFile = useCallback(async (
    file: File,
    targetOrganizationId: string,
    reportStage: ReportImportStage,
  ) => {
    const client = getSharedAppHostClient()
    const extension = fileExtension(file.name)
    const fallbackTitle = getImportedResourceTitle(file.name, t('label.untitledDoc'))

    let title = fallbackTitle
    let markdown = ''
    let plaintext = ''
    let pmJson: Record<string, unknown> = {}
    let skippedImageCount = 0

    let sourceText: string | undefined
    if (shouldInspectTabDocImportForFetchEnvelope(extension)) {
      reportStage('document_preflight')
      sourceText = new TextDecoder('utf-8', { fatal: false }).decode(await file.arrayBuffer())
      if (isTruncatedFetchResultEnvelope(sourceText)) {
        throw new ResourceImportError(
          'TRUNCATED_FETCH_ENVELOPE',
          t('home.assetBrowser.importTruncatedFetchResult', {
            defaultValue: '这是一份被截断的抓取摘要，后半部分不在文件中。请改为导入抓取工具保存的完整内容文件。',
          }),
        )
      }
    }

    if (isStructuredTabDocImportExtension(extension)) {
      reportStage('document_upload')
      const uploadResult = await directUpload(file, file.name, {
        folder: 'tabdoc/imports',
        module: 'tabdoc',
        contextType: 'space',
        contextId: spaceId,
        organizationId: targetOrganizationId,
        isPublic: true,
        enableInstantUpload: false,
      })
      if (!uploadResult.fileId) {
        throw new Error(t('home.assetBrowser.importUploadMissingFileId', {
          defaultValue: '文件上传后缺少 file_id',
        }))
      }
      reportStage('document_parse', { fileRecordId: uploadResult.fileId })
      const parsed = await importDocumentFileDraft(client, {
        organizationId: targetOrganizationId,
        fileRecordId: uploadResult.fileId,
      })
      title = getImportedResourceTitle(file.name, fallbackTitle, parsed.title)
      markdown = parsed.markdown ?? ''
      plaintext = parsed.plaintext ?? ''
      pmJson = normalizeImportedPmJson(parsed.pmJson)
      skippedImageCount = parsed.skippedImages ?? 0
    } else {
      reportStage('document_text_parse')
      const text = sourceText
        ?? new TextDecoder('utf-8', { fatal: false }).decode(await file.arrayBuffer())
      if (text.includes('\uFFFD')) {
        toast({
          title: t('home.assetBrowser.importEncodingWarning', { defaultValue: '编码提示' }),
          description: t('home.assetBrowser.importEncodingWarningDesc', {
            defaultValue: '文件可能不是 UTF-8 编码，部分字符可能显示为乱码',
          }),
        })
      }
      const parsed = await importMarkdown(client, {
        organizationId: targetOrganizationId,
        markdown: text,
      })
      markdown = parsed.markdown ?? text
      plaintext = parsed.plaintext ?? ''
      pmJson = normalizeImportedPmJson(parsed.pmJson)
      skippedImageCount = parsed.skippedImages ?? 0
    }

    reportStage('document_create')
    // ：建文档只挂 Organization
    const created = await createDocument(client, {
      organizationId: targetOrganizationId,
      title,
      markdown,
      pmJson,
      plaintext,
      collectionId,
    })
    const documentId = created.document?.id
    if (!documentId) {
      throw new Error(t('tabdoc:createFailed', {
        ns: 'tabdoc',
        defaultValue: '文档创建失败',
      }))
    }
    openImportedResource('tabdoc', documentId, created.document.title || title)
    return skippedImageCount
  }, [collectionId, openImportedResource, spaceId, t])

  const importSlideFile = useCallback(async (
    file: File,
    targetOrganizationId: string,
    reportStage: ReportImportStage,
  ) => {
    const formData = new FormData()
    formData.append('file', file)
    const query = new URLSearchParams({
      organization_id: targetOrganizationId,
      space_id: spaceId,
    })
    if (collectionId) query.set('collection_id', collectionId)

    reportStage('slide_upload')
    const task = await apiService.request<{ task_id?: string; status?: string }>({
      method: 'POST',
      url: `/tabslide/projects/import-pptx/?${query.toString()}`,
      data: formData,
    })
    if (!task.task_id) {
      throw new Error(t('home.assetBrowser.importPptTaskMissing', {
        defaultValue: '导入任务创建失败',
      }))
    }
    reportStage('slide_poll', { taskId: task.task_id })
    const project = await waitForPptxImport(task.task_id)
    openImportedResource(
      'tabslide',
      project.id!,
      getImportedResourceTitle(file.name, t('label.untitledPpt'), project.name),
    )
  }, [collectionId, openImportedResource, spaceId, t])

  const importGenericFile = useCallback(async (file: File, targetOrganizationId: string) => {
    //  / ：OSS 与挂载一律 organization；带 collection_id 时挂到 Organization Collection。
    const uploaded = await directUpload(file, file.name, {
      folder: 'tabfiles/uploads',
      module: 'tabfiles',
      contextType: 'organization',
      contextId: targetOrganizationId,
      organizationId: targetOrganizationId,
      enableInstantUpload: false,
    })
    if (!uploaded.fileId) {
      throw new Error(t('home.assetBrowser.importUploadMissingFileId', {
        defaultValue: '文件上传后缺少 file_id',
      }))
    }
    // 资源挂载会立即通过 WS 进入云盘。先缓存用户刚选中的原始字节，确保文本类
    // viewer 不必在 OSS 短链刚生成时再抢一次远程读取。
    await primeAttachmentBuffer(uploaded.fileId, file)
    const mounted = await SpaceApiService.uploadOrganizationFile(targetOrganizationId, {
      file_record_id: uploaded.fileId,
      title: file.name,
      ...(collectionId ? { collection_id: collectionId } : {}),
    })
    // 直接使用挂载接口返回的 ContextItem 打开文件，避免刚上传时列表/WS
    // 尚未同步，导致 renderer 拿不到 context_item_id 而误报“文件已删除”。
    const contextItemId = mounted?.id || uploaded.fileId
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: 'file',
      id: uploaded.fileId,
      title: file.name,
      meta: {
        ...(mounted?.metadata ?? {}),
        context_item_id: contextItemId,
        resource_id: mounted?.resource_id || uploaded.fileId,
        organizationId: targetOrganizationId,
        organization_id: targetOrganizationId,
        filename: file.name,
      },
    })
    expandCanvasForScope(tabScopeKey)
  }, [collectionId, tabScopeKey, t])

  /**
   * 云盘一级文件夹上传：创建同名文件夹，仅挂载所选目录下的直接文件（忽略子目录）。
   * 不解析为 TabDoc/TabData，一律裸文件挂载。
   */
  const importFolder = useCallback(async (
    fileList: ArrayLike<File>,
  ): Promise<boolean> => {
    if (importInFlightRef.current) {
      log.warn('忽略重复文件夹导入：已有任务进行中')
      return false
    }
    if (!organizationId) {
      toast({ title: t('createError.noOrganizationDesc'), variant: 'destructive' })
      return false
    }

    // 尽早加锁，避免 onChange 重入导致同一 FileList 挂载两遍
    importInFlightRef.current = true
    setImportingAppId('tabfiles')
    setImportingKind('folder')

    const plan = planCloudFolderUpload(fileList)
    const skippedTotal = plan.skipped.length
    if (plan.accepted.length === 0) {
      importInFlightRef.current = false
      setImportingAppId(null)
      setImportingKind(null)
      toast({
        title: t('home.assetBrowser.importFolderEmpty', {
          defaultValue: '没有可上传的文件',
        }),
        description: t('home.assetBrowser.importFolderEmptyDesc', {
          skipped: skippedTotal,
          formats: formatResourceImportFormats(
            formatCloudFolderUploadAccept(),
            i18n.resolvedLanguage,
          ),
          defaultValue: '已跳过 {{skipped}} 个（子目录、不支持的类型、空文件或过大）。支持：{{formats}}',
        }),
        variant: 'destructive',
      })
      return false
    }

    const startedAt = Date.now()
    let createdCollectionId: string | null = null

    try {
      // ：文件夹创建与文件挂载一律走 Organization Collection
      const collection = await useCollections.getState().createOrganizationCollection(
        organizationId,
        plan.folderName,
        '📁',
        collectionId ?? undefined,
      )
      createdCollectionId = collection.id

      const batch = await directUploadBatch(
        plan.accepted.map(item => ({ file: item.file, fileName: item.fileName })),
        {
          folder: 'tabfiles/uploads',
          module: 'tabfiles',
          // ：OSS context_type 主值改为 organization
          contextType: 'organization',
          contextId: organizationId,
          organizationId,
          enableInstantUpload: false,
          concurrency: 3,
        },
      )

      let mountSuccess = 0
      let mountFailed = 0
      for (let index = 0; index < plan.accepted.length; index += 1) {
        const candidate = plan.accepted[index]
        const uploadResult = batch.results[index]
        if (!uploadResult?.success || !uploadResult.fileId) {
          mountFailed += 1
          continue
        }
        try {
          await primeAttachmentBuffer(uploadResult.fileId, candidate.file)
          await SpaceApiService.uploadOrganizationFile(organizationId, {
            file_record_id: uploadResult.fileId,
            collection_id: createdCollectionId,
            title: candidate.fileName,
          })
          mountSuccess += 1
        } catch (error) {
          mountFailed += 1
          log.error('文件夹导入挂载失败', {
            fileName: candidate.fileName,
            errorCode: getImportErrorCode(error),
          })
        }
      }

      if (mountSuccess === 0) {
        if (createdCollectionId) {
          try {
            await useCollections.getState().deleteCollection(createdCollectionId)
          } catch (error) {
            log.warn('清理空文件夹失败', {
              collectionId: createdCollectionId,
              errorCode: getImportErrorCode(error),
            })
          }
          createdCollectionId = null
        }
        toast({
          title: t('home.assetBrowser.importFolderFailed', {
            defaultValue: '文件夹上传失败',
          }),
          description: t('home.assetBrowser.importFolderFailedDesc', {
            failed: mountFailed,
            skipped: skippedTotal,
            defaultValue: `${mountFailed} 个文件上传失败，已跳过 ${skippedTotal} 个`,
          }),
          variant: 'destructive',
        })
        return false
      }

      toast({
        title: mountFailed > 0 || skippedTotal > 0
          ? t('home.assetBrowser.importFolderPartialSuccess', {
            defaultValue: '文件夹已部分上传',
          })
          : t('home.assetBrowser.importFolderSuccess', {
            defaultValue: '文件夹上传成功',
          }),
        description: t('home.assetBrowser.importFolderSummaryDesc', {
          folderName: plan.folderName,
          success: mountSuccess,
          failed: mountFailed,
          skipped: skippedTotal,
          defaultValue: `「${plan.folderName}」：成功 ${mountSuccess}，失败 ${mountFailed}，跳过 ${skippedTotal}`,
        }),
      })
      log.info('文件夹导入完成', {
        folderName: plan.folderName,
        success: mountSuccess,
        failed: mountFailed,
        skipped: skippedTotal,
        elapsedMs: Date.now() - startedAt,
      })
      return true
    } catch (error) {
      if (createdCollectionId) {
        try {
          await useCollections.getState().deleteCollection(createdCollectionId)
        } catch (cleanupError) {
          log.warn('导入失败后清理文件夹失败', {
            collectionId: createdCollectionId,
            errorCode: getImportErrorCode(cleanupError),
          })
        }
      }
      log.error('文件夹导入失败', {
        folderName: plan.folderName,
        elapsedMs: Date.now() - startedAt,
        errorCode: getImportErrorCode(error),
      })
      toast({
        title: t('home.assetBrowser.importFolderFailed', {
          defaultValue: '文件夹上传失败',
        }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      return false
    } finally {
      importInFlightRef.current = false
      setImportingAppId(null)
      setImportingKind(null)
    }
  }, [collectionId, i18n.resolvedLanguage, organizationId, t])

  const importFile = useCallback(async (
    file: File,
    requestedAppId?: ImportableResourceAppId,
  ): Promise<boolean> => {
    if (importInFlightRef.current) {
      log.warn('忽略重复导入：已有任务进行中', {
        extension: fileExtension(file.name),
        sizeBytes: file.size,
      })
      return false
    }

    // 云盘入口始终按裸文件挂载；只有应用页显式请求时才进入对应解析器。
    const appId = resolveResourceImportTargetAppId(file.name, requestedAppId)
    if (!appId) {
      showInvalidFileType(
        requestedAppId
          ? RESOURCE_IMPORT_ACCEPT_BY_APP_ID[requestedAppId]
          : RESOURCE_IMPORT_ACCEPT,
      )
      return false
    }
    if (!organizationId) {
      toast({ title: t('createError.noOrganizationDesc'), variant: 'destructive' })
      return false
    }

    const extension = fileExtension(file.name)
    const maxImportSizeBytes = appId === 'tabfiles'
      ? TABFILES_IMPORT_MAX_SIZE_BYTES
      : getImportMaxSizeBytes(appId, extension)
    if (file.size > maxImportSizeBytes) {
      const maxSizeMb = Math.round(maxImportSizeBytes / 1024 / 1024)
      toast({
        title: t('home.assetBrowser.importFileTooLarge', { defaultValue: '文件过大' }),
        description: t('home.assetBrowser.importFileTooLargeDesc', {
          maxSizeMb,
          defaultValue: `导入文件不能超过 ${maxSizeMb} MB`,
        }),
        variant: 'destructive',
      })
      return false
    }
    if (file.size === 0) {
      toast({
        title: t('home.assetBrowser.importEmptyFile', { defaultValue: '文件为空' }),
        description: t('home.assetBrowser.importEmptyFileDesc', { defaultValue: '无法导入空文件' }),
        variant: 'destructive',
      })
      return false
    }

    importInFlightRef.current = true
    setImportingAppId(appId)
    setImportingKind('file')
    const startedAt = Date.now()
    let stage: ResourceImportStage = 'started'
    const reportStage: ReportImportStage = (nextStage, details) => {
      stage = nextStage
      log.info('导入阶段', {
        appId,
        extension,
        sizeBytes: file.size,
        stage,
        elapsedMs: Date.now() - startedAt,
        ...details,
      })
    }
    reportStage('started')
    try {
      let skippedImageCount = 0
      if (appId === 'tabdata') await importTableFile(file, organizationId, reportStage)
      else if (appId === 'tabdoc') {
        skippedImageCount = await importDocumentFile(file, organizationId, reportStage)
      } else if (appId === 'tabslide') {
        await importSlideFile(file, organizationId, reportStage)
      } else {
        await importGenericFile(file, organizationId)
      }
      reportStage('completed', { skippedImageCount })
      // TabFiles 的 resource_created 事件在远端可能延迟或丢失；上传挂载成功后
      // 立即刷新一次，再由 cloudResources 做短延迟重试，确保导入成功能出现在列表。
      onImported(appId)
      toast({
        title: skippedImageCount > 0
          ? t('home.assetBrowser.importPartialSuccess', { defaultValue: '已导入部分内容' })
          : t('home.assetBrowser.importSuccess', { defaultValue: '导入成功' }),
        description: skippedImageCount > 0
          ? t('home.assetBrowser.importSkippedImagesDesc', {
            count: skippedImageCount,
            defaultValue: `${skippedImageCount} 张图片未能导入，已以文字占位保留。`,
          })
          : undefined,
      })
      return true
    } catch (error) {
      log.error('导入失败', {
        appId,
        extension,
        sizeBytes: file.size,
        stage,
        elapsedMs: Date.now() - startedAt,
        errorCode: getImportErrorCode(error),
      })
      toast({
        title: t('home.assetBrowser.importFailed', { defaultValue: '导入失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      return false
    } finally {
      importInFlightRef.current = false
      setImportingAppId(null)
      setImportingKind(null)
    }
  }, [
    importDocumentFile,
    importGenericFile,
    importSlideFile,
    importTableFile,
    onImported,
    organizationId,
    showInvalidFileType,
    t,
  ])

  return {
    importFile,
    importFolder,
    importingAppId,
    importingKind,
  }
}
