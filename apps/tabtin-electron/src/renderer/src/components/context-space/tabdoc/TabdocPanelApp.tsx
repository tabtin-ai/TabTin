/**
 * Tabdoc Panel App — 单文档编辑器标签
 *
 * 每个文档打开一个独立标签，只包含编辑器（无侧边栏、无版本面板）。
 * 通过 documentId prop 驱动，并上报运行态给资源面板。
 */
import { joinApiPath } from '@tabtin/config'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { initializeTabDocHostRuntime } from '@tabtin/tabdoc-host-runtime'
import { requireTableApiPort } from '@tabtin/table-core'
import { AppHostClientProvider, useAppHostClient } from '@tabtin/app-host-sdk'
import {
  TabDocEditorConfigProvider,
  TabDocHostActionsProvider,
  useTabDocHostActions,
  TabDocTableEmbedRuntimeProvider,
  TabDocSurfaceProvider,
} from '@tabtin/tabdoc-ui'
import { toast } from '@tabtin/smartsheet-ui'
import { useCollaborativeDocEditor } from '@tabtin/tabdoc-ui/use-collaborative-doc-editor'
import { getDocument, updateDocument } from '@tabtin/tabdoc-ui/api-client'
import { createTabDocMetadataSaveQueue } from './tabdocMetadataSaveQueue'
import {
  createDocumentHtmlArtifactLoader,
  createDocumentImageAssetLoader,
  getIconOptimisticPatch,
  HtmlArtifactLoaderProvider,
  HtmlBlockAccessProvider,
  ImageAssetLoaderProvider,
  ImageAssetPreviewProvider,
} from '@tabtin/tabdoc-ui/editor'
import { DocEditorView } from './components/DocEditorView'
import { useVersionPanel } from '@/components/collab/useVersionPanel'
import { useVersionHistory, fetchVersionPreview, type VersionHistoryItem } from '@tabtin/collab-core'
import { useAuthStore } from '@/stores/useAuthStore'
import { API_BASE_URL, API_CONFIG, COLLAB_WS_URLS } from '@/config/api'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { openResourceTabGuarded } from '../restore/openResourceMembershipGuard'
import { useMainNavStore } from '@/stores/useMainNavStore'
import type { WorkbenchMode } from '@components/layout/useShellLayoutState'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { sanitizeSchema, rehypeSanitizeCss } from '@/lib/rehypeSanitizeSchema'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import { diffLines } from 'diff'
import {
  createElectronTabDocHostActions,
  createElectronTabDocTableEmbedRuntime,
} from './adapters/electronTabDocHostAdapters'
import {
  configureElectronTabDataBlockEmbed,
  electronAuthPort,
  electronImageUploadPort,
  electronHtmlUploadPort,
} from './adapters/electronTabDocEditorConfig'
import { electronTabDocEventStreamPort } from './adapters/electronTabDocEventStreamPort'
import { DRAG_TYPE_CHAT_CONTEXT, DRAG_TYPE_FILE_REF, DRAG_TYPE_TAB_META } from '@/utils/split-coordinator'
import i18n from '@/i18n'

configureElectronTabDataBlockEmbed()
import {
  buildTabDocRuntimeMetrics,
  createTabDocRuntimeMonitorInstanceId,
  publishTabDocRuntimeMetrics,
  registerTabDocRuntimeHost,
  unregisterTabDocRuntimeHost,
  updateTabDocRuntimeHost,
} from './tabdoc-runtime-monitor'
import { registerTabDocDirtySource, notifyTabDocDirty } from './tabdocDirtyRegistry'
import { bootstrapTabDocProbe } from './probeBootstrap'
import { resolveVersionPreviewMode } from './resolveVersionPreviewMode'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'
import { onResourceEvent } from '@/stores/useUnifiedResources'
import {
  buildTabDocDocumentPatchFromResourceEvent,
  TABDOC_RESOURCE_TYPE,
} from './tabdocResourceEventPatch'
import {
  DUPLICATE_NAME_ERROR_TITLE,
  isDuplicateNameErrorMessage,
} from '@/lib/duplicateNameError'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { reloadTabDocAfterForceClose } from './tabdocForceCloseOverlay'

