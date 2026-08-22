/**
 * useArtifactOpenActions — create_file 卡（RichFile）与「本轮产物」卡
 * （TurnArtifactsCard）共享的本地产物「打开」行为。
 *
 * 统一四类动作 + 遥控端拦截 + toast 文案，消除两张卡各写一套、UX 不一致、
 * dmg 等白名单外类型「死胡同」的历史分叉（原  只共享了判定谓词，未收敛
 * 打开语义与 UX）。
 *
 *   - openPrimary：点卡片 / 「预览」的主动作。HTML → 内嵌浏览器；白名单外
 *     本地类型 → 系统应用降级；其余 → Space 预览，失败再降级系统应用。
 *   - canPrimaryPreview：本地 HTML 时 UI 露出「预览」（与点卡片同语义，）。
 *   - openWithSystemApp / revealInFinder / openWorkspace：「Open in」下拉其余项。
 */

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { parseResourcePointer } from '@tabtin/resource-router'
import { toast } from '@tabtin/smartsheet-ui'
import {
  expandCanvasForScope,
  openResourceUrlInSpace,
  resolveSpaceIdForResourceLink,
} from '@/services/openResourceLink'
import { openSharedResourceTab } from '@/services/openSharedResource'
import { openProjectTaskDocumentPreview } from '@/services/openProjectTaskDocumentPreview'
import { useCloudDocumentPreviewStore } from '@/components/chat/preview/useCloudDocumentPreviewStore'
import { useProjectWorkspaceSelectionStore } from '@/components/layout/projectWorkspaceSelectionStore'
import { useImConversationCanvas } from '@/components/tabchat/ImConversationCanvasContext'
import { resolveSharedSessionHostSpace, mapSharedCloudResourceType } from '@/components/chat/shared-view/openSharedSessionCloudResource'
import { openLocalHtmlInSpace } from '@/services/openLocalHtmlInSpace'
import { openLocalArtifactWithSystemApp } from '@/services/openLocalArtifactSystemApp'
import {
  openArtifactWorkspaceDir,
  revealArtifactInFinder,
} from '@/services/localArtifactActions'
import {
  isLocalFileArtifactHref,
  isLocalHtmlArtifactHref,
  isUnsupportedLocalArtifactHref,
} from '@/services/localFileResourceResolver'
import { useIsRemoteViewer } from '@components/context-space/hooks/useIsRemoteViewer'
import { useSharedSessionPreview } from '@/components/chat/shared-view/preview'
import { isSharedSessionFileTooLargeForPreview } from '@shared/session-share-preview-contract'
import { createLogger } from '@/utils/logger'
import type { OpenIntentHints } from '@shared/open-intent'

const log = createLogger('chat:artifactOpen')

export interface UseArtifactOpenActionsArgs {
  href: string
  tabScopeKey?: string | null
  /** 聊天宿主已解析出的执行 Space，避免共享 IM 会话回读全局选中态。 */
  executionSpaceId?: string | null
  /** oss_file 产物：无 working_dir 相对路径，「工作空间」项走 Space 打开而非目录定位。 */
  isOssFile?: boolean
  /** 云资源验收前的真实归属；与 Project 会话的承载 scope 分离。 */
  resourceSpaceId?: string
  openIntentHints?: OpenIntentHints
  /** local_file 已知体积（字节）；共享会话预览用于超限禁用入口。 */
  fileSize?: number | null
}

export interface ArtifactOpenActions {
  /** 遥控端 + 本地文件产物：所有本地打开动作不可用，UI 显示禁用占位。 */
  isRemoteLocalFile: boolean
  /**
   * 共享会话内的远端 local_file：仅允许受权限保护的会话内预览，
   * 禁止工作区 / 系统应用 / Reveal（ UI 收口）。
   */
  isSharedSessionLocalFile: boolean
  /**
   * 共享会话远端预览且已知体积超过物化硬顶：禁用「预览」入口。
   */
  isSharedPreviewTooLarge: boolean
  /** 超限禁用时的 hover / title 文案。 */
  sharedPreviewDisabledHint: string | null
  remoteUnavailableHint: string | null
  showRemoteUnavailable: () => void
  /**
   * 是否应露出显式「预览」入口（本地 HTML，或共享会话远端 local_file）。
   * 与 openPrimary 同语义；其它可预览类型仍靠点卡片，避免文件卡动作区过挤。
   */
  canPrimaryPreview: boolean
  /** 主动作（点卡片 / 「预览」）：返回是否成功打开（供调用方收起弹层等）。 */
  openPrimary: () => Promise<boolean>
  /**
   * 次级「版本历史」：云文档走 Project 顶层预览弹窗并默认展开 VH；
   * 非文档类降级提示，不阻塞文档入口。
   */
  openVersionHistory: () => Promise<boolean>
  openWithSystemApp: () => Promise<void>
  revealInFinder: () => Promise<void>
  openWorkspace: () => void
}

