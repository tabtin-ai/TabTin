import { parseResourcePointer } from '@tabtin/resource-router'
import { collectSessionArtifacts } from '@/components/chat/turn/turnArtifacts'
import { useCloudDocumentPreviewStore } from '@/components/chat/preview/useCloudDocumentPreviewStore'
import { useProjectWorkspaceSelectionStore } from '@/components/layout/projectWorkspaceSelectionStore'
import { useChatStore } from '@/stores/chat/useChatStore'

interface OpenProjectTaskDocumentPreviewParams {
  resourceType: string
  resourceId: string
  tabScopeKey: string | null
  resourceSpaceId?: string
  title?: string
  /** 打开预览后默认展开版本历史 */
  openVersionHistory?: boolean
}

function isDocumentType(resourceType: string): boolean {
  return ['doc', 'document', 'tabdoc'].includes(resourceType.toLowerCase())
}

function findArtifactSpaceId(sessionId: string, resourceId: string): string | null {
  const messages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  const artifact = collectSessionArtifacts(messages).find((candidate) => {
    if (candidate.kind !== 'doc' || !candidate.resourceSpaceId) return false
    try {
      return parseResourcePointer(candidate.href).id === resourceId
    } catch {
      return false
    }
  })
  return artifact?.resourceSpaceId ?? null
}

/**
 * Project Task 的执行会话没有可见的工作台画布。云文档在验收前仍归属责任人
 * 工作空间，因此在 Project 顶层弹窗内打开，避免选择隐藏的伴生工作空间。
 */
export function openProjectTaskDocumentPreview(
  params: OpenProjectTaskDocumentPreviewParams,
): boolean {
  if (!isDocumentType(params.resourceType) || !params.resourceId) return false

  const selection = useProjectWorkspaceSelectionStore.getState()
  const sessionId = params.tabScopeKey?.startsWith('conversation:')
    ? params.tabScopeKey.slice('conversation:'.length)
    : ''
  if (
    !selection.selectedProjectId
    || !selection.activeTaskSessionId
    || sessionId !== selection.activeTaskSessionId
  ) {
    return false
  }

  const resourceSpaceId = params.resourceSpaceId
    || findArtifactSpaceId(sessionId, params.resourceId)
  if (!resourceSpaceId) return false

  useCloudDocumentPreviewStore.getState().open({
    documentId: params.resourceId,
    resourceSpaceId,
    ...(params.title ? { title: params.title } : {}),
    ...(params.openVersionHistory ? { openVersionHistory: true } : {}),
  })
  return true
}
