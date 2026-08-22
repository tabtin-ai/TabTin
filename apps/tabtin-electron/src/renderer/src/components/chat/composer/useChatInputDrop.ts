import { useCallback, useEffect, type DragEvent } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import {
  COLLECTION_FOLDER_MIME,
  COLLECTION_ITEM_MIME,
} from '@/components/context-space/hooks/collectionMime'
import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import { basename } from '../utils'
import type { ChatAttachment, ContextRef } from '../types'
import { FILE_LIMITS } from '../types'
import { classifyCloudDriveChatDrop } from './chatCloudDriveDrop'
import { buildContextRefExtraFromPayload, readChatContextDragPayload } from './chatContextDrag'
import {
  isChatFileRefDropAcceptable,
  resolveChatFileRefDrop,
} from './chatFileRefDrop'

export interface UseChatInputDropInput {
  setIsDragOver: React.Dispatch<React.SetStateAction<boolean>>
  addFiles: (files: FileList | File[]) => void
  onAddContextRef?: (
    type: ContextRef['type'],
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => void
  resolvedPresetScopeId: string | null
  dropApiRef?: React.MutableRefObject<{
    ingestFiles: (files: File[]) => void
    ingestAttachments?: (attachments: ChatAttachment[]) => void
  } | null>
}

async function classifyDroppedFile(
  file: File,
  onAddContextRef: UseChatInputDropInput['onAddContextRef'],
): Promise<'directory' | 'regular'> {
  const filePath =
    window.electron?.webUtils?.getPathForFile?.(file) ??
    (file as File & { path?: string }).path ??
    null
  if (!filePath) return 'regular'

  let isDirectory = false
  try {
    const probe = await window.tabtin?.fileSystem?.readFilePreview?.(filePath, { maxBytes: 0 })
    if (probe && probe.success === false && (probe as { code?: string }).code === 'EISDIR') {
      isDirectory = true
    } else if (!probe || probe.success === false) {
      if (file.size === 0 && file.type === '') isDirectory = true
    }
  } catch {
    if (file.size === 0 && file.type === '') isDirectory = true
  }

  if (isDirectory) {
    if (onAddContextRef) {
      onAddContextRef('folder', filePath, basename(filePath) || filePath, {
        meta: { kind: 'dropped', source: 'chat-drop' },
      })
    } else {
      console.warn('[ChatInput] dropped folder %s but onAddContextRef unavailable (no active session)', filePath)
    }
    return 'directory'
  }
  return 'regular'
}

function createIngestDroppedFiles(
  addFiles: (files: FileList | File[]) => void,
  onAddContextRef: UseChatInputDropInput['onAddContextRef'],
  t: ReturnType<typeof useTranslation>['t'],
) {
  return (items: File[]) => {
    if (items.length === 0) return
    void (async () => {
      const regularFiles: File[] = []
      let droppedDirIgnoredCount = 0
      for (const file of items) {
        const kind = await classifyDroppedFile(file, onAddContextRef)
        if (kind === 'directory') {
          if (!onAddContextRef) droppedDirIgnoredCount++
          continue
        }
        regularFiles.push(file)
      }

      if (regularFiles.length > 0) addFiles(regularFiles)

      if (droppedDirIgnoredCount > 0) {
        toast.warning(t('input.folderDropUnsupported', {
          count: droppedDirIgnoredCount,
          defaultValue: '{{count}} 个文件夹路径已忽略：当前对话尚未就绪',
        }))
      }
    })()
  }
}

export function useChatInputDropHandlers(input: UseChatInputDropInput & {
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>
}) {
  const { t } = useTranslation('chat')

  const ingestAttachments = useCallback((items: ChatAttachment[]) => {
    if (items.length === 0) return
    input.setAttachments(prev => {
      const remaining = FILE_LIMITS.MAX_ATTACHMENTS - prev.length
      if (remaining <= 0) return prev
      return [...prev, ...items.slice(0, remaining)]
    })
  }, [input])

  const ingestDroppedFiles = useCallback(
    createIngestDroppedFiles(input.addFiles, input.onAddContextRef, t),
    [input.addFiles, input.onAddContextRef, t],
  )

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const types = Array.from(event.dataTransfer?.types ?? [])
    // 云盘文件夹 / 无上下文的云盘项：允许 drop 以便 toast 说明预期，不高亮为可接收
    const cloudDriveRejectable =
      types.includes(COLLECTION_FOLDER_MIME) || types.includes(COLLECTION_ITEM_MIME)
    const acceptable =
      types.includes(DRAG_TYPE_CHAT_CONTEXT)
      || types.includes('Files')
      || isChatFileRefDropAcceptable(event.dataTransfer)
      || cloudDriveRejectable
    if (!acceptable) {
      input.setIsDragOver(false)
      return
    }
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = cloudDriveRejectable && !types.includes(DRAG_TYPE_CHAT_CONTEXT)
        ? 'none'
        : 'copy'
    }
    input.setIsDragOver(!(cloudDriveRejectable && !types.includes(DRAG_TYPE_CHAT_CONTEXT)))
  }, [input])

  const handleDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    input.setIsDragOver(false)
  }, [input])

  const handleDrop = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    input.setIsDragOver(false)

    const types = Array.from(event.dataTransfer?.types ?? [])
    const hasContextPayload = types.includes(DRAG_TYPE_CHAT_CONTEXT)
    const contextPayload = event.dataTransfer
      ? readChatContextDragPayload(event.dataTransfer)
      : null
    if (contextPayload) {
      if (input.onAddContextRef && input.resolvedPresetScopeId) {
        input.onAddContextRef(
          contextPayload.type,
          contextPayload.resourceId,
          contextPayload.label,
          buildContextRefExtraFromPayload(contextPayload),
        )
      } else {
        toast.warning(t('input.contextDropUnsupported', {
          defaultValue: '当前对话尚未就绪，无法添加上下文',
        }))
      }
      return
    }

    const cloudDriveKind = classifyCloudDriveChatDrop(types, Boolean(contextPayload))
    if (cloudDriveKind === 'cloud_folder') {
      toast.warning(t('input.cloudFolderDropUnsupported', {
        defaultValue: '云盘文件夹不能添加到对话，请拖入文件夹内的表格、文档或文件',
      }))
      return
    }
    if (cloudDriveKind === 'cloud_item_without_context') {
      toast.warning(t('input.cloudResourceDropUnsupported', {
        defaultValue: '该云盘资源暂无法添加到对话',
      }))
      return
    }

    if (hasContextPayload) {
      toast.warning(t('input.contextDropInvalid', {
        defaultValue: '上下文拖拽数据无效，未能添加到对话',
      }))
      return
    }

    const dt = event.dataTransfer
    if (dt && isChatFileRefDropAcceptable(dt)) {
      const filesSnapshot = Array.from(dt.files ?? [])
      void (async () => {
        const result = await resolveChatFileRefDrop(dt, filesSnapshot)
        if (result.kind === 'files') {
          ingestDroppedFiles(result.files)
          return
        }
        if (result.kind === 'attachments') {
          ingestAttachments(result.attachments)
          return
        }
        if (result.kind === 'missing_url') {
          toast.warning(t('input.fileRefDropMissingUrl', {
            name: result.name,
            defaultValue: '「{{name}}」缺少可访问地址，无法添加到对话',
          }))
          return
        }
        if (result.kind === 'error') {
          toast.warning(t('input.fileRefDropFailed', {
            name: result.name,
            defaultValue: '「{{name}}」添加到对话失败，请重试或另存后再拖入',
          }))
        }
      })()
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped || dropped.length === 0) return
    ingestDroppedFiles(Array.from(dropped))
  }, [ingestAttachments, ingestDroppedFiles, input, t])

  useEffect(() => {
    if (!input.dropApiRef) return
    input.dropApiRef.current = {
      ingestFiles: ingestDroppedFiles,
      ingestAttachments,
    }
    return () => {
      if (input.dropApiRef?.current?.ingestFiles === ingestDroppedFiles) {
        input.dropApiRef.current = null
      }
    }
  }, [ingestAttachments, ingestDroppedFiles, input.dropApiRef])

  return {
    handleDragOver,
    handleDragLeave,
    handleDrop,
    ingestDroppedFiles,
    ingestAttachments,
  }
}
