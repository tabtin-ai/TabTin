import type { AppHostClient, TabDocHostActions } from '@tabtin/app-host-sdk'
import { getTableSpaceId } from '@tabtin/table-core'
import { toast } from '@tabtin/smartsheet-ui'
import { getHtmlBlockBrowserLink } from '@tabtin/tabdoc-ui/api-client'
import type { SpaceContextItem } from '@/services/spaceApi'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { createTable, tableStore } from '@/stores/useTableStore'
import { prefillNewTableRows } from '@/components/table/utils/prefillNewTableRows'
import { ensureSpaceSelectedOrThrow } from '@/services/spaceNavigation'
import { expandCanvasForScope, openResourceUrlInSpace } from '@/services/openResourceLink'
import { focusExistingWebTabInSpaceDetailed, openWebTabInSpace } from '@/services/openWebTabInSpace'
import { directUpload } from '@/services/oss-direct-uploader'
import { tryOpenPreviewableDirectUrl } from '@/components/chat/preview/assetPreviewResolver'
import { isTrustedLocalOssUrl } from '@shared/llm-image-url'
import {
  buildHtmlBlockBrowserUrl,
  isTrustedPublicWebUrl,
  withTabtinWebAuthHandoff,
} from '@/config/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { openTableTabGuarded } from '../../restore/openResourceMembershipGuard'
import { resolveTabDocHtmlBrowserOpenTarget } from '../resolveTabDocHtmlBrowserOpen'
import type { WorkbenchMode } from '@components/layout/useShellLayoutState'
import { createEmbeddedTableStorePool } from '@/components/table/tableStorePool'
import type { TabDocTableEmbedRuntime } from '@tabtin/tabdoc-ui'

type TranslateDocFn = (key: string, options?: Record<string, unknown>) => string

function stripUrlHash(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return url
  }
}

async function resolveElectronAccessToken(): Promise<string> {
  try {
    const ipcToken = (await window.tabtin?.auth?.getAccessToken?.()) as
      | string
      | { token?: string | null }
      | null
      | undefined
    if (typeof ipcToken === 'string') {
      const token = ipcToken.trim()
      if (token) return token
    } else if (ipcToken && typeof ipcToken === 'object') {
      const token = String(ipcToken.token || '').trim()
      if (token) return token
    }
  } catch {
    /* fall through to store */
  }
  return (useAuthStore.getState().accessToken || '').trim()
}

function patchUnifiedResource(
  resourceId: string,
  updater: (resource: SpaceContextItem) => SpaceContextItem,
) {
  const { resources, resourcesBySpaceId } = useUnifiedResources.getState()
  let didUpdateResources = false
  let didUpdateBuckets = false

  const nextResources = resources.map((resource) => {
    if (resource.resource_id !== resourceId) {
      return resource
    }

    didUpdateResources = true
    return updater(resource)
  })

  const nextResourcesBySpaceId: Record<string, SpaceContextItem[]> = {}
  for (const [cacheKey, bucket] of Object.entries(resourcesBySpaceId ?? {})) {
    let didUpdateBucket = false
    const nextBucket = bucket.map((resource) => {
      if (resource.resource_id !== resourceId) {
        return resource
      }

      didUpdateBucket = true
      return updater(resource)
    })
    if (didUpdateBucket) {
      didUpdateBuckets = true
    }
    nextResourcesBySpaceId[cacheKey] = didUpdateBucket ? nextBucket : bucket
  }

  if (didUpdateResources || didUpdateBuckets) {
    useUnifiedResources.setState({
      ...(didUpdateResources ? { resources: nextResources } : {}),
      ...(didUpdateBuckets ? { resourcesBySpaceId: nextResourcesBySpaceId } : {}),
    })
  }
}

