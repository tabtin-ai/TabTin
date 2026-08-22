/* eslint-disable tabtin/no-chat-design-violations -- 文件类型识别色（xlsx 绿 / docx 蓝 / pdf 红 / pptx 琥珀）是 Office 文档约定的身份色，等同 IDE 文件图标配色，非 UI 警示色 */
/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 355-388）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：file kind 渲染 —— 下载链接 + MIME / file size 格式化。
 * 业务逻辑版本：与拆分前完全相同，只是 module 边界调整
 */

import React, { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileCode, FileDown, FileSpreadsheet, FileText, FileType, Film, Image as ImageIcon, Music, Presentation } from 'lucide-react'
import type { RichContentBlock } from '@tabtin/chat-client'
import {
  handleResourceLinkClick,
  handleResourceLinkContextMenu,
  openResourceUrlInSpace,
} from '@/services/openResourceLink'
import {
  isUnsupportedLocalArtifactHref,
  stripShellPathQuotes,
} from '@/services/localFileResourceResolver'
import { cn } from '@utils/cn'
import {
  LOCAL_FILE_FORMAT_LABEL_FALLBACKS,
  translateLocalFileFormatLabel,
  type LocalFileFormatLabelKey,
} from '@components/shared/file-preview/localFileFormatLabel'
import { useArtifactOpenActions } from '../turn/useArtifactOpenActions'
import { ArtifactOpenInMenu } from '../turn/ArtifactOpenInMenu'
import { RichFallback } from './RichFallback'
import { registerAgentArtifactTab } from '@/services/registerAgentArtifactTab'
import { useResourcePreviewStore } from '../preview/useResourcePreviewStore'
import { resolveLegacyFilePreviewResource } from '../preview/assetPreviewResolver'
import type { OpenIntentHints } from '@shared/open-intent'
import { useResourceOpenExecutionSpaceId } from '../panel/ResourceOpenExecutionSpaceContext'

const autoOpenedHrefKeys = new Set<string>()

type LocalArtifactPresentation = {
  formatKey: LocalFileFormatLabelKey | null
  typeLabelFallback: string
  iconClassName: string
  Icon: typeof FileSpreadsheet
}

function resolveLocalArtifactPresentation(args: {
  fileType: string
  mimeType?: string
  title: string
}): LocalArtifactPresentation {
  const lowerTitle = args.title.toLowerCase()
  const isSpreadsheet = args.fileType === 'xlsx'
    || args.fileType === 'xls'
    || args.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || args.mimeType === 'application/vnd.ms-excel'
    || lowerTitle.endsWith('.xlsx')
    || lowerTitle.endsWith('.xls')
  if (isSpreadsheet) {
    return {
      formatKey: 'xlsx',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.xlsx,
      iconClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
      Icon: FileSpreadsheet,
    }
  }

  const isCsv = args.fileType === 'csv'
    || args.mimeType === 'text/csv'
    || args.mimeType === 'application/csv'
    || lowerTitle.endsWith('.csv')
  if (isCsv) {
    return {
      formatKey: 'csv',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.csv,
      iconClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
      Icon: FileSpreadsheet,
    }
  }

  const isDocx = args.fileType === 'docx'
    || args.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || lowerTitle.endsWith('.docx')
  if (isDocx) {
    return {
      formatKey: 'docx',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.docx,
      iconClassName: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300',
      Icon: FileText,
    }
  }

  const isPdf = args.fileType === 'pdf'
    || args.mimeType === 'application/pdf'
    || lowerTitle.endsWith('.pdf')
  if (isPdf) {
    return {
      formatKey: 'pdf',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.pdf,
      iconClassName: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300',
      Icon: FileType,
    }
  }

  const isPptx = args.fileType === 'pptx'
    || args.mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || lowerTitle.endsWith('.pptx')
  if (isPptx) {
    return {
      formatKey: 'pptx',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.pptx,
      iconClassName: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
      Icon: Presentation,
    }
  }

  // ：图片（含 SVG）卡片身份色
  const isImage = args.fileType === 'image'
    || args.fileType === 'png' || args.fileType === 'jpg' || args.fileType === 'jpeg'
    || args.fileType === 'gif' || args.fileType === 'webp' || args.fileType === 'svg'
    || (typeof args.mimeType === 'string' && args.mimeType.startsWith('image/'))
    || /\.(png|jpe?g|gif|webp|svg)$/i.test(lowerTitle)
  if (isImage) {
    return {
      formatKey: 'image',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.image,
      iconClassName: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300',
      Icon: ImageIcon,
    }
  }

  const isVideo = args.fileType === 'video'
    || (typeof args.mimeType === 'string' && args.mimeType.startsWith('video/'))
    || /\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i.test(lowerTitle)
  if (isVideo) {
    return {
      formatKey: 'video',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.video,
      iconClassName: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300',
      Icon: Film,
    }
  }

  const isAudio = args.fileType === 'audio'
    || (typeof args.mimeType === 'string' && args.mimeType.startsWith('audio/'))
    || /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(lowerTitle)
  if (isAudio) {
    return {
      formatKey: 'audio',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.audio,
      iconClassName: 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/30 dark:text-violet-300',
      Icon: Music,
    }
  }

  const isTxt = args.fileType === 'txt' || lowerTitle.endsWith('.txt')
  if (isTxt) {
    return {
      formatKey: 'txt',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.txt,
      iconClassName: 'border-border/60 bg-muted/30 text-muted-foreground',
      Icon: FileText,
    }
  }

  if (args.fileType === 'text') {
    return {
      formatKey: 'text',
      typeLabelFallback: LOCAL_FILE_FORMAT_LABEL_FALLBACKS.text,
      iconClassName: 'border-border/60 bg-muted/30 text-muted-foreground',
      Icon: FileCode,
    }
  }

  const rawFallback = args.fileType ? args.fileType.toUpperCase() : (args.mimeType ?? '')
  return {
    formatKey: null,
    typeLabelFallback: rawFallback,
    iconClassName: 'border-border/60 bg-muted/30 text-muted-foreground',
    Icon: FileDown,
  }
}

