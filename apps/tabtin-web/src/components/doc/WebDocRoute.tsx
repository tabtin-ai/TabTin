/**
 * WebDocRoute — Web 端文档路由入口
 *
 * 替换原来的只读预览，升级为完整的文档编辑器。
 * 通过 TabDocEditorConfigProvider + AppHostClientProvider 注入 Web 平台能力。
 */
import React, { useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import { initializeTabDocHostRuntime } from '@tabtin/tabdoc-host-runtime'
import type { AppHostClient, TabDocHostActions, TabDocOpenResourceInput } from '@tabtin/app-host-sdk'
import { AppHostClientProvider } from '@tabtin/app-host-sdk'
import {
  TabDocHostActionsProvider,
  TabDocEditorConfigProvider,
  TabDocTableEmbedRuntimeProvider,
} from '@tabtin/tabdoc-ui'
import {
  configureTabDataBlockView,
  createDocumentHtmlArtifactLoader,
  createDocumentImageAssetLoader,
  getIconOptimisticPatch,
  HtmlArtifactLoaderProvider,
  HtmlBlockAccessProvider,
  ImageAssetLoaderProvider,
} from '@tabtin/tabdoc-ui/editor'
import { useCollaborativeDocEditor } from '@tabtin/tabdoc-ui/use-collaborative-doc-editor'
import {
  getHtmlBlockBrowserLink,
  updateDocument,
} from '@tabtin/tabdoc-ui/api-client'
import { useVersionPanel } from '@tabtin/collab-core'
import { isPermissionInsufficientForEditing, toast } from '@tabtin/smartsheet-ui'

import { useDocLaunchContext } from '@/features/doc/useDocLaunchContext'
import { webAuthPort, webImageUploadPort } from '@/features/doc/bootstrap'
import { STORAGE_KEYS } from '@/platform'
import { createWebTabDocTableEmbedRuntime } from '@/features/doc/webTabDocTableEmbedRuntime'
import { useWebPresentation } from '@/components/layout/WebPresentationContext'
import { getApiClient } from '@/services/api-client'
import { API_BASE_URL, buildHtmlBlockBrowserUrl } from '@/config/api'
import { WebDocEditorView } from './WebDocEditorView'
import { WebTableEmbedHost } from './embed/WebTableEmbedHost'

configureTabDataBlockView({
  renderTableEmbed: (props) =>
    React.createElement(WebTableEmbedHost, {
      tableId: props.tableId,
      viewId: props.viewId,
      title: props.title,
      maxHeight: props.maxHeight,
      onOpenInTab: props.onOpenInTab,
      onDelete: props.onDelete,
      onUpdateAttributes: props.onUpdateAttributes,
    }),
})

function createWebTabDocHostActions(
  client: AppHostClient,
  organizationId: string | null,
  spaceId: string | null,
): TabDocHostActions {
  const actions: TabDocHostActions = {
    async openResource(input: TabDocOpenResourceInput) {
      if (input.resourceType === 'tabdata') {
        const path =
          spaceId && organizationId
            ? `/organizations/${organizationId}/spaces/${spaceId}/tables/${input.resourceId}`
            : spaceId
              ? `/spaces/${spaceId}/tables/${input.resourceId}`
              : `/tables/${input.resourceId}`
        window.open(path, '_blank')
      } else {
        window.open(`/docs/${input.resourceId}`, '_blank')
      }
    },

    async openWebUrl(webInput) {
      // Web 端没有内置浏览器载体，外部链接在新浏览器标签打开。
      window.open(webInput.url, '_blank', 'noopener,noreferrer')
    },

    async openHtmlArtifactInBrowser(browserInput) {
      // 成员 ACL：browser-link 取 effective share_id（可空）后打开稳定页
      const link = await getHtmlBlockBrowserLink(
        client,
        browserInput.documentId,
        browserInput.blockId,
        browserInput.fileId,
      )
      const url = buildHtmlBlockBrowserUrl(
        link.document_id,
        link.block_id,
        link.share_id,
        link.file_id_hint || browserInput.fileId,
      )
      if (!url) {
        throw new Error('Public web base URL is required to open HTML block in browser')
      }
      await actions.openWebUrl({ url, title: browserInput.title })
    },

    async createEmbeddedTable(tableInput) {
      if (!tableInput.spaceId || !tableInput.organizationId) {
        throw new Error('当前空间尚未就绪，无法创建表格')
      }
      const apiClient = getApiClient()
      const response = (await apiClient.raw('POST', '/tabdata/tables', {
        body: {
          organization_id: tableInput.organizationId,
          space_id: tableInput.spaceId,
          name: tableInput.title || '未命名表格',
        },
        rawResponse: true,
      })) as Response
      const data = (await response.json()) as {
        table: { id: string; name: string }
      }
      return { id: data.table.id, name: data.table.name }
    },

    async listTables(listInput) {
      if (!listInput.organizationId) return []
      const apiClient = getApiClient()
      const params = new URLSearchParams({
        organization_id: listInput.organizationId,
      })
      if (listInput.spaceId) params.set('space_id', listInput.spaceId)
      const response = (await apiClient.raw(
        'GET',
        `/tabdata/tables?${params.toString()}`,
        { rawResponse: true },
      )) as Response
      const data = (await response.json()) as {
        tables: Array<{
          id: string
          name: string
          description?: string
          icon?: string
          space_id?: string | null
          is_archived?: boolean
        }>
      }
      return (data.tables || []).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        icon: t.icon,
        spaceId: t.space_id ?? null,
        isArchived: t.is_archived ?? false,
      }))
    },

    async syncResourceMeta() {},
    async syncResourceTitle() {},
  }
  return actions
}

