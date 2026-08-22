import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronDown, Download, FileText, FolderOpen, ListChecks, Send } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '@tabtin/smartsheet-ui'
import { planRefKey } from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import type { ContextItem } from '../../types'
import {
  localFilePreviewRegistry,
  type LocalFilePreviewFormat,
} from '@components/shared/file-preview/localFilePreviewRegistry'
import { translateLocalFileFormatLabel } from '@components/shared/file-preview/localFileFormatLabel'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useFolderContextStore } from '@components/context-space/folder/useFolderStore'
import { useSpaceContextState } from '@components/context-space/SpaceContextAreaContext'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { RemoteAgentBanner } from '@components/context-space/folder/RemoteAgentBanner'
import { sendPlanExecution } from '@components/plan-proposal/planExecute'
import { isPlanExecuted } from '@components/plan-proposal/planExecutedStore'
import { expandCanvasForScope } from '@/services/openResourceLink'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import {
  isFileRecordId,
  resolveOssFileDetail,
  type OssFileDetail,
} from '@/components/chat/preview/resolveOssFileAccessUrl'
import { getAttachmentBuffer } from '@/components/chat/preview/attachmentBlobCache'
import { downloadPreviewResource } from '@/components/chat/preview/downloadPreviewResource'
import { SpaceApiService } from '@/services/spaceApi'
import i18n from '@/i18n'
import { SendToIMDialog } from '@/components/tabchat/SendToIMDialog'
import type { SendToIMResource } from '@/components/tabchat/sendToIM/types'
import { resolveRevealInOsLabel } from '@/components/chat/turn/revealInOsLabel'
import { createLogger } from '@/utils/logger'
import { useSpaceStore } from '@stores/useSpaceStore'

const log = createLogger('TabFilesPaneRenderer')

interface TabFilesPaneRendererProps {
  item: ContextItem
  className?: string
}

/** 云盘 ContextItem 换链宿主：Space 绑定 vs Organization-only。 */
type CloudFileDownloadRef = {
  contextItemId: string
  /** ContextItem 真实绑定的 Space；缺省表示 org-only。 */
  hostSpaceId?: string
  organizationId?: string
  /** 旧 tab 兜底：浏览面 Space（可能不是资源宿主）。 */
  fallbackSpaceId?: string
}

type AvailabilityState =
  | { status: 'checking' }
  | { status: 'available'; mode: 'local' }
  | {
    status: 'available'
    mode: 'oss'
    detail: OssFileDetail
    format?: LocalFilePreviewFormat
    spaceDownloadRef?: CloudFileDownloadRef
    binaryPreviewEligible?: boolean
    previewBlockReason?: 'unsafe_mime' | 'size_limit'
  }
  | {
    status: 'missing'
    message: string
    downloadFallback?: {
      detail: OssFileDetail
      spaceDownloadRef: CloudFileDownloadRef
    }
  }
  | { status: 'access_denied'; message: string }
  | { status: 'load_failed'; message: string }
  | { status: 'unsupported'; message: string }

type CloudFileAccessFailureKind = 'missing' | 'access_denied' | 'load_failed'

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
  }
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status
  return typeof status === 'number' ? status : undefined
}

function classifyCloudFileAccessFailure(error: unknown): CloudFileAccessFailureKind {
  const status = getHttpStatus(error)
  if (status === 404) return 'missing'
  if (status === 401 || status === 403) return 'access_denied'
  return 'load_failed'
}