export const RichFile: React.FC<{ block: RichContentBlock; tabScopeKey?: string | null }> = React.memo(({ block, tabScopeKey }) => {
  const { t } = useTranslation('chat')
  const executionSpaceId = useResourceOpenExecutionSpaceId()
  const fileBlock = block as RichContentBlock & {
    artifact_kind?: string
    file_type?: string
    filename?: string
    mime_type?: string
    relative_path?: string
    file_id?: string
    auto_open?: boolean
    auto_open_token?: string
    auto_register?: boolean
    auto_register_token?: string
    self_check?: { status?: string; summary?: string }
  }

  const sizeLabel = useMemo(() => {
    if (!fileBlock.file_size) return ''
    if (fileBlock.file_size < 1024) return `${fileBlock.file_size} B`
    if (fileBlock.file_size < 1024 * 1024) return `${(fileBlock.file_size / 1024).toFixed(1)} KB`
    return `${(fileBlock.file_size / (1024 * 1024)).toFixed(1)} MB`
  }, [fileBlock.file_size])

  const title = stripShellPathQuotes(
    fileBlock.filename ?? basename(fileBlock.relative_path) ?? fileBlock.summary ?? '',
  )
  const fileType = (fileBlock.file_type ?? extensionOf(title) ?? '').toLowerCase()
  const href = localFileResourceUrl(fileBlock)
    ?? ossFileResourceUrl(fileBlock)
    ?? fileBlock.url
  const openIntentHints: OpenIntentHints = useMemo(() => ({
    ...(title ? { filename: title } : {}),
    ...(fileBlock.mime_type ? { mimeType: fileBlock.mime_type } : {}),
    ...(fileBlock.file_id ? { assetId: fileBlock.file_id } : {}),
  }), [fileBlock.file_id, fileBlock.mime_type, title])
  const directPreviewResource = typeof fileBlock.url === 'string' && href === fileBlock.url
    ? resolveLegacyFilePreviewResource({
        url: fileBlock.url,
        filename: title,
        mimeType: fileBlock.mime_type,
        size: typeof fileBlock.file_size === 'number' ? fileBlock.file_size : undefined,
        fileId: fileBlock.file_id,
      })
    : null
  const isOssFile = fileBlock.artifact_kind === 'oss_file'
  // 打开语义与「本轮产物」卡共用同一套（useArtifactOpenActions）——href 为空时
  // 下方走 RichFallback，hook 以空串安全空跑（不违反 hooks 调用顺序）。
  const openActions = useArtifactOpenActions({
    href: href ?? '',
    tabScopeKey,
    executionSpaceId,
    isOssFile,
    openIntentHints,
    fileSize: typeof fileBlock.file_size === 'number' ? fileBlock.file_size : null,
  })
  const isRemoteLocalFile = openActions.isRemoteLocalFile
  const isSharedSessionLocalFile = openActions.isSharedSessionLocalFile
  const isSharedPreviewTooLarge = openActions.isSharedPreviewTooLarge
  const blockLocalOpenEscapes = isRemoteLocalFile || isSharedSessionLocalFile
  const presentation = resolveLocalArtifactPresentation({
    fileType,
    mimeType: fileBlock.mime_type,
    title,
  })
  const { formatKey, typeLabelFallback, iconClassName, Icon: FileIcon } = presentation
  const typeLabel = formatKey
    ? translateLocalFileFormatLabel(formatKey, t, typeLabelFallback)
    : typeLabelFallback
  const metaLabel = [
    typeLabel,
    sizeLabel,
    isSharedSessionLocalFile
      ? t('card.openFile.sharedPreviewChip', { defaultValue: '共享预览' })
      : isRemoteLocalFile
        ? t('card.openFile.remoteChip', { defaultValue: '远程设备文件' })
        : '',
  ].filter(Boolean).join(' · ')
  const selfCheck = fileBlock.self_check
  const shouldShowSelfCheck = selfCheck?.status && selfCheck.status !== 'passed'

  useEffect(() => {
    // 共享会话远端文件不注册到工作区标签；遥控端同理。
    if (!fileBlock.auto_register || blockLocalOpenEscapes) return
    const resourceId = fileBlock.file_id || fileBlock.relative_path
    if (!resourceId) return
    void registerAgentArtifactTab({
      tabScopeKey,
      resourceType: 'file',
      resourceId,
      title,
      hintCarrierAppId: 'tabfiles',
      token: fileBlock.auto_register_token,
    })
  }, [
    fileBlock.auto_register,
    fileBlock.auto_register_token,
    fileBlock.file_id,
    fileBlock.relative_path,
    blockLocalOpenEscapes,
    tabScopeKey,
    title,
  ])

  useEffect(() => {
    if (!fileBlock.auto_open || !href) return
    if (blockLocalOpenEscapes) return
    // ：白名单外本地产物（dmg 等）无法在 Space 内预览，不自动尝试（否则弹
    // 红色报错）；卡片仍在，用户可点开走系统应用降级。
    if (isUnsupportedLocalArtifactHref(href)) return
    const key = `tabtin:auto-open-artifact:${fileBlock.auto_open_token || href}`
    if (autoOpenedHrefKeys.has(key)) return
    if (typeof window !== 'undefined' && window.sessionStorage?.getItem(key)) return
    autoOpenedHrefKeys.add(key)
    try {
      window.sessionStorage?.setItem(key, '1')
    } catch {
      // best-effort de-dupe only
    }
    if (directPreviewResource) {
      window.setTimeout(() => {
        useResourcePreviewStore.getState().open([directPreviewResource], 0)
      }, 0)
      return
    }
    window.setTimeout(() => openResourceUrlInSpace(href, tabScopeKey, {
      openIntentHints,
      executionSpaceId,
    }), 0)
  }, [
    blockLocalOpenEscapes,
    directPreviewResource,
    fileBlock.auto_open,
    fileBlock.auto_open_token,
    href,
    openIntentHints,
    tabScopeKey,
    executionSpaceId,
  ])

  if (!href) {
    return <RichFallback block={block} />
  }

  // W8 L29 / L77：删 target=_blank 新窗口属性，改为 onClick → 统一打开语义
  // —— D1 链接归属 Space 一视同仁；⌘+click 仍走 D2 第 5 层逃生（external）。
  // 共享会话远端文件禁用逃生，只允许侧边抽屉预览。
  return (
    <div
      role="link"
      tabIndex={0}
      data-href={href}
      onClick={(e) => {
        if (isRemoteLocalFile) {
          e.preventDefault()
          openActions.showRemoteUnavailable()
          return
        }
        if (isSharedSessionLocalFile) {
          e.preventDefault()
          if (isSharedPreviewTooLarge) return
          void openActions.openPrimary()
          return
        }
        // ⌘ / Ctrl+click：保留「系统应用逃生」；普通点击走统一主动作。
        if (e.metaKey || e.ctrlKey) {
          handleResourceLinkClick(e, href, tabScopeKey, executionSpaceId)
          return
        }
        e.preventDefault()
        if (directPreviewResource) {
          useResourcePreviewStore.getState().open([directPreviewResource], 0)
          return
        }
        void openActions.openPrimary()
      }}
      onContextMenu={(e) => {
        if (isRemoteLocalFile) {
          e.preventDefault()
          openActions.showRemoteUnavailable()
          return
        }
        if (isSharedSessionLocalFile) {
          e.preventDefault()
          if (isSharedPreviewTooLarge) return
          void openActions.openPrimary()
          return
        }
        handleResourceLinkContextMenu(e, href, tabScopeKey, executionSpaceId)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (isSharedSessionLocalFile) {
            if (isSharedPreviewTooLarge) return
            void openActions.openPrimary()
            return
          }
          if (directPreviewResource) {
            useResourcePreviewStore.getState().open([directPreviewResource], 0)
            return
          }
          void openActions.openPrimary()
        }
      }}
      className={cn(
        'group flex w-full max-w-[min(28rem,100%)] cursor-pointer items-center gap-2 rounded-lg border border-border/60',
        'bg-background/80 px-3 py-2 text-left shadow-sm transition-colors',
        'hover:border-border hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/35',
        isSharedPreviewTooLarge && 'cursor-not-allowed opacity-80',
      )}
      title={isSharedPreviewTooLarge ? (openActions.sharedPreviewDisabledHint ?? undefined) : undefined}
      aria-label={
        isSharedPreviewTooLarge
          ? (openActions.sharedPreviewDisabledHint ?? undefined)
          : t('card.openFile.openCardAria', { title, defaultValue: 'Open {{title}}' })
      }
      data-testid="rich-file-card"
    >
      <span
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
          iconClassName,
        )}
        aria-hidden
      >
        <FileIcon className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-caption font-medium text-foreground truncate">
          {title}
        </p>
        {metaLabel && (
          <p className="text-caption text-muted-foreground/60 truncate">
            {metaLabel}
          </p>
        )}
        {shouldShowSelfCheck && (
          <p className="text-caption text-warning truncate">
            {selfCheck.summary ?? selfCheck.status}
          </p>
        )}
      </div>
      <ArtifactOpenInMenu
        actions={openActions}
        fileIcon={FileIcon}
        isOssFile={isOssFile}
        title={title}
        stopPropagation
        triggerClassName="group-hover:border-accent/30 group-hover:text-accent"
      />
    </div>
  )
})