/** Tabdoc panel props */
interface TabdocPaneProps {
  appId: string
  spaceId?: string | null
  documentId: string
  isPaneActive?: boolean
  isVisible?: boolean
  /** 只读模式（禁用版本还原等写操作） */
  isReadonly?: boolean
  /**
   * 显式 organizationId 覆盖。用于「分享给我」独立打开场景：协作者当前可能选中了
   * 别的 Space，selectedSpace.organization_id 不等于被分享资源的 organization，必须按
   * 资源自身的 organization 挂载，否则编辑器运行时上下文错配。普通工作台内挂载
   * 不传，沿用 useResolvedOrganizationId 的默认优先级。
   */
  organizationIdOverride?: string | null
  /** 新建文档后自动聚焦标题输入框（由 tab meta.focusTitle 传入，一次性消费） */
  focusTitle?: boolean
  /**
   * Project 任务产物预览等宿主：挂载后默认展开版本历史侧栏。
   * 仅影响入口可见性/初始态，不改 VH 底层。
   */
  initialShowVersionHistory?: boolean
}

/**
 * 从宿主获取 organizationId
 * 优先级: override > selectedSpace.organization_id > selectedOrganization.id > null
 */
const useOrganizationId = (override?: string | null): string | null => {
  return useResolvedOrganizationId(override || undefined)
}

function formatBlobSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface DocPreviewData {
  markdown?: string
  plaintext_preview?: string
  preview_unavailable?: boolean
  previous_markdown?: string
  reason?: string
}

function DocDiffView({ current, previous }: { current: string; previous: string }) {
  const parts = useMemo(() => diffLines(previous, current), [previous, current])

  return (
    <div className="font-mono text-caption leading-relaxed">
      {parts.map((part, i) => {
        if (part.added) {
          return (
            <div key={i} className="bg-emerald-500/15 border-l-2 border-emerald-500 pl-3 py-0.5">
              {part.value.split('\n').filter(Boolean).map((line, j) => (
                <div key={j}><span className="text-emerald-600 dark:text-emerald-400 select-none mr-2">+</span>{line}</div>
              ))}
            </div>
          )
        }
        if (part.removed) {
          return (
            <div key={i} className="bg-red-500/15 border-l-2 border-red-500 pl-3 py-0.5 opacity-60">
              {part.value.split('\n').filter(Boolean).map((line, j) => (
                <div key={j}><span className="text-red-500 dark:text-red-400 select-none mr-2">−</span><s>{line}</s></div>
              ))}
            </div>
          )
        }
        const lines = part.value.split('\n').filter(Boolean)
        if (lines.length <= 6) {
          return (
            <div key={i} className="pl-3 py-0.5 text-muted-foreground/80">
              {lines.map((line, j) => <div key={j}><span className="select-none mr-2 opacity-0">·</span>{line}</div>)}
            </div>
          )
        }
        return (
          <div key={i} className="pl-3 py-0.5 text-muted-foreground/80">
            {lines.slice(0, 2).map((line, j) => <div key={j}><span className="select-none mr-2 opacity-0">·</span>{line}</div>)}
            <div className="text-muted-foreground/40 text-center py-1">⋯ {lines.length - 4} 行未变更 ⋯</div>
            {lines.slice(-2).map((line, j) => <div key={`e${j}`}><span className="select-none mr-2 opacity-0">·</span>{line}</div>)}
          </div>
        )
      })}
    </div>
  )
}

