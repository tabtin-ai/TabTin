import { useCallback, useEffect, useRef } from 'react'
import { contextRegistry, type ContextItemType, type ContextTabKey } from '../registry'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { recordContextItemAccess, useUnifiedResources } from '@/stores/useUnifiedResources'
import { useCollections } from '@/stores/useCollections'
import { useSpaceApps } from '@stores/useSpaceApps'
import type { SpaceContextItem } from '@tabtin/app-shell'
import { createTerminalSessionInScope } from '../sources/terminal'
import { activateBrowserView } from '@/services/browserViewActivation'
import { seedManager } from '@stores/seed-manager'
import type { OpenIntentHints } from '@shared/open-intent'
import {
  openResourceTabGuarded,
  openTableTabGuarded,
} from '../restore/openResourceMembershipGuard'
import { isLoadableResourceHostSpaceId } from '@components/layout/cloud-docs/cloudDocsHostSpace'

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function readOpenIntentHints(raw: unknown): OpenIntentHints | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const hints: OpenIntentHints = {}
  if (typeof value.filename === 'string' && value.filename.trim()) hints.filename = value.filename
  if (typeof value.mimeType === 'string' && value.mimeType.trim()) hints.mimeType = value.mimeType
  if (typeof value.assetId === 'string' && value.assetId.trim()) hints.assetId = value.assetId
  return Object.keys(hints).length > 0 ? hints : undefined
}

export function resolveNavigableResourceId(item: SpaceContextItem, tabType: string): string {
  const metadata = item.metadata ?? {}
  if (tabType === 'tabdata') {
    return firstString(
      metadata.current_table_id,
      metadata.table_id,
      metadata.tableId,
      metadata.resource_id,
      item.resource_id,
    )
  }

  if (tabType === 'tabdoc') {
    return firstString(
      metadata.current_doc_id,
      metadata.document_id,
      metadata.doc_id,
      metadata.documentId,
      metadata.docId,
      metadata.resource_id,
      item.resource_id,
    )
  }

  return item.resource_id ?? ''
}

interface ResourceInitParams {
  spaceId: string
  tabScopeKey?: string
  spaceName: string
  spaceOrganizationId: string
  crawlspaceId?: string | null
  activeTabType: string
  isForeground: boolean
}

interface ResourceInitResult {
  handleSearchNavigate: (item: SpaceContextItem) => Promise<void>
  handleReopenClosedTab: () => void
}

/**
 * 资源初始化 hook：
 * - 加载 UnifiedResources / Collections / SpaceApps
 * - 确保 crawlspace 存在（当 browser tab 激活时）
 * - 提供 handleSearchNavigate（跨 Space 导航到搜索结果）
 * - 提供 handleReopenClosedTab（恢复最近关闭的标签）
 */