function cloudFileHostKind(ref: CloudFileDownloadRef): 'space' | 'organization' | 'fallback_space' | 'missing' {
  if (ref.hostSpaceId) return 'space'
  if (ref.organizationId) return 'organization'
  if (ref.fallbackSpaceId) return 'fallback_space'
  return 'missing'
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string {
  const value = meta?.[key]
  return typeof value === 'string' ? value : ''
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 与 ProjectWorkspacePanel 同口径：有 Space 宿主走 Space 换链，否则走 Organization。 */
async function resolveCloudFileDownloadUrl(
  ref: CloudFileDownloadRef,
  options?: { previewMaxBytes?: number },
) {
  // 显式下载不带 options（attachment 语义）；预览才传 previewMaxBytes。
  if (ref.hostSpaceId) {
    return options === undefined
      ? SpaceApiService.getSpaceFileDownloadUrl(ref.hostSpaceId, ref.contextItemId)
      : SpaceApiService.getSpaceFileDownloadUrl(ref.hostSpaceId, ref.contextItemId, options)
  }
  if (ref.organizationId) {
    return options === undefined
      ? SpaceApiService.getOrganizationFileDownloadUrl(ref.organizationId, ref.contextItemId)
      : SpaceApiService.getOrganizationFileDownloadUrl(ref.organizationId, ref.contextItemId, options)
  }
  if (ref.fallbackSpaceId) {
    return options === undefined
      ? SpaceApiService.getSpaceFileDownloadUrl(ref.fallbackSpaceId, ref.contextItemId)
      : SpaceApiService.getSpaceFileDownloadUrl(ref.fallbackSpaceId, ref.contextItemId, options)
  }
  throw new Error('Missing cloud file download host')
}

function agentFolderTitle(): string {
  return i18n.t('context:folder.labels.agentTitle', { defaultValue: '工作空间' })
}

/** 从 meta.file_type 或文件名扩展名解析出已注册的预览 format。 */
function resolvePreviewFormat(
  meta: Record<string, unknown> | undefined,
  fileName: string,
): LocalFilePreviewFormat | undefined {
  const byType = localFilePreviewRegistry.getByFileType(metaString(meta, 'file_type'))
  if (byType) return byType
  return localFilePreviewRegistry.getByPath(fileName)
}

function isBinaryPreviewEligible(
  format: LocalFilePreviewFormat | undefined,
  fileSize: number | undefined,
): boolean {
  if (!format?.renderBinaryPreview) return false
  if (fileSize === undefined || format.maxBinaryPreviewBytes === undefined) return true
  return fileSize <= format.maxBinaryPreviewBytes
}

/** HTML/JSON/Markdown 在云盘里按源码文本展示，不能因为原始 MIME 被标记为
 * unsafe（浏览器执行风险）就禁止 Monaco 文本预览；这里不会执行 HTML。 */
function isSafeSourcePreviewFormat(format: LocalFilePreviewFormat | undefined): boolean {
  return format?.fileType === 'text' || format?.fileType === 'json' || format?.fileType === 'markdown'
}

function openAgentDirectoryInSpace(spaceId: string, tabScopeKey: string, workingDir: string, revealPath?: string): void {
  if (!spaceId || !workingDir) return
  const title = agentFolderTitle()
  const folder = useFolderContextStore.getState().addSpaceFolder(spaceId, {
    rootPath: workingDir,
    kind: 'sandbox',
    title,
  })
  const scopeKey = tabScopeKey || resolveForegroundTabScopeKey(spaceId)
  useSpaceContextTabsStore.getState().openResourceTab(scopeKey, {
    type: 'tabfolder',
    id: folder.folderId,
    title,
    meta: {
      path: workingDir,
      kind: 'sandbox',
      ...(revealPath ? { reveal_path: revealPath } : {}),
    },
  })
  expandCanvasForScope(scopeKey)
}

type OssBinaryPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; data: ArrayBuffer }
  | { status: 'error' }

/**
 * 云盘下载入口。
 * - header：面板顶栏右上角图标（所有可下载格式的统一位置， / ）
 * - inline：仅错误态正文内兜底（顶栏尚不可用时）
 */
const AuthenticatedDownloadButton: React.FC<{
  detail: OssFileDetail
  spaceDownloadRef?: CloudFileDownloadRef
  variant?: 'header' | 'inline'
}> = ({ detail, spaceDownloadRef, variant = 'inline' }) => {
  const { t: tChat } = useTranslation('chat')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const handleDownload = async () => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      // 云盘 ContextItem 每次重新换短时签名；显式下载强制 attachment
      const url = spaceDownloadRef
        ? (await resolveCloudFileDownloadUrl(spaceDownloadRef)).url
        : detail.url
      const result = await downloadPreviewResource({
        url,
        fileName: detail.fileName,
        t: tChat,
      })
      if (result === 'failed') setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  if (variant === 'header') {
    return (
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => void handleDownload()}
          disabled={busy}
          className={cn(
            'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60',
            'text-muted-foreground/75 hover:bg-muted/40 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
            'disabled:opacity-50',
          )}
          title={tChat('preview.download', { defaultValue: '下载' })}
          aria-label={tChat('preview.download', { defaultValue: '下载' })}
          data-testid="oss-file-download"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        {failed && (
          <p className="absolute right-0 top-full z-dropdown mt-1 max-w-[12rem] rounded-md bg-background px-2 py-1 text-caption text-destructive/80 shadow-sm ring-1 ring-border/60">
            {tChat('card.openFile.downloadFailed', { defaultValue: 'Unable to get a new download link. Try again.' })}
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => void handleDownload()}
        disabled={busy}
        className="text-body text-accent underline-offset-2 hover:underline disabled:opacity-50"
        data-testid="oss-file-download"
      >
        {tChat('card.openFile.openOrDownload', { defaultValue: 'Open / Download' })}
      </button>
      {failed && (
        <p className="text-caption text-destructive/65">
          {tChat('card.openFile.downloadFailed', { defaultValue: 'Unable to get a new download link. Try again.' })}
        </p>
      )}
    </div>
  )
}

const OssBinaryPreview: React.FC<{
  detail: OssFileDetail
  format: LocalFilePreviewFormat
  spaceDownloadRef?: CloudFileDownloadRef
  className?: string
}> = ({ detail, format, spaceDownloadRef, className }) => {
  const { t: tChat } = useTranslation('chat')
  const [state, setState] = useState<OssBinaryPreviewState>({ status: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    getAttachmentBuffer({
      fileId: detail.fileId,
      url: detail.url,
      ...(spaceDownloadRef
        ? {
            resolveFreshUrl: async () => (
              await resolveCloudFileDownloadUrl(spaceDownloadRef)
            ).url,
          }
        : {}),
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' })
      })
    return () => {
      controller.abort()
    }
  }, [detail.fileId, detail.url, spaceDownloadRef])

  if (state.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
      </div>
    )
  }

  const renderError = () => (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-6 text-center', className)}>
      <AlertCircle className="h-6 w-6 text-destructive/45" strokeWidth={1} />
      <p className="text-body text-destructive/65" data-testid="oss-binary-preview-error">
        {tChat('card.openFile.unavailable', { defaultValue: 'File deleted or unavailable' })}
      </p>
    </div>
  )

  if (state.status === 'error' || !format.renderBinaryPreview) {
    return renderError()
  }

  let preview: React.ReactNode
  try {
    preview = format.renderBinaryPreview({
      data: state.data,
      fileName: detail.fileName,
      className,
    })
  } catch {
    return renderError()
  }

  return (
    <Suspense
      fallback={
        <div className={cn('flex h-full items-center justify-center', className)}>
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
        </div>
      }
    >
      {preview}
    </Suspense>
  )
}

const OssMediaPreview: React.FC<{
  detail: OssFileDetail
  format?: LocalFilePreviewFormat
  message?: string
  className?: string
}> = ({ detail, format, message, className }) => {
  const fileType = format?.fileType
  const mime = (detail.mimeType || '').toLowerCase()
  const isVideo = fileType === 'video' || mime.startsWith('video/')
  const isAudio = fileType === 'audio' || mime.startsWith('audio/')
  const isImage = fileType === 'image' || mime.startsWith('image/')

  if (isVideo) {
    return (
      <div className={cn('flex h-full w-full items-center justify-center p-4', className)}>
        {/*
          原生 media「下载」对跨域 OSS 签名 URL 无效；关掉原生入口，
          统一走面板顶栏右上角 AuthenticatedDownloadButton。
        */}
        <video
          controls
          controlsList="nodownload"
          className="max-h-full max-w-full"
          src={detail.url}
          data-testid="oss-video-preview"
        />
      </div>
    )
  }
  if (isAudio) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center gap-3 p-8', className)}>
        <p className="max-w-full truncate text-body text-muted-foreground/60">{detail.fileName}</p>
        <audio
          controls
          controlsList="nodownload"
          className="w-full max-w-md"
          src={detail.url}
          data-testid="oss-audio-preview"
        />
      </div>
    )
  }
  if (isImage) {
    return (
      <div className={cn('h-full min-h-0 w-full overflow-auto p-4', className)}>
        <div className="flex min-h-full w-full items-center justify-center">
          <img
            src={detail.url}
            alt={detail.fileName}
            className="max-h-[88vh] max-w-full rounded-lg object-contain"
            data-testid="oss-image-preview"
          />
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-6 text-center', className)}>
      <p className="text-body text-foreground/80">{detail.fileName}</p>
      {message && <p className="text-body text-muted-foreground/60">{message}</p>}
    </div>
  )
}