function localFileResourceUrl(block: {
  artifact_kind?: string
  relative_path?: string
  filename?: string
  summary?: string
  auto_open?: boolean
  auto_open_token?: string
}): string | null {
  if (block.artifact_kind !== 'local_file' || !block.relative_path) return null
  const relativePath = stripShellPathQuotes(block.relative_path)
  if (!relativePath) return null
  const params = new URLSearchParams({ hint: 'tabfiles' })
  const title = stripShellPathQuotes(
    block.filename ?? basename(relativePath) ?? block.summary ?? '',
  )
  if (title) params.set('title', title)
  if (block.auto_open) params.set('auto_open', '1')
  if (block.auto_open_token) params.set('auto_open_token', block.auto_open_token)
  return `tabtin://resource/file/${encodeURIComponent(relativePath)}?${params.toString()}`
}

function ossFileResourceUrl(block: {
  artifact_kind?: string
  file_id?: string
  filename?: string
  summary?: string
  url?: string
  auto_open?: boolean
  auto_open_token?: string
}): string | null {
  if (block.artifact_kind !== 'oss_file') return null
  const fileId = typeof block.file_id === 'string' ? block.file_id.trim() : ''
  if (!fileId) {
    if (typeof block.url === 'string' && block.url.startsWith('tabtin://resource/file/')) {
      return block.url
    }
    return null
  }
  const params = new URLSearchParams({ hint: 'tabfiles' })
  const title = stripShellPathQuotes(block.filename ?? block.summary ?? '')
  if (title) params.set('title', title)
  if (block.auto_open) params.set('auto_open', '1')
  if (block.auto_open_token) params.set('auto_open_token', block.auto_open_token)
  return `tabtin://resource/file/${encodeURIComponent(fileId)}?${params.toString()}`
}

function basename(path?: string): string | null {
  if (!path) return null
  const cleaned = stripShellPathQuotes(path)
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? null
}

function extensionOf(filename?: string): string | null {
  if (!filename) return null
  const match = /\.([^.]+)$/.exec(filename)
  return match?.[1] ?? null
}