export function syncElectronTabDocResourceTitle(
  documentId: string,
  title: string,
  updatedAt?: string | null,
) {
  // INT-04: 用 !== undefined 显式判断，与 syncResourceTitle 语义一致
  patchUnifiedResource(documentId, (resource) => ({
    ...resource,
    title,
    updated_at: updatedAt !== undefined
      ? (updatedAt || new Date().toISOString())
      : (resource.updated_at ?? new Date().toISOString()),
  }))
  // 文档编辑器、资源列表和 composer 分别读取不同投影。标题保存成功后同步所有
  // 已打开 scope 的 tab，确保当前上下文的「@文件名」无需切换标签页即可刷新。
  useSpaceContextTabsStore.getState().syncOpenResourceTabTitle({
    type: 'tabdoc',
    id: documentId,
    title,
  })
}

export function createElectronTabDocHostActions(input: {
  client: AppHostClient
  spaceId: string | null
  organizationId: string | null
  tabScopeKey?: string | null
  documentId?: string | null
  workbenchMode?: WorkbenchMode
  userId?: string | null
  tableEmbedRuntime?: TabDocTableEmbedRuntime
  t: TranslateDocFn
}): TabDocHostActions {
  const {
    client,
    spaceId,
    organizationId,
    tabScopeKey,
    documentId,
    workbenchMode = 'space',
    userId,
    tableEmbedRuntime,
    t,
  } = input

  // IR-4: 防重入标记，避免快速多次点击产生重复标签页
  const openResourceInFlight = new Set<string>()

  const actions: TabDocHostActions = {
    async openResource(resourceInput) {
      if (resourceInput.resourceType !== 'tabdata') {
        client.navigate({ type: resourceInput.resourceType, id: resourceInput.resourceId })
        return
      }

      // IR-4: 防重入 — 正在处理同一资源时忽略后续调用
      const resourceKey = `${resourceInput.resourceType}:${resourceInput.resourceId}`
      if (openResourceInFlight.has(resourceKey)) {
        return
      }
      openResourceInFlight.add(resourceKey)

      try {
        let targetSpaceId = getTableSpaceId(
          tableStore.getState().tables.find((table) => table.id === resourceInput.resourceId),
        )

        if (!targetSpaceId) {
          try {
            const sourceTableStore = tableEmbedRuntime
              ?.getOrCreateStores(resourceInput.resourceId).tableStore
              ?? tableStore
            const table = await sourceTableStore.getState().getTable(resourceInput.resourceId)
            targetSpaceId = getTableSpaceId(table)
          } catch (error) {
            // INT-03: getTable 失败时上抛异常，阻止在错误空间中打开表格
            console.warn('[electronTabDocHostAdapters] failed to parse space when opening embedded table:', error)
            toast({
              title: t('tabdataBlock.resolveSpaceFailed', {
                defaultValue: '无法获取表格所属空间信息',
              }),
              description: t('tabdataBlock.resolveSpaceFailedDesc', {
                defaultValue: '表格可能已删除或网络异常，请稍后重试。',
              }),
              variant: 'destructive',
            })
            return
          }
        }

        const finalSpaceId = targetSpaceId ?? spaceId
        const navigateFailedMessage = t('tabdataBlock.navigateFailed', {
          defaultValue: '无法打开表格，所属空间不可用',
        })

        if (!finalSpaceId) {
          throw new Error(navigateFailedMessage)
        }

        if (targetSpaceId) {
          await ensureSpaceSelectedOrThrow(targetSpaceId, {
            organizationId: organizationId ?? undefined,
            failureMessage: navigateFailedMessage,
          })
        }

        // ：写入前景 tabScopeKey，勿写 raw spaceId 桶（标签栏读 desktop:/conversation:）。
        // 跨 Space 打开后前景已切换，应重新 resolve；同 Space 复用宿主注入的 scope。
        const sameSpace = !targetSpaceId || targetSpaceId === spaceId
        const openScopeKey = (
          sameSpace && tabScopeKey?.trim()
            ? tabScopeKey.trim()
            : resolveForegroundTabScopeKey(finalSpaceId)
        )
        openTableTabGuarded(openScopeKey, resourceInput.resourceId, {
          refreshSpaceId: finalSpaceId,
          title: resourceInput.title,
          ...(documentId ? { meta: { parentDocumentId: documentId } } : {}),
        })
        if (workbenchMode !== 'cloud-docs' && openScopeKey) {
          expandCanvasForScope(openScopeKey)
        }
      } finally {
        openResourceInFlight.delete(resourceKey)
      }
    },

    async openWebUrl(webInput) {
      const url = webInput.url?.trim()
      if (!url) return

      const openIntentHints = webInput.openIntentHints
      if (tryOpenPreviewableDirectUrl(url, {
        filename: openIntentHints?.filename,
        mimeType: openIntentHints?.mimeType,
        fileId: openIntentHints?.assetId,
      })) {
        return
      }

      // 文档正文网页链接 / HTML 块「在浏览器打开」→ 内置 tabweb。
      if (spaceId && documentId) {
        const target = resolveTabDocHtmlBrowserOpenTarget({
          workbenchMode,
          spaceId,
          documentId,
          organizationId,
          userId,
          fallbackTabScopeKey: tabScopeKey,
        })
        const openOptions = {
          tabScopeKey: target.tabScopeKey,
          title: webInput.title?.trim() || undefined,
          openIntentHints,
          // local-object（6060）与 dev PUBLIC_WEB（5176）均为私有 host，tabweb 默认拦截。
          allowPrivateHostNavigation:
            isTrustedLocalOssUrl(url) || isTrustedPublicWebUrl(url),
        }
        // 同 URL 复用已有 tabweb（与 openLocalHtmlInSpace / 聊天上下文跳转一致），避免连点或修复前后重复开标签。
        // hash（如 tabtin_handoff）不参与复用键；但若本次带 handoff，复用后必须再 navigate，
        // 否则旧 tab 停在 login_required 时永远吃不到新 token。
        const reuseUrl = stripUrlHash(url)
        const hasAuthHandoff = url.includes('#tabtin_handoff=')
        const reused = await focusExistingWebTabInSpaceDetailed(spaceId, reuseUrl, {
          tabScopeKey: target.tabScopeKey,
        })
        let result = reused
        if (reused.ok && hasAuthHandoff && reused.viewId) {
          const nav = await window.tabtin?.webviewHost?.navigate?.(reused.viewId, url)
          if (nav && nav.success === false) {
            // navigate 失败则退回新开，保证 handoff 仍能送达
            result = await openWebTabInSpace(spaceId, url, openOptions)
          }
        } else if (!reused.ok) {
          result = await openWebTabInSpace(spaceId, url, openOptions)
        }
        if (result.ok) {
          if (workbenchMode !== 'cloud-docs') {
            expandCanvasForScope(target.tabScopeKey)
          }
          return
        }
        toast({
          title: t('htmlBlock.openInBrowserFailed', { defaultValue: '无法在浏览器中打开' }),
          description: result.error,
          variant: 'destructive',
        })
        return
      }

      // 无 Space / 文档上下文时回退通用链接派发。
      if (openIntentHints) {
        openResourceUrlInSpace(url, tabScopeKey, { openIntentHints })
      } else {
        openResourceUrlInSpace(url, tabScopeKey)
      }
    },

    async uploadImportFile(uploadInput) {
      const result = await directUpload(uploadInput.file, uploadInput.file.name, {
        folder: 'tabdoc/imports',
        module: 'tabdoc',
        contextType: 'document',
        contextId: uploadInput.documentId || uploadInput.spaceId || `tabdoc_import_${Date.now()}`,
        organizationId: uploadInput.organizationId || organizationId || undefined,
        isPublic: false,
        enableInstantUpload: false,
      })
      return { fileRecordId: result.fileId }
    },

    async createEmbeddedTable(tableInput) {
      if (!tableInput.organizationId) {
        throw new Error(
          t('tabdataBlock.organizationNotReady', {
            defaultValue: '当前组织尚未就绪，无法创建表格',
          }),
        )
      }

      // ：嵌入表直属 Organization
      const table = await createTable({
        organization_id: tableInput.organizationId,
        name: tableInput.title || t('tabdataBlock.untitled'),
      })

      if (!table) {
        throw new Error(
          t('tabdataBlock.createFailed', {
            defaultValue: '创建表格失败',
          }),
        )
      }

      try {
        await prefillNewTableRows(table.id)
      } catch (seedError) {
        // IR-3: 预填失败时 toast 提示用户 + 运行时监控上报
        console.warn('[electronTabDocHostAdapters] failed to seed empty row after embedded table creation:', seedError)
        toast({
          title: t('tabdataBlock.prefillFailed', {
            defaultValue: '表格初始化行数据失败',
          }),
          description: t('tabdataBlock.prefillFailedDesc', {
            defaultValue: '表格已创建但预填数据未成功，您可以手动添加行。',
          }),
          variant: 'destructive',
        })
      }

      return { id: table.id, name: table.name }
    },

    async listTables(listInput) {
      if (!listInput.organizationId) {
        return []
      }

      await tableStore.getState().loadTables(listInput.organizationId)

      return tableStore.getState().tables.map((table) => ({
        id: table.id,
        name: table.name,
        description: table.description,
        icon: table.icon,
        spaceId: getTableSpaceId(table),
        isArchived: table.is_archived,
      }))
    },

    async syncResourceMeta(metaInput) {
      // IR-5: 统一通过 patchUnifiedResource 更新，与 syncResourceTitle 共用同一路径
      patchUnifiedResource(metaInput.documentId, (resource) => ({
        ...resource,
        metadata: {
          ...(resource.metadata ?? {}),
          linked_resource_ids: metaInput.linkedResourceIds,
        },
      }))
    },

    async syncResourceTitle(titleInput) {
      syncElectronTabDocResourceTitle(
        titleInput.documentId,
        titleInput.title,
        titleInput.updatedAt,
      )
    },

    async openHtmlArtifactInBrowser(browserInput) {
      // 先问 browser-link：成员 ACL 校验 + 取当前文档 effective share_id（可空）
      // fileId：协作未落库时短期 hint
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

      // tabweb 与 Electron 不共享 localStorage；成员 ACL / org 分享需一次性注入 token。
      // hash 不进 HTTP；页面读完即 strip，地址栏可复制的是无 token 的稳定 URL。
      const accessToken = await resolveElectronAccessToken()
      const openUrl = accessToken ? withTabtinWebAuthHandoff(url, accessToken) : url

      await actions.openWebUrl({
        url: openUrl,
        title: browserInput.title,
      })
    },
  }

  return actions
}