export const TabFilesPaneRenderer: React.FC<TabFilesPaneRendererProps> = ({
  item,
  className,
}) => {
  const { t } = useTranslation('plan')
  const { t: tChat } = useTranslation('chat')
  const { spaceId, tabScopeKey } = useSpaceContextState()
  const hostOrganizationId = useSpaceStore(state => state.spaces.find(space => space.id === spaceId)?.organization_id ?? null)
  const {
    isRemoteViewer,
    controlDeviceName,
    workingDir: remoteWorkingDir,
  } = useIsRemoteViewer(spaceId)
  const artifactKind = metaString(item.meta, 'artifact_kind')
  const accessUrlFromMeta = metaString(item.meta, 'access_url')
  const contextItemId = metaString(item.meta, 'context_item_id')
  const resourceSpaceId = metaString(item.meta, 'spaceId') || spaceId
  const fileHostSpaceId = metaString(item.meta, 'file_host_space_id')
  const organizationId = metaString(item.meta, 'organizationId')
    || metaString(item.meta, 'organization_id')
    || hostOrganizationId
  const cloudDownloadRef = useMemo<CloudFileDownloadRef | undefined>(() => {
    if (!contextItemId) return undefined
    return {
      contextItemId,
      ...(fileHostSpaceId ? { hostSpaceId: fileHostSpaceId } : {}),
      ...(organizationId ? { organizationId } : {}),
      // 无宿主信息时保留旧行为：用浏览面 Space（Space 绑定资源仍可工作）
      ...(!fileHostSpaceId && !organizationId && resourceSpaceId
        ? { fallbackSpaceId: resourceSpaceId }
        : {}),
    }
  }, [contextItemId, fileHostSpaceId, organizationId, resourceSpaceId])
  const fileName = metaString(item.meta, 'filename')
    || metaString(item.meta, 'file_name')
    || item.title
    || item.id.split('/').pop()
    || item.id
  const filePath = metaString(item.meta, 'absolute_path') || metaString(item.meta, 'path')
  const relativePath = metaString(item.meta, 'relative_path') || item.id
  const workingDir = metaString(item.meta, 'working_dir')
  const refreshToken = metaString(item.meta, 'local_file_refresh_token')
    || metaString(item.meta, 'local_file_refreshed_at')
  const presentation = useMemo(
    () => resolvePreviewFormat(item.meta, fileName),
    [fileName, item.meta],
  )
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'checking' })
  const missingMessage = tChat('card.openFile.unavailable', {
    defaultValue: 'File deleted or unavailable',
  })
  const accessDeniedMessage = tChat('card.openFile.accessDenied', {
    defaultValue: 'You do not have permission to open this file.',
  })
  const loadFailedMessage = tChat('card.openFile.loadFailed', {
    defaultValue: 'The file could not be loaded.',
  })
  const unsupportedMessage = tChat('card.openFile.unsupportedPreview', {
    extensions: localFilePreviewRegistry.extensions().join(' / '),
    defaultValue: 'Only these local artifacts can be previewed: {{extensions}}',
  })

  // ：.plan.md 预览提供「执行」按钮——切 agent 模式 + 发「计划」context 卡片到
  // 本 Space 当前会话（与 PlanProposalCard 执行按钮共用 sendPlanExecution）。
  const isPlanFile = relativePath.endsWith('.plan.md')
  const planSessionId = useChatStore((s) => (spaceId ? s.currentSessionIdBySpaceId[spaceId] ?? null : null))
  const planRefKeyStr = isPlanFile ? planRefKey({ kind: 'file', path: relativePath }) : ''
  const [planExecuted, setPlanExecuted] = useState(false)
  useEffect(() => {
    setPlanExecuted(isPlanFile ? isPlanExecuted(planRefKeyStr) : false)
  }, [isPlanFile, planRefKeyStr])
  const handleExecutePlan = async () => {
    if (!planSessionId || planExecuted || isRemoteViewer) return
    // 仅在发送成功后才置「已执行」——失败不锁死，可重试（与 PlanProposalCard 一致）。
    const ok = await sendPlanExecution({ ref: { kind: 'file', path: relativePath }, sessionId: planSessionId, spaceId })
    if (ok) {
      setPlanExecuted(true)
      toast({ title: t('proposal.executeSuccessNoName'), duration: 2000 })
    } else {
      toast({ title: t('proposal.executeErrorSend'), variant: 'destructive' })
    }
  }
  const canExecutePlan = isPlanFile && !!planSessionId && !isRemoteViewer
  const [sendToIMOpen, setSendToIMOpen] = useState(false)

  const sendToIMResource = useMemo((): SendToIMResource | null => {
    const fileId = metaString(item.meta, 'resource_id') || item.id
    if (!fileId || !contextItemId) return null
    const ossDetailForSend = availability.status === 'available' && availability.mode === 'oss'
      ? availability.detail
      : null
    return {
      kind: 'cloud_file',
      fileId,
      fileName: ossDetailForSend?.fileName || fileName,
      fileSize: ossDetailForSend?.fileSize ?? metaNumber(item.meta, 'file_size'),
      mimeType: ossDetailForSend?.mimeType
        || metaString(item.meta, 'mime_type')
        || metaString(item.meta, 'file_type')
        || undefined,
    }
  }, [availability, contextItemId, fileName, item.id, item.meta])

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      if (isRemoteViewer) return

      // 云盘 ContextItem 必须经宿主权限接口换短时下载 URL（Space 或 Organization），
      // 避免退回 FileRecord 上传者权限；同时保留 downloadRef 供签名过期时重新换链。
      // ：Agent / drive upload 产物多为 org-only，不可误走浏览面 Space 换链。
      if (!filePath && cloudDownloadRef) {
        setAvailability({ status: 'checking' })
        const previewMaxBytes = presentation?.renderBinaryPreview
          ? presentation.maxBinaryPreviewBytes
          : undefined
        try {
          const download = await resolveCloudFileDownloadUrl(
            cloudDownloadRef,
            previewMaxBytes === undefined ? undefined : { previewMaxBytes },
          )
          if (cancelled) return
          const detail: OssFileDetail = {
            fileId: item.id,
            fileName: download.file_name || fileName,
            url: download.url,
            mimeType: download.mime_type || undefined,
            fileType: metaString(item.meta, 'file_type') || undefined,
            fileSize: typeof download.file_size === 'number' ? download.file_size : undefined,
          }
          const format = resolvePreviewFormat(
            { file_type: detail.fileType, filename: detail.fileName },
            detail.fileName,
          )
          const safeSourcePreview = isSafeSourcePreviewFormat(format)
          setAvailability({
            status: 'available',
            mode: 'oss',
            detail,
            format,
            spaceDownloadRef: cloudDownloadRef,
            binaryPreviewEligible: (download.preview_eligible !== false || safeSourcePreview)
              && isBinaryPreviewEligible(format, detail.fileSize),
            previewBlockReason: download.preview_eligible === false && !safeSourcePreview
              ? (download.mime_preview_safe === false ? 'unsafe_mime' : 'size_limit')
              : undefined,
          })
        } catch (error) {
          if (cancelled) return
          const fallbackFileId = metaString(item.meta, 'resource_id') || item.id
          if (fallbackFileId && fallbackFileId !== item.id) {
            try {
              const fallback = await resolveOssFileDetail(fallbackFileId)
              if (cancelled) return
              const fallbackFormat = resolvePreviewFormat(
                { file_type: fallback.mimeType, filename: fallback.fileName },
                fallback.fileName,
              )
              setAvailability({
                status: 'available',
                mode: 'oss',
                detail: fallback,
                format: fallbackFormat,
                binaryPreviewEligible: isBinaryPreviewEligible(fallbackFormat, fallback.fileSize),
              })
              return
            } catch { /* continue with the original error classification */ }
            try {
              const bytes = await getAttachmentBuffer({ fileId: fallbackFileId, url: '' })
              if (cancelled) return
              const blobUrl = URL.createObjectURL(new Blob([bytes], {
                type: metaString(item.meta, 'mime_type') || 'application/octet-stream',
              }))
              const fallbackFormat = resolvePreviewFormat(
                { file_type: metaString(item.meta, 'file_type'), filename: fileName },
                fileName,
              )
              setAvailability({
                status: 'available',
                mode: 'oss',
                detail: {
                  fileId: fallbackFileId,
                  fileName,
                  url: blobUrl,
                  mimeType: metaString(item.meta, 'mime_type') || undefined,
                  fileType: metaString(item.meta, 'file_type') || undefined,
                  fileSize: bytes.byteLength,
                },
                format: fallbackFormat,
                binaryPreviewEligible: isBinaryPreviewEligible(fallbackFormat, bytes.byteLength),
              })
              return
            } catch { /* cache may have expired; continue with the error state */ }
          }
          const failureKind = classifyCloudFileAccessFailure(error)
          log.warn('Cloud file preview URL exchange failed', {
            failureKind,
            hostKind: cloudFileHostKind(cloudDownloadRef),
            httpStatus: getHttpStatus(error),
            contextItemIdPrefix: cloudDownloadRef.contextItemId.slice(0, 8),
          })
          if (failureKind === 'missing') {
            setAvailability({
              status: 'missing',
              message: missingMessage,
              downloadFallback: {
                detail: {
                  fileId: item.id,
                  fileName,
                  url: '',
                  fileType: metaString(item.meta, 'file_type') || undefined,
                },
                spaceDownloadRef: cloudDownloadRef,
              },
            })
          } else if (failureKind === 'access_denied') {
            setAvailability({ status: 'access_denied', message: accessDeniedMessage })
          } else {
            setAvailability({ status: 'load_failed', message: loadFailedMessage })
          }
        }
        return
      }

      // 已带 access_url 的 oss_file（打开链路 enrich 过）
      if (artifactKind === 'oss_file' && accessUrlFromMeta) {
        const detail: OssFileDetail = {
          fileId: metaString(item.meta, 'file_id') || item.id,
          fileName,
          url: accessUrlFromMeta,
          mimeType: metaString(item.meta, 'mime_type') || undefined,
          fileType: metaString(item.meta, 'file_type') || undefined,
          fileSize: metaNumber(item.meta, 'file_size'),
        }
        setAvailability({
          status: 'available',
          mode: 'oss',
          detail,
          format: presentation,
          binaryPreviewEligible: isBinaryPreviewEligible(presentation, detail.fileSize),
        })
        return
      }

      // 空 meta + FileRecord UUID：自愈查 OSS（Agent 误开 / 旧 tab）
      if (!filePath && isFileRecordId(item.id)) {
        setAvailability({ status: 'checking' })
        try {
          const detail = await resolveOssFileDetail(item.id)
          if (cancelled) return
          const format = resolvePreviewFormat(
            { file_type: detail.fileType, filename: detail.fileName },
            detail.fileName,
          )
          setAvailability({
            status: 'available',
            mode: 'oss',
            detail,
            format,
            binaryPreviewEligible: isBinaryPreviewEligible(format, detail.fileSize),
          })
        } catch {
          if (!cancelled) {
            setAvailability({ status: 'missing', message: missingMessage })
          }
        }
        return
      }

      if (!presentation) {
        setAvailability({ status: 'unsupported', message: unsupportedMessage })
        return
      }
      if (!filePath) {
        setAvailability({ status: 'missing', message: missingMessage })
        return
      }
      const pathExists = window.tabtin?.fileSystem?.pathExists
      if (!pathExists) {
        setAvailability({ status: 'missing', message: missingMessage })
        return
      }

      setAvailability({ status: 'checking' })
      try {
        const result = await pathExists(filePath)
        if (cancelled) return
        if (result?.success && result.exists && result.isFile !== false && !result.isDirectory) {
          setAvailability({ status: 'available', mode: 'local' })
        } else {
          setAvailability({ status: 'missing', message: missingMessage })
        }
      } catch {
        if (!cancelled) {
          setAvailability({ status: 'missing', message: missingMessage })
        }
      }
    }

    void check()
    return () => {
      cancelled = true
    }
  }, [
    accessUrlFromMeta,
    accessDeniedMessage,
    artifactKind,
    cloudDownloadRef,
    fileName,
    filePath,
    isRemoteViewer,
    item.id,
    item.meta,
    missingMessage,
    presentation,
    refreshToken,
    loadFailedMessage,
    unsupportedMessage,
  ])

  if (isRemoteViewer) {
    return (
      <RemoteAgentBanner
        controlDeviceName={controlDeviceName}
        workingDir={(remoteWorkingDir ?? workingDir) || undefined}
        appLabel={tChat('card.openFile.appLabel', { defaultValue: 'Files' })}
      />
    )
  }

  const ossDetail = availability.status === 'available' && availability.mode === 'oss'
    ? availability.detail
    : null
  const ossFormat = availability.status === 'available' && availability.mode === 'oss'
    ? availability.format
    : undefined
  const displayName = ossDetail?.fileName || fileName
  const displayFormat = ossFormat || presentation
  // 云盘导入物在产品模型里统一属于「文件」；具体格式只决定用哪个只读 viewer，
  // 不应把 Markdown / DOCX 等预览能力误显示成资源分类。
  const displayFormatLabel = contextItemId
    ? translateLocalFileFormatLabel('file', tChat)
    : translateLocalFileFormatLabel(
        displayFormat?.fileType,
        tChat,
        displayFormat?.label,
      )
  const displaySubtitlePath = ossDetail
    ? (metaString(item.meta, 'source') === 'oss_file_record' || artifactKind === 'oss_file'
      ? tChat('card.openFile.ossAttachment', { defaultValue: 'OSS attachment' })
      : item.id)
    : relativePath

  const renderBody = () => {
    if (availability.status === 'checking') {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
        </div>
      )
    }

    if (
      availability.status === 'missing'
      || availability.status === 'access_denied'
      || availability.status === 'load_failed'
      || availability.status === 'unsupported'
    ) {
      const isError = availability.status !== 'unsupported'
      return (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <AlertCircle
            className={cn('mb-2 h-6 w-6', isError ? 'text-destructive/45' : 'text-muted-foreground/35')}
            strokeWidth={1}
          />
          <p className={cn('text-body', isError ? 'text-destructive/65' : 'text-muted-foreground/60')}>
            {availability.message}
          </p>
        </div>
      )
    }

    if (availability.mode === 'oss') {
      if (availability.format?.renderBinaryPreview && availability.binaryPreviewEligible) {
        return (
          <OssBinaryPreview
            detail={availability.detail}
            format={availability.format}
            spaceDownloadRef={availability.spaceDownloadRef}
            className="h-full"
          />
        )
      }
      return (
        <OssMediaPreview
          detail={availability.detail}
          format={availability.format}
          message={
            availability.format?.renderBinaryPreview && availability.binaryPreviewEligible === false
              ? availability.previewBlockReason === 'unsafe_mime'
                ? tChat('card.openFile.unsupportedRemotePreview', {
                    defaultValue: 'Preview is not supported for this file type.',
                  })
                : tChat('card.openFile.previewTooLarge', {
                    defaultValue: 'File exceeds the read-only preview limit. Download it to view locally.',
                  })
              : tChat('card.openFile.unsupportedRemotePreview', {
                  defaultValue: 'Preview is not supported for this file type.',
                })
          }
          className="h-full"
        />
      )
    }

    if (!presentation || !filePath) return null

    return (
      <Suspense
        key={refreshToken || filePath}
        fallback={
          <div className="flex h-full items-center justify-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
          </div>
        }
      >
        {presentation.renderPreview({ filePath, fileName, className: 'h-full' })}
      </Suspense>
    )
  }

  const HeaderIcon = displayFormat?.Icon ?? FileText
  const headerDownload =
    availability.status === 'available' && availability.mode === 'oss'
      ? {
          detail: availability.detail,
          spaceDownloadRef: availability.spaceDownloadRef,
        }
      : availability.status === 'missing' && availability.downloadFallback
        ? availability.downloadFallback
        : null

  return (
    <div className={cn('flex h-full w-full flex-col bg-background', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <HeaderIcon className={cn('h-4 w-4 shrink-0', displayFormat?.iconClassName ?? 'text-muted-foreground')} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium text-foreground/85">{displayName}</div>
          <div className="truncate text-caption text-muted-foreground/55">
            {displayFormatLabel}{displaySubtitlePath ? ` · ${displaySubtitlePath}` : ''}
          </div>
        </div>
        {headerDownload && (
          <>
            <AuthenticatedDownloadButton
              detail={headerDownload.detail}
              spaceDownloadRef={headerDownload.spaceDownloadRef}
              variant="header"
            />
            {sendToIMResource && (
              <button
                type="button"
                onClick={() => setSendToIMOpen(true)}
                className={cn(
                  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60',
                  'text-muted-foreground/75 hover:bg-muted/40 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
                )}
                title={tChat('preview.sendToIM', { defaultValue: '发送到私信' })}
                aria-label={tChat('preview.sendToIM', { defaultValue: '发送到私信' })}
                data-testid="oss-file-send-to-im"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
        {canExecutePlan && (
          <button
            type="button"
            disabled={planExecuted}
            onClick={handleExecutePlan}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-body font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
              planExecuted
                ? 'border border-border/60 text-muted-foreground/55'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
            data-testid="plan-file-execute"
          >
            <ListChecks className="h-3.5 w-3.5" />
            {planExecuted ? t('proposal.executedButton') : t('proposal.executeButton')}
          </button>
        )}
        {filePath && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2.5',
                  'text-body font-medium text-muted-foreground/75 hover:bg-muted/40 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
                )}
                aria-label={tChat('card.openFile.openIn', { defaultValue: 'Open in' })}
              >
                {tChat('card.openFile.openIn', { defaultValue: 'Open in' })}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-56">
              {workingDir && (
                <DropdownMenuItem onSelect={() => openAgentDirectoryInSpace(spaceId, tabScopeKey, workingDir, filePath)} className="gap-2">
                  <FolderOpen className="h-4 w-4" />
                  <span>{tChat('card.openFile.openInWorkspace', { defaultValue: '工作空间' })}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void window.tabtin?.openPath?.(filePath)} className="gap-2">
                <HeaderIcon className={cn('h-4 w-4', displayFormat?.iconClassName ?? 'text-muted-foreground')} />
                <span>{tChat('card.openFile.systemApp', { defaultValue: 'System app' })}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void (window.tabtin?.showItemInFolder?.(filePath) ?? window.tabtin?.openPath?.(filePath))}
                className="gap-2"
              >
                <FolderOpen className="h-4 w-4" />
                <span>{resolveRevealInOsLabel(tChat)}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {renderBody()}
      </div>

      {sendToIMOpen && sendToIMResource && (
        <SendToIMDialog
          open={sendToIMOpen}
          onOpenChange={setSendToIMOpen}
          resource={sendToIMResource}
          organizationId={organizationId || undefined}
        />
      )}
    </div>
  )
}

TabFilesPaneRenderer.displayName = 'TabFilesPaneRenderer'