export function useResourceInit({
  spaceId, tabScopeKey, spaceName, spaceOrganizationId,
  crawlspaceId, activeTabType,
  isForeground,
}: ResourceInitParams): ResourceInitResult {
  const storageKey = tabScopeKey ?? spaceId
  // ── Unified resources ──
  const loadUnifiedResources = useUnifiedResources(state => state.load)
  const setCurrentUnifiedResourceSpace = useUnifiedResources(state => state.setCurrentSpace)
  const resourceForegroundVisitRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isForeground || !isLoadableResourceHostSpaceId(spaceId)) return
    const shouldForceReload = resourceForegroundVisitRef.current === spaceId
    setCurrentUnifiedResourceSpace(spaceId)
    void loadUnifiedResources(spaceId, shouldForceReload)
    resourceForegroundVisitRef.current = spaceId
  }, [isForeground, loadUnifiedResources, setCurrentUnifiedResourceSpace, spaceId])

  // ── Collections ──
  const loadCollections = useCollections(state => state.load)
  const setCurrentCollectionSpace = useCollections(state => state.setCurrentSpace)
  const collectionForegroundVisitRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isForeground || !isLoadableResourceHostSpaceId(spaceId)) return
    const shouldForceReload = collectionForegroundVisitRef.current === spaceId
    setCurrentCollectionSpace(spaceId)
    void loadCollections(spaceId, shouldForceReload)
    collectionForegroundVisitRef.current = spaceId
  }, [isForeground, loadCollections, setCurrentCollectionSpace, spaceId])

  // ── SpaceApps ──
  const loadSpaceApps = useSpaceApps(state => state.loadSpaceApps)
  useEffect(() => {
    if (!isForeground || !isLoadableResourceHostSpaceId(spaceId)) return
    void loadSpaceApps(spaceId)
  }, [loadSpaceApps, isForeground, spaceId])

  // ── Ensure crawlspace exists when browser tab is active ──
  const ensureScopedCrawlspace = useCrawlTabStore(state => state.ensureScopedCrawlspace)
  useEffect(() => {
    if (!isForeground) return
    if (activeTabType !== 'tabweb') return
    if (crawlspaceId) return
    ensureScopedCrawlspace(spaceId, storageKey, { title: spaceName })
  }, [activeTabType, crawlspaceId, ensureScopedCrawlspace, isForeground, spaceId, spaceName, storageKey])

  // ── Reopen closed tab ──
  const handleReopenClosedTab = useCallback(() => {
    const closedTabsStore = useClosedTabsStore.getState()
    const entry = closedTabsStore.peek(spaceId)
    if (!entry) return

    const type = entry.type || 'tabweb'
    let restored = false

    switch (type) {
      case 'tabweb': {
        if (!entry.url) return
        const ensureCS = useCrawlTabStore.getState().ensureScopedCrawlspace
        void (async () => {
          try {
            const cs = ensureCS(spaceId, storageKey)
            const csId = cs.id
            const ipcAdapter = createElectronIpcAdapter(csId, spaceId)
            const viewId = `view-${csId}-${Date.now()}`
            const tabKey = contextRegistry.buildTabKey('tabweb', viewId)
            const openIntentHints = readOpenIntentHints(entry.meta?.openIntentHints)
            const created = await ipcAdapter.createView(
              viewId,
              entry.url!,
              undefined,
              entry.title,
              undefined,
              openIntentHints ? { openIntentHints } : undefined,
            )
            if (!created) return
            seedManager.ensureSeed(csId, {
              viewId,
              url: entry.url!,
              title: entry.title || entry.url!,
              favicon: entry.favicon,
              openIntentHints,
            })
            const result = await activateBrowserView(csId, viewId, {
              spaceId,
              selection: { tabScopeKey: storageKey, tabKey },
              fallbackView: {
                viewId,
                url: entry.url!,
                title: entry.title || entry.url!,
                favicon: entry.favicon,
                openIntentHints,
              },
            })
            if (result.ok && result.code !== 'cancelled') {
              closedTabsStore.pop(spaceId)
            }
          } catch {
            window.open(entry.url!, '_blank')
            closedTabsStore.pop(spaceId)
          }
        })()
        return
      }
      case 'tabdata': {
        if (entry.id) {
          openTableTabGuarded(storageKey, entry.id, { refreshSpaceId: spaceId })
          restored = true
        }
        break
      }
      case 'terminal': {
        createTerminalSessionInScope({
          spaceId,
          storageKey,
          title: entry.title || undefined,
        })
        restored = true
        break
      }
      default: {
        if (entry.id) {
          openResourceTabGuarded(storageKey, {
            type: type as ContextItemType,
            id: entry.id,
            title: entry.title || '',
            meta: { spaceId, ...entry.meta },
          }, spaceId)
          restored = true
        }
        break
      }
    }
    if (restored) {
      closedTabsStore.pop(spaceId)
    }
  }, [spaceId, storageKey])

  // ── Search navigate ──
  const handleSearchNavigate = useCallback(
    async (item: SpaceContextItem) => {
      const tabType = contextRegistry.normalizeBackendType(item.item_type)
      const targetSpaceId = item.space_id || spaceId
      const resourceId = resolveNavigableResourceId(item, tabType)
      if (!targetSpaceId || !resourceId || !contextRegistry.isKnownType(tabType)) return

      // 跨 Space 打开走「浏览面 ≠ 执行面」（docs/prd/desktop-conversation-space-boundary.md §2.1）：
      // 不切换全局选中 Space，直接在当前 scope（当前对话 / 桌面标签组）以「外部资源」tab 打开——
      // meta.spaceId / organizationId 指向资源真实归属，foreignShared 让 workbench restore 跳过
      // 「资源属于当前 Space」的成员校验（restore/policies.ts），避免重启后被当 missing 清除。
      // 这与「分享给我」(services/openSharedResource.ts) 是同一范式。
      const isCrossSpace = targetSpaceId !== spaceId
      const handler = contextRegistry.getHandler(tabType as ContextItemType)
      const tabsStore = useSpaceContextTabsStore.getState()
      if (tabType === 'tabdata') {
        if (isCrossSpace) {
          // openTableTab 不携带 meta，无法标记 foreignShared；跨 Space 表格改走
          // openResourceTab（携 foreignShared），渲染层按 meta.spaceId 挂载、鉴权仍由后端把关。
          tabsStore.openResourceTab(storageKey, {
            type: 'tabdata',
            id: resourceId,
            title: item.title || '',
            meta: { spaceId: targetSpaceId, organizationId: spaceOrganizationId, foreignShared: true },
          })
        } else {
          openTableTabGuarded(storageKey, resourceId, { refreshSpaceId: spaceId })
        }
      } else {
        const meta: Record<string, unknown> = {
          ...(item.metadata ?? {}),
          spaceId: targetSpaceId,
          // ：tabType 已过 normalizeBackendType，'tabfiles' 归一化为 'file'——
          // 此前误写 'tabfiles' 是死分支，从未命中过。
          // ：org-only 云盘（drive upload / Agent 归档）无 space_id，换链须走
          // organization download-url；把真实宿主写进 meta，避免误用浏览面 Space。
          ...(tabType === 'file' && item.id
            ? {
                context_item_id: item.id,
                organizationId: item.organization_id || spaceOrganizationId,
                ...(item.space_id ? { file_host_space_id: item.space_id } : {}),
              }
            : {}),
        }
        if (isCrossSpace) {
          meta.organizationId = item.organization_id || spaceOrganizationId
          meta.foreignShared = true
        }
        if (tabType === 'tabcode' && item.metadata?.path) {
          meta.path = item.metadata.path
        }
        const tabKey = `${tabType}:${resourceId}` as ContextTabKey
        const dispatched = contextRegistry.dispatchSelect(
          { type: tabType as ContextItemType, id: resourceId, tabKey, title: item.title || '', meta },
          { spaceId: targetSpaceId, tabScopeKey: storageKey, closeBrowserView: () => {} },
        )
        if (!dispatched) {
          openResourceTabGuarded(storageKey, {
            type: tabType as ContextItemType,
            id: resourceId,
            title: item.title || '',
            meta,
          }, spaceId)
        }
        // 资源列表点击是明确的用户导航意图。TabDoc scope claim / membership
        // 刷新可能触发一次 restore；在 tab 已写入后再次声明激活目标，避免
        // 恢复协调器把用户刚打开的文档切回云盘首页。
        if (tabType === 'tabdoc') {
          queueMicrotask(() => {
            useSpaceContextTabsStore.getState().setActiveKey(storageKey, tabKey, {
              writer: 'user',
              reason: 'resource-list-click',
            })
          })
        }
      }

      handler?.onNavigateFromList?.(item.metadata ?? {})

      // 记录最近访问（per-user）并乐观回写 last_visited_at。
      // 确认进入打开流程后再 fire-and-forget；空 / local: / shared: id 由 helper 跳过。
      recordContextItemAccess(item.id)
    },
    [spaceId, spaceOrganizationId, storageKey],
  )

  return {
    handleSearchNavigate,
    handleReopenClosedTab,
  }
}