function TabDocVersionPreview({ versionId, version }: { versionId: string; version?: VersionHistoryItem }) {
  const [preview, setPreview] = useState<DocPreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  // null = 跟随 editor_type 默认；true/false = 用户手动切换 diff / 全文视图
  const [showDiffOverride, setShowDiffOverride] = useState<boolean | null>(null)
  const token = useAuthStore((s) => s.accessToken)
  const { t } = useTranslation('collab')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPreview(null)
    setShowDiffOverride(null)

    fetchVersionPreview(joinApiPath(API_BASE_URL, `/collab/v1`), versionId, token || '')
      .then((data) => {
        if (!cancelled && data) setPreview(data as DocPreviewData)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [versionId, token])

  if (!version) {
    return <div className="text-body text-muted-foreground py-2">{t('version.loadingInfo', '加载版本信息...')}</div>
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
      </div>
    )
  }

  if (preview?.preview_unavailable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/60">
        <FileText className="h-8 w-8" />
        <span className="text-body">{t('version.previewUnavailable', '此版本暂不支持内容预览')}</span>
        {preview.reason ? (
          <span className="text-caption max-w-[480px] break-all text-center">{preview.reason}</span>
        ) : (
          <span className="text-caption">{t('version.previewUnavailableHint', '此版本为二进制格式，无法生成预览')}</span>
        )}
      </div>
    )
  }

  const currentMd = preview?.markdown || preview?.plaintext_preview || ''
  const previousMd = preview?.previous_markdown ?? ''
  // 技术上能否做 diff：有上一版且与当前不同（首版 agent 条目无 previous_markdown → 降级全文）
  const canDiff = previousMd !== '' && previousMd !== currentMd
  // 视图门控逻辑抽到 resolveVersionPreviewMode（纯函数，便于单测）
  const showDiff =
    resolveVersionPreviewMode({
      editorType: version.editor_type,
      canDiff,
      override: showDiffOverride,
    }) === 'diff'

  return (
    <ScrollArea className="h-full">
      <div className="px-6 py-4">
        {!currentMd && !previousMd ? (
          <div className="text-caption text-muted-foreground/60">{t('version.noContent', '此版本无文本内容')}</div>
        ) : (
          <>
            {canDiff ? (
              <div className="mb-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowDiffOverride(!showDiff)}
                  className="text-caption text-muted-foreground/80 hover:text-foreground rounded-md border border-border px-2 py-0.5 transition-colors"
                >
                  {showDiff
                    ? t('version.viewFullText', '查看全文')
                    : t('version.viewDiff', '查看 diff')}
                </button>
              </div>
            ) : null}
            {showDiff ? (
              <DocDiffView current={currentMd} previous={previousMd} />
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeSanitizeCss]}>
                  {currentMd}
                </ReactMarkdown>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

/**
 * 内层组件：消费 AppHostClientProvider context，驱动编辑器
 */
const DocEditorPane: React.FC<{
  documentId: string
  spaceId: string | null
  organizationId: string | null
  isPaneActive: boolean
  isVisible: boolean
  isReadonly: boolean
  focusTitle?: boolean
  initialShowVersionHistory?: boolean
}> = ({
  documentId,
  spaceId,
  organizationId,
  isPaneActive,
  isVisible,
  isReadonly,
  focusTitle = false,
  initialShowVersionHistory = false,
}) => {
  const { t } = useTranslation('tabdoc')
  // dev-only：启用数据流探针 + 注入文件 sink（生产为 no-op）
  useEffect(() => { bootstrapTabDocProbe() }, [])
  const docEditor = useCollaborativeDocEditor({
    documentId,
    t: (key, opts) => t(key, opts) as string,
  })
  const [accessRevoked, setAccessRevoked] = useState(false)
  const [revokedResourceTitle, setRevokedResourceTitle] = useState('')
  const client = useAppHostClient()
  const hostActions = useTabDocHostActions()
  const runtimeMonitorInstanceIdRef = useRef(createTabDocRuntimeMonitorInstanceId())
  const effectiveReadonly = isReadonly
    || accessRevoked
    || docEditor.currentDocument?.current_user_role === 'viewer'

  const versionPanel = useVersionPanel({
    resourceType: 'docs',
    resourceId: documentId,
    resourceName: docEditor.currentDocument?.title || undefined,
    isReadonly: effectiveReadonly,
    DiffPreview: TabDocVersionPreview,
    onRestoreComplete: (info) => {
      docEditor.retryLoad()
      // : resync 模式下服务端已通过 Yjs 增量广播还原内容，无需断线重连
      if (info?.syncMode !== 'resync') {
        docEditor.triggerForceReconnect()
      }
    },
  })

  // 预览壳次级入口：挂载后展开一次 VH，不改 useVersionPanel 底层 API
  const didAutoOpenVersionHistoryRef = useRef(false)
  const versionPanelShow = versionPanel.show
  const versionPanelToggle = versionPanel.toggle
  useEffect(() => {
    if (!initialShowVersionHistory || didAutoOpenVersionHistoryRef.current || versionPanelShow) {
      return
    }
    didAutoOpenVersionHistoryRef.current = true
    versionPanelToggle()
  }, [initialShowVersionHistory, versionPanelShow, versionPanelToggle])

  const token = useAuthStore((s) => s.accessToken)
  const { createNamedVersion: createVHNamedVersion } = useVersionHistory({
    resourceType: 'docs',
    resourceId: documentId,
    apiBase: joinApiPath(API_BASE_URL, `/collab/v1`),
    token: token || '',
    enabled: false,
    autoFetch: false,
  })

  // BIZ-004 fix: 分离 unmount cleanup 与 deps-change 逻辑，使 update 路径可达
  const runtimeRegisteredRef = useRef(false)

  useEffect(() => {
    return () => {
      if (runtimeRegisteredRef.current) {
        unregisterTabDocRuntimeHost(runtimeMonitorInstanceIdRef.current)
        runtimeRegisteredRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    const instanceId = runtimeMonitorInstanceIdRef.current

    if (!runtimeRegisteredRef.current) {
      if (docEditor.isLoadingDetail || !docEditor.currentDocument) return
      runtimeRegisteredRef.current = true
      registerTabDocRuntimeHost(instanceId, {
        documentId,
        title: docEditor.currentDocument.title ?? null,
        spaceId,
        organizationId,
        tabKey: documentId ? `tabdoc:${documentId}` : null,
        isPaneActive,
        isVisible,
        isLoading: false,
        hasError: docEditor.saveState === 'error',
      })
    } else {
      updateTabDocRuntimeHost(instanceId, {
        documentId,
        title: docEditor.currentDocument?.title ?? null,
        spaceId,
        organizationId,
        tabKey: documentId ? `tabdoc:${documentId}` : null,
        isPaneActive,
        isVisible,
        isLoading: docEditor.isLoadingDetail,
        hasError: docEditor.saveState === 'error',
      })
    }
  }, [
    documentId,
    docEditor.currentDocument?.title,
    docEditor.isLoadingDetail,
    docEditor.saveState,
    spaceId,
    organizationId,
    isPaneActive,
    isVisible,
  ])

  // BIZ-005/058 fix: 仅依赖 [isVisible, documentId]，通过 ref 读取最新状态，维持 3s 固定间隔
  const docEditorRef = useRef(docEditor)
  docEditorRef.current = docEditor

  const metadataSaveQueue = useMemo(() => createTabDocMetadataSaveQueue<
    Parameters<typeof updateDocument>[2],
    Awaited<ReturnType<typeof updateDocument>>
  >({
    suspendContent: () => {
      docEditorRef.current.autoSaveControllerRef.current?.suspend()
    },
    resumeContent: () => {
      docEditorRef.current.autoSaveControllerRef.current?.resume()
    },
    flushContent: async () => {
      await docEditorRef.current.autoSaveControllerRef.current?.flush()
    },
    refreshAfterVersionConflict: async () => {
      if (!documentId) return
      const detail = await getDocument(client, documentId)
      const doc = detail.document
      if (doc) {
        // 只刷新 CAS 基准，避免把服务端中间态标题灌进 currentDocument
        docEditorRef.current.patchCurrentDocument({
          latest_version: doc.latest_version,
          updated_at: doc.updated_at,
        })
      }
    },
    getBaseVersion: () => docEditorRef.current.baseVersionRef.current,
    getBaseUpdatedAt: () => docEditorRef.current.baseUpdatedAtRef.current,
    saveMetadata: ({ updates, baseVersion, baseUpdatedAt }) => updateDocument(client, documentId, {
      baseVersion,
      baseUpdatedAt,
      ...updates,
    }),
    applyResult: (updated) => {
      docEditorRef.current.patchCurrentDocument(updated)
    },
  }), [client, documentId])

  useEffect(() => {
    if (!documentId) return
    setAccessRevoked(false)
    setRevokedResourceTitle('')
  }, [documentId])

  useEffect(() => {
    if (!documentId) return
    return onResourceEvent(TABDOC_RESOURCE_TYPE, (event) => {
      if (event.resource_id !== documentId) return
      if (event.type === 'resource_access_revoked') {
        setRevokedResourceTitle(
          event.title || docEditorRef.current.currentDocument?.title || '',
        )
        setAccessRevoked(true)
        docEditorRef.current.retryLoad()
        return
      }
      if (event.type === 'resource_access_granted') {
        setAccessRevoked(false)
        docEditorRef.current.retryLoad()
        return
      }
      const patch = buildTabDocDocumentPatchFromResourceEvent(event, docEditorRef.current.currentDocument)
      if (!patch) return
      docEditorRef.current.patchCurrentDocument(patch)
    })
  }, [documentId])

  // CC-001 / W2 T5: 注册 dirty 采样函数与保存触发器，供 tabdoc handler.beforeClose 同步查询
  // 必须用 docEditorRef 读最新值，避免与 useEffect 的 deps 抖动；register 内部存的是闭包，
  // 闭包每次执行都通过 ref 拿到最新 docEditor，不会读到陈旧 saveState。
  // W2.5 T9: 携带 spaceId 让 collectAllDirty(spaceId) 可以按 space 过滤（删 Space 场景）
  useEffect(() => {
    if (!documentId) return
    return registerTabDocDirtySource(
      documentId,
      () => {
        const de = docEditorRef.current
        return {
          saveState: de.saveState,
          isDirty: de.autoSaveControllerRef.current?.isDirty() ?? false,
          isCollaborating: de.collaborative.isCollaborating,
          title: de.currentDocument?.title ?? null,
        }
      },
      async () => {
        const controller = docEditorRef.current.autoSaveControllerRef.current
        if (!controller) {
          // 编辑器尚未初始化，无内容可保存；当作"无 dirty 可保存"放行
          return true
        }
        try {
          await controller.flush()
        } catch {
          return false
        }
        // flush 完成但若仍 dirty（极端情况：flush 内部静默失败），保守返回 false
        return !controller.isDirty()
      },
      spaceId ?? null,
    )
  }, [documentId, spaceId])

  // Wave 3 T6: dirty 状态变化时通知 tab 标签条上的指示符订阅者实时刷新。
  // 监听 saveState（idle/dirty/saving/saved/error）+ controller.isDirty() 通过 ref 二次采样，
  // + 文档标题（标题变更时 snapshot.title 也要随动）。
  useEffect(() => {
    if (!documentId) return
    notifyTabDocDirty(documentId)
  }, [
    documentId,
    docEditor.saveState,
    docEditor.currentDocument?.title,
    // collaborative.isCollaborating 不影响 dirty 判定，但影响 snapshot.isCollaborating，
    // 让 dirty 指示符未来在协作模式下能差异化渲染
    docEditor.collaborative.isCollaborating,
  ])

  // 聊天回退后自动刷新：监听 checkpoint 回滚事件，触发与版本面板恢复相同的重载 + 重连
  // 聊天回退后自动刷新：监听 checkpoint 回滚事件（payload 为 { resourceTypes: string[] }）
  useEffect(() => {
    if (!documentId) return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.resourceTypes || detail.resourceTypes.includes('docs')) {
        docEditorRef.current.retryLoad()
        docEditorRef.current.triggerForceReconnect()
      }
    }
    window.addEventListener('tabtin:collab-resource-restored', handler)
    return () => window.removeEventListener('tabtin:collab-resource-restored', handler)
  }, [documentId])

  useEffect(() => {
    if (!isVisible) return

    let disposed = false
    let timerId: number | null = null

    const publishSnapshot = () => {
      const de = docEditorRef.current
      const draft = de.draftRef.current
      const metrics = buildTabDocRuntimeMetrics({
        saveState: de.saveState,
        saveMessage: de.saveMessage,
        latestVersion: de.currentDocument?.latest_version,
        revisionCount: 0,
        historyCount: 0,
        markdown: draft.markdown ?? '',
        plaintext: draft.plaintext ?? '',
        isCollaborating: de.collaborative.isCollaborating,
        activeEditorCount: de.collaborative.activeEditors.length,
        peerCount: de.peers.length,
        isAgentEditing: de.collaborative.isAgentEditing,
        collabStatus: de.collaborative.status,
        collabConnectionStatus: de.collaborative.connectionStatus,
        eventStreamStatus: de.collaborative.eventStreamStatus,
        isFallback: de.collaborative.isFallback,
        hasYdoc: Boolean(de.ydoc),
      })
      if (disposed) return
      publishTabDocRuntimeMetrics(runtimeMonitorInstanceIdRef.current, metrics)
    }

    const schedule = () => {
      timerId = window.setTimeout(() => {
        publishSnapshot()
        if (!disposed) {
          schedule()
        }
      }, 3000)
    }

    publishSnapshot()
    schedule()

    return () => {
      disposed = true
      if (timerId !== null) {
        window.clearTimeout(timerId)
      }
    }
  }, [isVisible, documentId])

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (effectiveReadonly) return
      if (!documentId || newTitle == null) return
      // 不在此丢弃并发提交：metadataSaveQueue 已串行化；
      // 若保存中直接 return，commitTitleChange 会当成同步成功并清掉 pending，
      // 最终标题落库失败、UI 稍后被中间态标题回灌。
      try {
        const updated = await metadataSaveQueue.enqueue({
          title: newTitle,
        })
        await hostActions.syncResourceTitle({
          documentId,
          title: updated.title,
          updatedAt: updated.updated_at,
        })
      } catch (error) {
        console.error('[DocEditorPane] failed to save title:', error)
        const errorMessage = error instanceof Error ? error.message : undefined
        const isDuplicateNameError = isDuplicateNameErrorMessage(errorMessage)
        toast({
          title: isDuplicateNameError
            ? DUPLICATE_NAME_ERROR_TITLE
            : t('titleSaveFailed', { defaultValue: '标题保存失败' }),
          description: isDuplicateNameError ? undefined : errorMessage,
          ...(isDuplicateNameError ? { variant: 'destructive' as const } : {}),
        })
        throw error
      }
    },
    [documentId, effectiveReadonly, hostActions, metadataSaveQueue, t],
  )

  const handleDocumentPropertyChange = useCallback(
    async (updates: Record<string, unknown>, options?: { silentError?: boolean }) => {
      if (effectiveReadonly) {
        if (options?.silentError) {
          throw new Error(t('permission.readonlyDesc', { defaultValue: '当前权限为只读，无法编辑文档' }))
        }
        return
      }
      if (!documentId) {
        if (options?.silentError) {
          throw new Error(t('noDocumentSelected', { defaultValue: '未选择文档' }))
        }
        return
      }
      const iconPatch = getIconOptimisticPatch(updates, docEditor.currentDocument?.icon)
      if (iconPatch) {
        docEditor.patchCurrentDocument(iconPatch.patch)
        // 侧栏标签读 tab.meta.icon；等 WS 会慢且 desktop scope 曾对不上 space_id。
        // 改图标时立刻同步所有已打开该文档的 tab。
        useSpaceContextTabsStore.getState().syncOpenResourceTabIcon({
          type: 'tabdoc',
          id: documentId,
          icon: iconPatch.patch.icon,
        })
      }
      try {
        await metadataSaveQueue.enqueue(updates as Parameters<typeof updateDocument>[2])
      } catch (error) {
        if (iconPatch) {
          docEditor.patchCurrentDocument(iconPatch.rollback)
          useSpaceContextTabsStore.getState().syncOpenResourceTabIcon({
            type: 'tabdoc',
            id: documentId,
            icon: iconPatch.rollback.icon,
          })
        }
        console.warn('[DocEditorPane] failed to save properties:', error)
        if (!options?.silentError) {
          toast({
            title: t('propertySaveFailed', { defaultValue: '属性保存失败' }),
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          })
          return
        }
        throw error
      }
    },
    [documentId, docEditor.patchCurrentDocument, effectiveReadonly, metadataSaveQueue, t],
  )

  /** Cmd+Shift+S 快捷键：通过统一 VH API 保存命名版本 */
  const handleSaveVersion = useCallback(() => {
    if (effectiveReadonly) return
    const now = new Date()
    const defaultName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    void createVHNamedVersion(defaultName).then((result) => {
      if (result.success) {
        toast({ title: t('saveNamedVersionSuccess', { defaultValue: '版本已保存' }) })
      } else {
        toast({
          title: t('saveNamedVersionFailed', { defaultValue: '保存版本失败' }),
          description: result.error,
          variant: 'destructive',
        })
      }
    })
  }, [createVHNamedVersion, effectiveReadonly, t])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <DocEditorView
          document={docEditor.currentDocument}
          initialPmJson={docEditor.initialPmJson}
          initialMarkdown={docEditor.initialMarkdown}
          editorKey={docEditor.editorKey}
          isLoading={docEditor.isLoadingDetail}
          saveState={docEditor.saveState}
          saveMessage={docEditor.saveMessage}
          syncState={docEditor.syncState}
          showRevisions={versionPanel.show}
          onEditorUpdate={docEditor.handleEditorUpdate}
          onDraftSync={docEditor.updateDraftOnly}
          onManualSave={() => void docEditor.manualSave()}
          onToggleRevisions={versionPanel.toggle}
          onTitleChange={handleTitleChange}
          onDocumentPropertyChange={handleDocumentPropertyChange}
          onContentFlushedBeforeExport={docEditor.patchCurrentDocument}
          getSaveBaseline={() => ({
            baseVersion: docEditor.baseVersionRef.current,
            baseUpdatedAt: docEditor.baseUpdatedAtRef.current,
          })}
          onSaveVersion={handleSaveVersion}
          ydoc={docEditor.ydoc}
          hocuspocusProvider={docEditor.hocuspocusProvider}
          collaborationUser={docEditor.collaborationUser}
          collaborative={docEditor.collaborative}
          loadError={docEditor.loadError}
          loadErrorKind={docEditor.loadErrorKind}
          onRetryLoad={docEditor.retryLoad}
          isReadonly={effectiveReadonly}
          onForceCloseReload={() => {
            reloadTabDocAfterForceClose(docEditor.retryLoad)
          }}
          onManualReconnect={docEditor.triggerManualReconnect}
          isRestoring={versionPanel.restoreLoading}
          autoFocusTitle={focusTitle && isPaneActive}
          isPaneActive={isPaneActive}
          isVisible={isVisible}
          resourceId={documentId}
          accessRevoked={accessRevoked}
          revokedResourceTitle={revokedResourceTitle}
        />
        {!accessRevoked && versionPanel.renderPanel()}
      </div>
    </div>
  )
}