function tryOpenSharedCloudArtifact({
  href,
  hostSpaceId,
  resourceSpaceId,
  tabScopeKey,
  forceSharedOpen,
}: {
  href: string
  hostSpaceId: string | null | undefined
  resourceSpaceId: string | undefined
  tabScopeKey: string | null | undefined
  forceSharedOpen: boolean
}): boolean {
  if (!hostSpaceId) return false
  if (!forceSharedOpen && (!resourceSpaceId || resourceSpaceId === hostSpaceId)) return false

  const pointer = parseResourcePointer(href)
  const resourceType = mapSharedCloudResourceType(pointer.type)
  if (!pointer.id || !resourceType) return false

  openSharedResourceTab({
    hostSpaceId,
    resourceType,
    resourceId: pointer.id,
    resourceSpaceId,
    ...(tabScopeKey ? { tabScopeKey } : {}),
  })
  expandCanvasForScope(tabScopeKey)
  return true
}

function isSharedCloudArtifactHref(href: string): boolean {
  try {
    const pointer = parseResourcePointer(href)
    return Boolean(pointer.id && mapSharedCloudResourceType(pointer.type))
  } catch {
    return false
  }
}

export function useArtifactOpenActions({
  href,
  tabScopeKey = null,
  executionSpaceId = null,
  isOssFile = false,
  resourceSpaceId,
  openIntentHints,
  fileSize = null,
}: UseArtifactOpenActionsArgs): ArtifactOpenActions {
  const { t } = useTranslation('chat')
  const imConversationCanvas = useImConversationCanvas()
  const sharedSessionPreview = useSharedSessionPreview()
  const isSharedCloudArtifact = Boolean(
    sharedSessionPreview && isSharedCloudArtifactHref(href),
  )
  const spaceId = resolveSpaceIdForResourceLink(tabScopeKey, executionSpaceId)
  const { isRemoteViewer, controlDeviceName } = useIsRemoteViewer(spaceId)
  // 共享会话本地文件走按需预览 API，不再当成「遥控端不可打开」。
  const isSharedSessionLocalFile = useMemo(
    () => Boolean(sharedSessionPreview && isLocalFileArtifactHref(href)),
    [sharedSessionPreview, href],
  )
  const isRemoteLocalFile = useMemo(
    () => !sharedSessionPreview && isRemoteViewer && isLocalFileArtifactHref(href),
    [sharedSessionPreview, isRemoteViewer, href],
  )
  const isSharedPreviewTooLarge = useMemo(
    () => isSharedSessionLocalFile && isSharedSessionFileTooLargeForPreview(fileSize),
    [isSharedSessionLocalFile, fileSize],
  )
  const sharedPreviewDisabledHint = useMemo(() => {
    if (!isSharedPreviewTooLarge) return null
    return t('card.openFile.sharedPreviewTooLarge', {
      defaultValue: '文件过大，无法预览',
    })
  }, [isSharedPreviewTooLarge, t])

  const tryOpenSharedSessionLocalFile = useCallback((): boolean => {
    if (!sharedSessionPreview || !isLocalFileArtifactHref(href)) return false
    if (isSharedSessionFileTooLargeForPreview(fileSize)) return false
    const pointer = parseResourcePointer(href)
    if (pointer.type !== 'file' || !pointer.id) return false
    const title = typeof pointer.meta?.title === 'string' ? pointer.meta.title : undefined
    sharedSessionPreview.openSharedLocalFilePreview({
      relativePath: pointer.id,
      title,
    })
    return true
  }, [sharedSessionPreview, href, fileSize])

  const showSharedSessionPreviewOnly = useCallback(() => {
    toast({
      title: t('card.openFile.sharedPreviewOnlyTitle', { defaultValue: '仅支持会话内预览' }),
      description: t('card.openFile.sharedPreviewOnlyDesc', {
        defaultValue: '共享会话中的远端文件只能在当前会话中预览，不能在本机工作区或系统应用中打开。',
      }),
    })
  }, [t])

  // ：本地 HTML 点卡片即预览，须有显式「预览」与云文档卡对齐；
  // 共享会话远端 local_file 一律露出「预览」（无 Open in 下拉）。
  const canPrimaryPreview = useMemo(
    () => isSharedSessionLocalFile || (!isRemoteLocalFile && isLocalHtmlArtifactHref(href)),
    [isSharedSessionLocalFile, isRemoteLocalFile, href],
  )

  const remoteUnavailableHint = useMemo(() => {
    if (!isRemoteLocalFile) return null
    return controlDeviceName
      ? t('card.openFile.remoteUnavailableWithDevice', {
          device: controlDeviceName,
          defaultValue: '这个文件属于「{{device}}」上的工作空间。当前设备只能查看消息，不能直接打开或定位该文件。',
        })
      : t('card.openFile.remoteUnavailableNoDevice', {
          defaultValue: '这个文件属于工作空间的执行设备。当前设备只能查看消息，不能直接打开或定位该文件。',
        })
  }, [isRemoteLocalFile, controlDeviceName, t])

  const showRemoteUnavailable = useCallback(() => {
    toast({
      title: t('card.openFile.remoteUnavailableTitle', { defaultValue: '文件在远程设备上' }),
      description: remoteUnavailableHint ?? undefined,
    })
  }, [remoteUnavailableHint, t])

  const openWithSystemApp = useCallback(async () => {
    if (isSharedSessionLocalFile) {
      // 超限时入口已禁用，不再 toast「仅支持会话内预览」以免误导。
      if (isSharedPreviewTooLarge) return
      if (!tryOpenSharedSessionLocalFile()) showSharedSessionPreviewOnly()
      return
    }
    if (isRemoteLocalFile) {
      showRemoteUnavailable()
      return
    }
    const result = executionSpaceId
      ? await openLocalArtifactWithSystemApp(href, tabScopeKey, executionSpaceId)
      : await openLocalArtifactWithSystemApp(href, tabScopeKey)
    if (result.ok) {
      toast({
        title: t('turnArtifacts.openedWithSystemApp', { defaultValue: '已用系统应用打开' }),
        description: t('turnArtifacts.spacePreviewUnsupported', {
          defaultValue: '当前环境暂不支持在 Space 内预览此类型，已改用系统默认应用。',
        }),
      })
      return
    }
    toast({
      title: t('card.openFile.openFailed', { defaultValue: '用系统默认应用打开失败' }),
      description: result.error,
      variant: 'destructive',
    })
  }, [
    href,
    tabScopeKey,
    executionSpaceId,
    isSharedSessionLocalFile,
    isSharedPreviewTooLarge,
    tryOpenSharedSessionLocalFile,
    showSharedSessionPreviewOnly,
    isRemoteLocalFile,
    showRemoteUnavailable,
    t,
  ])

  const revealInFinder = useCallback(async () => {
    if (isSharedSessionLocalFile) {
      if (isSharedPreviewTooLarge) return
      if (!tryOpenSharedSessionLocalFile()) showSharedSessionPreviewOnly()
      return
    }
    if (isRemoteLocalFile) {
      showRemoteUnavailable()
      return
    }
    const result = executionSpaceId
      ? await revealArtifactInFinder(href, tabScopeKey, executionSpaceId)
      : await revealArtifactInFinder(href, tabScopeKey)
    if (!result.ok) {
      toast({
        title: t('card.openFile.revealFailed', { defaultValue: '在文件管理器中显示失败' }),
        description: result.error,
        variant: 'destructive',
      })
    }
  }, [
    href,
    tabScopeKey,
    executionSpaceId,
    isSharedSessionLocalFile,
    isSharedPreviewTooLarge,
    tryOpenSharedSessionLocalFile,
    showSharedSessionPreviewOnly,
    isRemoteLocalFile,
    showRemoteUnavailable,
    t,
  ])

  const openWorkspace = useCallback(() => {
    if (isSharedSessionLocalFile) {
      if (isSharedPreviewTooLarge) return
      if (!tryOpenSharedSessionLocalFile()) showSharedSessionPreviewOnly()
      return
    }
    if (isRemoteLocalFile) {
      showRemoteUnavailable()
      return
    }
    if (isOssFile) {
      void openResourceUrlInSpace(href, tabScopeKey, {
        ...(openIntentHints ? { openIntentHints } : {}),
        ...(executionSpaceId ? { executionSpaceId } : {}),
      })
      return
    }
    if (executionSpaceId) {
      openArtifactWorkspaceDir(href, tabScopeKey, executionSpaceId)
    } else {
      openArtifactWorkspaceDir(href, tabScopeKey)
    }
  }, [
    href,
    tabScopeKey,
    executionSpaceId,
    isOssFile,
    isSharedSessionLocalFile,
    isSharedPreviewTooLarge,
    tryOpenSharedSessionLocalFile,
    showSharedSessionPreviewOnly,
    isRemoteLocalFile,
    showRemoteUnavailable,
    openIntentHints,
  ])

  const resolveProjectTaskDocPreview = useCallback((options?: {
    openVersionHistory?: boolean
  }): boolean => {
    // Project Task 会话挂在 Project（host），候选资源仍属伴生工作空间。
    // 统一走 openProjectTaskDocumentPreview，可从产物补齐 resourceSpaceId。
    let pointer: ReturnType<typeof parseResourcePointer> | null = null
    try {
      pointer = parseResourcePointer(href)
    } catch {
      pointer = null
    }
    if (!pointer?.id || !pointer.type) return false
    return openProjectTaskDocumentPreview({
      resourceType: pointer.type,
      resourceId: pointer.id,
      tabScopeKey,
      ...(resourceSpaceId ? { resourceSpaceId } : {}),
      ...(options?.openVersionHistory ? { openVersionHistory: true } : {}),
    })
  }, [href, tabScopeKey, resourceSpaceId])

  const openVersionHistory = useCallback(async (): Promise<boolean> => {
    if (isRemoteLocalFile) {
      showRemoteUnavailable()
      return false
    }

    let pointer: ReturnType<typeof parseResourcePointer> | null = null
    try {
      pointer = parseResourcePointer(href)
    } catch {
      pointer = null
    }
    const isDoc = pointer?.type === 'document' || pointer?.type === 'doc'
    if (!isDoc) {
      toast({
        title: t('turnArtifacts.versionHistoryUnsupported', {
          defaultValue: '该产物暂不支持版本历史',
        }),
      })
      return false
    }

    if (resolveProjectTaskDocPreview({ openVersionHistory: true })) {
      return true
    }

    // 非 Project Task 现场：仍尽量走顶层文档预览壳，保证 VH 入口可见
    if (pointer?.id && resourceSpaceId) {
      useCloudDocumentPreviewStore.getState().open({
        documentId: pointer.id,
        resourceSpaceId,
        openVersionHistory: true,
      })
      return true
    }

    toast({
      title: t('turnArtifacts.versionHistoryUnsupported', {
        defaultValue: '该产物暂不支持版本历史',
      }),
    })
    return false
  }, [
    href,
    resourceSpaceId,
    isRemoteLocalFile,
    showRemoteUnavailable,
    resolveProjectTaskDocPreview,
    t,
  ])

  const openPrimary = useCallback(async (): Promise<boolean> => {
    // 共享会话远端文件不得回落到本机 Space / 系统应用打开。
    if (isSharedSessionLocalFile) {
      return tryOpenSharedSessionLocalFile()
    }
    if (isRemoteLocalFile) {
      showRemoteUnavailable()
      return false
    }

    if (resolveProjectTaskDocPreview()) {
      return true
    }

    // 跨归属云资源（非 Project Task 文档预览）：仍走共享 tab，避免丢上下文
    const projectSelection = useProjectWorkspaceSelectionStore.getState()
    const isActiveProjectTaskSession = Boolean(
      projectSelection.selectedProjectId
      && projectSelection.activeTaskSessionId
      && tabScopeKey === `conversation:${projectSelection.activeTaskSessionId}`,
    )
    const sharedHost = isSharedCloudArtifact && sharedSessionPreview?.organizationId
      ? resolveSharedSessionHostSpace({
          organizationId: sharedSessionPreview.organizationId,
          imCanvas: imConversationCanvas,
        })
      : null
    if (isSharedCloudArtifact && !sharedHost) return false
    const hostSpaceId = sharedHost?.hostSpaceId
      ?? imConversationCanvas?.executionSpaceId
      ?? (isActiveProjectTaskSession ? projectSelection.selectedProjectId : spaceId)
    const sharedTabScopeKey = imConversationCanvas?.scopeKey ?? tabScopeKey
    // 共享会话（SharedSessionPreview）内云表/云文档一律 foreignShared 打开，
    // 不依赖 IM 画布是否注入；避免回落 resourceRouter 进空桶。
    if (tryOpenSharedCloudArtifact({
      href,
      hostSpaceId,
      resourceSpaceId,
      tabScopeKey: sharedTabScopeKey,
      forceSharedOpen: Boolean(imConversationCanvas) || Boolean(sharedSessionPreview),
    })) return true

    // ：本地 HTML → 内嵌浏览器渲染（对标内嵌浏览器本地 HTML 预览）。
    // ：路径已不可用时短路单次 toast，禁止再级联 TabFiles/系统打开叠错。
    if (isLocalHtmlArtifactHref(href)) {
      let pointer: ReturnType<typeof parseResourcePointer> | null = null
      try {
        pointer = parseResourcePointer(href)
      } catch {
        pointer = null
      }
      if (pointer) {
        const htmlOpen = await openLocalHtmlInSpace(spaceId, pointer, { tabScopeKey })
        if (htmlOpen.ok) {
          expandCanvasForScope(tabScopeKey)
          return true
        }
        if (htmlOpen.reason === 'missing' || htmlOpen.reason === 'unavailable') {
          log.warn('local html preview aborted — path unavailable', {
            href,
            spaceId,
            reason: htmlOpen.reason,
            errorMessage: htmlOpen.message,
          })
          toast({
            title: t('turnArtifacts.previewFailed', { defaultValue: '无法预览' }),
            description: htmlOpen.message
              || t('turnArtifacts.fileMissing', { defaultValue: '文件已删除或不可用' }),
            variant: 'destructive',
          })
          return false
        }
        log.warn('local html preview fell back to default route', {
          href,
          spaceId,
          errorMessage: htmlOpen.message,
        })
      }
    }

    // ：白名单外本地类型（dmg / zip 等）直接系统应用打开，不再「死胡同」。
    if (isUnsupportedLocalArtifactHref(href)) {
      await openWithSystemApp()
      return true
    }

    // 其余：Space 预览（suppressErrorToast 避免双层报错），失败再降级系统应用。
    const outcome = await openResourceUrlInSpace(href, tabScopeKey, {
      suppressErrorToast: true,
      ...(openIntentHints ? { openIntentHints } : {}),
      ...(executionSpaceId ? { executionSpaceId } : {}),
    })
    if (outcome?.outcome !== 'error') return true

    log.warn('artifact preview failed', { href, spaceId, errorMessage: outcome.errorMessage })
    if (isLocalFileArtifactHref(href)) {
      const systemOpen = executionSpaceId
        ? await openLocalArtifactWithSystemApp(href, tabScopeKey, executionSpaceId)
        : await openLocalArtifactWithSystemApp(href, tabScopeKey)
      if (systemOpen.ok) {
        toast({
          title: t('turnArtifacts.openedWithSystemApp', { defaultValue: '已用系统应用打开' }),
          description: t('turnArtifacts.spacePreviewUnsupported', {
            defaultValue: '当前环境暂不支持在 Space 内预览此类型，已改用系统默认应用。',
          }),
        })
        return true
      }
      toast({
        title: t('turnArtifacts.previewFailed', { defaultValue: '无法预览' }),
        description: systemOpen.error || outcome.errorMessage,
        variant: 'destructive',
      })
      return false
    }

    toast({
      title: t('turnArtifacts.previewFailed', { defaultValue: '无法预览' }),
      description: outcome.errorMessage,
      variant: 'destructive',
    })
    return false
  }, [
    href,
    tabScopeKey,
    executionSpaceId,
    spaceId,
    resourceSpaceId,
    imConversationCanvas,
    sharedSessionPreview,
    isSharedCloudArtifact,
    isSharedSessionLocalFile,
    tryOpenSharedSessionLocalFile,
    isRemoteLocalFile,
    showRemoteUnavailable,
    resolveProjectTaskDocPreview,
    openWithSystemApp,
    openIntentHints,
    t,
  ])

  return {
    isRemoteLocalFile,
    isSharedSessionLocalFile,
    isSharedPreviewTooLarge,
    sharedPreviewDisabledHint,
    remoteUnavailableHint,
    showRemoteUnavailable,
    canPrimaryPreview,
    openPrimary,
    openVersionHistory,
    openWithSystemApp,
    revealInFinder,
    openWorkspace,
  }
}