function WebDocEditorPane({ documentId, spaceId, organizationId }: {
  documentId: string
  spaceId: string | null
  organizationId: string | null
}) {
  const { t, i18n } = useTranslation('tabdoc')
  const baseApiUrl = API_BASE_URL || '/api'
  const { client, config } = useMemo(() => {
    return initializeTabDocHostRuntime({
      baseApiUrl,
      spaceId,
      organizationId,
      auth: webAuthPort,
      collab: {
        wsUrl: baseApiUrl.replace(/^http/, 'ws') + '/collab/ws/docs',
        enabled: import.meta.env.VITE_DOC_COLLAB_ENABLED !== 'false',
        onStoreFailed: () => {
          toast({
            title: i18n.t('tabdoc:storeFailed', { defaultValue: '内容保存失败，请检查网络连接' }),
            variant: 'destructive',
          })
        },
      },
      imageUpload: webImageUploadPort,
      request: async (req) => {
        const apiClient = getApiClient()
        const rawPath = req.url.startsWith(baseApiUrl) ? req.url.slice(baseApiUrl.length) : req.url
        const response = await apiClient.raw(req.method, rawPath.startsWith('/') ? rawPath : `/${rawPath}`, {
          headers: req.headers,
          body: req.body ? JSON.parse(req.body) : undefined,
          rawResponse: true,
        }) as Response
        const contentType = response.headers.get('content-type') ?? ''
        let data: unknown
        if (response.status === 204) data = undefined
        else if (contentType.includes('application/json')) data = await response.json()
        else data = await response.text()
        return { data, status: response.status, statusText: response.statusText, headers: {} }
      },
    })
  }, [baseApiUrl, spaceId, organizationId])

  const docEditor = useCollaborativeDocEditor({
    documentId,
    t: (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
  })

  const versionPanel = useVersionPanel({
    resourceType: 'docs',
    resourceId: documentId,
    apiBase: `${baseApiUrl}/collab/v1`,
    token: localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN) || '',
    locale: (i18n.language as 'zh-CN' | 'en-US') || 'zh-CN',
    resourceName: docEditor.currentDocument?.title ?? undefined,
    onRestoreComplete: (info) => {
      docEditor.retryLoad()
      // : resync 模式下服务端已通过 Yjs 增量广播还原内容，无需断线重连
      if (info?.syncMode !== 'resync') {
        docEditor.triggerForceReconnect()
      }
    },
    t: (key: string, opts?: Record<string, unknown>) => t(key, opts) as string,
    toast: {
      success: (msg: string) => toast({ title: msg }),
      error: (msg: string) => toast({ title: msg, variant: 'destructive' }),
    },
  })

  const hostActions = useMemo(
    () => createWebTabDocHostActions(client, organizationId, spaceId),
    [client, organizationId, spaceId],
  )
  const tableEmbedRuntime = useMemo(() => createWebTabDocTableEmbedRuntime(), [])
  const htmlArtifactLoader = useMemo(
    () =>
      createDocumentHtmlArtifactLoader({
        apiBaseUrl: baseApiUrl,
        getAccessToken: () => webAuthPort.getAccessToken(),
        refreshAccessToken: webAuthPort.refreshAccessToken
          ? () => webAuthPort.refreshAccessToken!()
          : undefined,
      }),
    [baseApiUrl],
  )
  const imageAssetLoader = useMemo(
    () => createDocumentImageAssetLoader({
      apiBaseUrl: baseApiUrl,
      getAccessToken: () => webAuthPort.getAccessToken(),
      refreshAccessToken: webAuthPort.refreshAccessToken
        ? () => webAuthPort.refreshAccessToken!()
        : undefined,
    }),
    [baseApiUrl],
  )
  const currentUserRole = docEditor.currentDocument?.current_user_role
  const htmlBlockAccess = useMemo(
    () => ({ documentId }),
    [documentId],
  )
  const effectiveReadonly = Boolean(
    isPermissionInsufficientForEditing(currentUserRole)
    || (docEditor.collaborative && !docEditor.collaborative.isFallback && docEditor.collaborative.readOnly)
  )

  const handleTitleChange = useCallback(async (newTitle: string) => {
    if (effectiveReadonly) return
    if (!documentId || newTitle == null) return
    try {
      const updated = await updateDocument(client, documentId, {
        baseVersion: docEditor.baseVersionRef.current,
        baseUpdatedAt: docEditor.baseUpdatedAtRef.current,
        title: newTitle,
      })
      docEditor.patchCurrentDocument(updated)
    } catch (error) {
      console.warn('[WebDocRoute] failed to save title:', error)
      toast({
        title: t('titleSaveFailed', { defaultValue: '标题保存失败' }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
      throw error
    }
  }, [client, documentId, docEditor.patchCurrentDocument, docEditor.baseVersionRef, docEditor.baseUpdatedAtRef, effectiveReadonly, t])

  const handleDocumentPropertyChange = useCallback(async (
    updates: Record<string, unknown>,
    options?: { silentError?: boolean },
  ) => {
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
    }
    try {
      const updated = await updateDocument(client, documentId, {
        baseVersion: docEditor.baseVersionRef.current,
        baseUpdatedAt: docEditor.baseUpdatedAtRef.current,
        ...(updates as Parameters<typeof updateDocument>[2]),
      })
      docEditor.patchCurrentDocument(updated)
    } catch (error) {
      if (iconPatch) {
        docEditor.patchCurrentDocument(iconPatch.rollback)
      }
      if (!options?.silentError) {
        toast({ title: t('propertySaveFailed', { defaultValue: '属性保存失败' }), variant: 'destructive' })
        return
      }
      throw error
    }
  }, [client, documentId, docEditor.patchCurrentDocument, docEditor.baseVersionRef, docEditor.baseUpdatedAtRef, effectiveReadonly, t])

  return (
    <TabDocEditorConfigProvider value={config}>
      <AppHostClientProvider value={client}>
        <TabDocHostActionsProvider value={hostActions}>
          <TabDocTableEmbedRuntimeProvider value={tableEmbedRuntime}>
            <HtmlArtifactLoaderProvider value={htmlArtifactLoader}>
              <ImageAssetLoaderProvider value={imageAssetLoader}>
                <HtmlBlockAccessProvider value={htmlBlockAccess}>
                <div className="relative h-full">
                  <WebDocEditorView
                    document={docEditor.currentDocument}
                    initialPmJson={docEditor.initialPmJson}
                    initialMarkdown={docEditor.initialMarkdown}
                    editorKey={docEditor.editorKey}
                    isLoading={docEditor.isLoadingDetail}
                    saveState={docEditor.saveState}
                    saveMessage={docEditor.saveMessage}
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
                    ydoc={docEditor.ydoc}
                    hocuspocusProvider={docEditor.hocuspocusProvider}
                    collaborationUser={docEditor.collaborationUser}
                    collaborative={docEditor.collaborative}
                    loadError={docEditor.loadError}
                    onRetryLoad={docEditor.retryLoad}
                  />
                  {versionPanel.renderPanel()}
                </div>
                </HtmlBlockAccessProvider>
              </ImageAssetLoaderProvider>
            </HtmlArtifactLoaderProvider>
          </TabDocTableEmbedRuntimeProvider>
        </TabDocHostActionsProvider>
      </AppHostClientProvider>
    </TabDocEditorConfigProvider>
  )
}

export function WebDocRoute() {
  const { documentId, spaceId, organizationId, buildHomePath } = useDocLaunchContext()
  const { t } = useTranslation('common')
  const { isEmbedded } = useWebPresentation()

  if (!documentId) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div className="text-title font-semibold text-foreground">{t('webModules.doc.invalidIdTitle')}</div>
          <div className="mt-2 text-body text-muted-foreground">{t('webModules.doc.invalidIdDesc')}</div>
          <Link className="mt-4 inline-flex text-body text-primary hover:underline" to={buildHomePath()}>
            {t('webModules.backToSpace')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {!isEmbedded && <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-body text-muted-foreground">
          <FileText className="h-4 w-4" />
          <span>{t('webModules.doc.editorTitle', { defaultValue: '文档编辑器' })}</span>
        </div>
        <Link className="text-body text-muted-foreground hover:text-foreground" to={buildHomePath()}>
          {t('webModules.backToSpace')}
        </Link>
      </div>}
      <div className="min-h-0 flex-1">
        <WebDocEditorPane
          documentId={documentId}
          spaceId={spaceId}
          organizationId={organizationId}
        />
      </div>
    </div>
  )
}