export function createElectronTabDocTableEmbedRuntime(
  parentDocumentId: string,
): TabDocTableEmbedRuntime {
  const pool = createEmbeddedTableStorePool(parentDocumentId)

  const resolveStoreKey = (tableId: string, surfaceId?: string) =>
    surfaceId ? `${tableId}::surface::${surfaceId}` : tableId

  return {
    parentDocumentId,
    getOrCreateStores(tableId, surfaceId) {
      const storeKey = resolveStoreKey(tableId, surfaceId)
      const tableStoreApi = pool.getOrCreateTableStore(storeKey)
      const viewStoreApi = pool.getOrCreateViewStore(storeKey)
      const recordStoreApi = pool.getOrCreateRecordStore(storeKey, viewStoreApi)

      return {
        tableStore: tableStoreApi,
        viewStore: viewStoreApi,
        recordStore: recordStoreApi,
      }
    },

    retainStore(tableId, surfaceId) {
      const storeKey = resolveStoreKey(tableId, surfaceId)
      pool.retainStoreForTable(storeKey)
    },

    releaseStore(tableId, surfaceId) {
      const storeKey = resolveStoreKey(tableId, surfaceId)
      pool.releaseStoreForTable(storeKey)
    },

    rebuildStore(tableId, surfaceId) {
      pool.forceRebuildStoreForTable(resolveStoreKey(tableId, surfaceId))
    },
  }
}