const TabdocPanelApp: React.FC<TabdocPaneProps> = ({
  appId,
  spaceId,
  documentId,
  isPaneActive = false,
  isVisible = true,
  isReadonly = false,
  organizationIdOverride = null,
  focusTitle = false,
  initialShowVersionHistory = false,
}) => {
  const resolvedSpaceId = spaceId ?? null
  const { t } = useTranslation('tabdoc')
  const organizationId = useOrganizationId(organizationIdOverride)
  const userId = useAuthStore(state => state.user?.id ?? null)
  const mainNavTab = useMainNavStore(state => state.currentTab)
  const workbenchMode: WorkbenchMode = mainNavTab === 'cloud-docs' ? 'cloud-docs' : 'space'
  const tabScopeKey = resolvedSpaceId ? resolveForegroundTabScopeKey(resolvedSpaceId) : null

  const { client, config: editorConfig } = useMemo(() => {
    const apiPort = requireTableApiPort()
    const runtime = initializeTabDocHostRuntime({
      appId,
      baseApiUrl: API_CONFIG.baseURL,
      spaceId: resolvedSpaceId,
      organizationId,
      auth: electronAuthPort,
      collab: {
        wsUrl: COLLAB_WS_URLS.docs,
        enabled: import.meta.env.VITE_DOC_COLLAB_ENABLED === 'true',
        onStoreFailed: () => {
          toast({
            title: i18n.t('tabdoc:storeFailed', { defaultValue: '内容保存失败，请检查网络连接' }),
            variant: 'destructive',
          })
        },
      },
      imageUpload: electronImageUploadPort,
      eventStream: electronTabDocEventStreamPort,
      dragTypeMeta: DRAG_TYPE_TAB_META,
      chatContextDragType: DRAG_TYPE_CHAT_CONTEXT,
      fileRefDragType: DRAG_TYPE_FILE_REF,
      // INT-07: 注入 navigate 使 openResource 处理 tabdoc/tabslide 资源类型时能正确跳转
      navigate: (target) => {
        if (resolvedSpaceId) {
          openResourceTabGuarded(resolveForegroundTabScopeKey(resolvedSpaceId), {
            type: target.type,
            id: target.id,
          }, resolvedSpaceId)
        }
      },
      request: (req) => apiPort.request(req),
    })
    // HTML 嵌入块上传能力沿 imageUpload 同一注入链补入（host-runtime 不感知，桌面端在此叠加）。
    return {
      client: runtime.client,
      config: { ...runtime.config, htmlUpload: electronHtmlUploadPort },
    }
  }, [appId, resolvedSpaceId, organizationId])

  const tableEmbedRuntime = useMemo(
    () => createElectronTabDocTableEmbedRuntime(documentId),
    [documentId],
  )

  const hostActions = useMemo(() => createElectronTabDocHostActions({
    client,
    spaceId: resolvedSpaceId,
    organizationId,
    tabScopeKey,
    documentId,
    workbenchMode,
    userId,
    tableEmbedRuntime,
    t,
  }), [
    client,
    resolvedSpaceId,
    t,
    organizationId,
    tabScopeKey,
    documentId,
    workbenchMode,
    userId,
    tableEmbedRuntime,
  ])

  const htmlArtifactLoader = useMemo(
    () =>
      createDocumentHtmlArtifactLoader({
        apiBaseUrl: API_CONFIG.baseURL,
        getAccessToken: () => electronAuthPort.getAccessToken(),
        refreshAccessToken: electronAuthPort.refreshAccessToken
          ? () => electronAuthPort.refreshAccessToken!()
          : undefined,
      }),
    [],
  )
  const imageAssetLoader = useMemo(
    () => createDocumentImageAssetLoader({
      apiBaseUrl: API_CONFIG.baseURL,
      getAccessToken: () => electronAuthPort.getAccessToken(),
      refreshAccessToken: electronAuthPort.refreshAccessToken
        ? () => electronAuthPort.refreshAccessToken!()
        : undefined,
    }),
    [],
  )
  const imageAssetPreview = useCallback(({ url, fileId, name }: {
    url: string
    fileId?: string
    name?: string
  }) => {
    useResourcePreviewStore.getState().open([{
      id: `tabdoc-image:${documentId}:${fileId ?? url}`,
      kind: 'image',
      url,
      fileId,
      name: name || 'image',
    }], 0)
  }, [documentId])
  const htmlBlockAccess = useMemo(
    () => ({ documentId }),
    [documentId],
  )

  // No agent space context
  if (!resolvedSpaceId) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-muted-foreground">
        <FileText className="h-8 w-8 opacity-40" />
        <div className="text-body">{t('noSpace')}</div>
      </div>
    )
  }

  return (
    <TabDocEditorConfigProvider value={editorConfig}>
      <AppHostClientProvider value={client}>
        <TabDocHostActionsProvider value={hostActions}>
          <TabDocSurfaceProvider value={{ documentId, isPaneActive, isVisible }}>
            <TabDocTableEmbedRuntimeProvider value={tableEmbedRuntime}>
              <HtmlArtifactLoaderProvider value={htmlArtifactLoader}>
                <ImageAssetLoaderProvider value={imageAssetLoader}>
                  <ImageAssetPreviewProvider value={imageAssetPreview}>
                    <HtmlBlockAccessProvider value={htmlBlockAccess}>
                    <DocEditorPane
                      documentId={documentId}
                      spaceId={resolvedSpaceId}
                      organizationId={organizationId}
                      isPaneActive={isPaneActive}
                      isVisible={isVisible}
                      isReadonly={isReadonly}
                      focusTitle={focusTitle}
                      initialShowVersionHistory={initialShowVersionHistory}
                    />
                    </HtmlBlockAccessProvider>
                  </ImageAssetPreviewProvider>
                </ImageAssetLoaderProvider>
              </HtmlArtifactLoaderProvider>
            </TabDocTableEmbedRuntimeProvider>
          </TabDocSurfaceProvider>
        </TabDocHostActionsProvider>
      </AppHostClientProvider>
    </TabDocEditorConfigProvider>
  )
}

export default TabdocPanelApp
