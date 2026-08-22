import { useCallback, useMemo, useRef } from 'react'
import { getTableSpaceId } from '@tabtin/table-core'
import { toast } from '@components/ui'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { seedManager } from '@stores/seed-manager'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { contextRegistry } from '@components/context-space/registry'
import { resolveAppHomeTabModel } from '@components/context-space/registry/resolveUtils'
import type { ContextItem, ContextItemType } from '@components/context-space/registry/types'
import { getSpaceSettingsTitle } from '@components/space-settings/settingsTitle'
import i18n from '@/i18n'
import type { Table } from '@tabtin/table-core'
import { createLogger } from '@/utils/logger'
import { createTerminalSessionInScope, openTerminalTabInScope } from '../sources/terminal'
import type { ContextItemMeta } from '@stores/contextTabs/types'
import { activateBrowserView } from '@/services/browserViewActivation'
import {
  openResourceTabGuarded,
  openTableTabGuarded,
} from '../restore/openResourceMembershipGuard'

const log = createLogger('ContextNav')

export interface SpaceContextNavigationOptions {
  spaceId: string
  tabScopeKey?: string
  spaceName?: string
  tables?: Table[]
}

/** 测试 seam：导航写入始终落在显式 tabScopeKey，缺省才回落 execution spaceId */
export function resolveContextNavigationStorageKey(
  spaceId: string,
  tabScopeKey?: string | null,
): string {
  return tabScopeKey || spaceId
}

/**
 * 🧭 项目上下文导航 Hook
 *
 * 职责：封装标签打开/关闭/切换的业务逻辑
 *
 * ⚠️ 乐观更新策略：
 * - 先更新 UI 状态（setActiveKey），再执行 IPC 调用
 * - 如果 IPC 失败，回滚到之前的状态
 * - 使用 pendingActionRef 防止并发创建冲突
 * - 使用 actionSeqRef 避免旧请求回滚覆盖新状态
 */
export function useSpaceContextNavigation({ spaceId, tabScopeKey, spaceName, tables }: SpaceContextNavigationOptions) {
  const storageKey = resolveContextNavigationStorageKey(spaceId, tabScopeKey)
  const setActiveKey = useSpaceContextTabsStore((state) => state.setActiveKey)

  const ensureScopedCrawlspace = useCrawlTabStore((state) => state.ensureScopedCrawlspace)
  const closeCrawlspaceView = useCrawlTabStore((state) => state.closeCrawlspaceView)

  // 🔄 乐观更新回滚支持
  const pendingActionRef = useRef<string | null>(null)
  const actionSeqRef = useRef(0)
  const getActiveKeyNow = useCallback(() => {
    return useSpaceContextTabsStore.getState().activeKeyBySpace[storageKey] ?? null
  }, [storageKey])
  const logTabSwitch = useCallback((stage: string, payload: Record<string, unknown>) => {
    if (!globalThis.__TABTIN_DEBUG_TAB_SWITCH__) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    log.debug(`${stage}`, { t: now, ...payload })
  }, [])

  const tableMap = useMemo(() => {
    if (!tables || tables.length === 0) return null
    const map = new Map<string, Table>()
    tables.forEach((table) => {
      map.set(table.id, table)
    })
    return map
  }, [tables])

  const openHome = useCallback(() => {
    ensureScopedCrawlspace(spaceId, storageKey, { title: spaceName })
    setActiveKey(storageKey, null, { writer: 'user', reason: 'openHome' })
  }, [ensureScopedCrawlspace, setActiveKey, spaceId, spaceName, storageKey])

  const openTable = useCallback((tableId: string, tableHint?: Table | null, meta?: ContextItemMeta) => {
    const resolvedHint = tableHint && tableHint.id === tableId ? tableHint : null
    if (tableHint && !resolvedHint) {
      log.warn('打开表格时 tableHint 与表格 ID 不一致，已忽略', {
        tableId,
        tableHintId: tableHint.id,
      })
    }
    const table = resolvedHint || tableMap?.get(tableId)
    if (table) {
      // ：org-only 表 space_id 为空，可在任意工作空间标签栈打开；
      // 仅当表仍挂在别的 Space 时才拒绝（历史数据）。
      const tableSpaceId = getTableSpaceId(table)
      if (tableSpaceId && tableSpaceId !== spaceId) {
        throw new Error(i18n.t('context:error.tableNotInSpace', { id: tableId }))
      }
    } else if (tableMap && tableMap.size > 0) {
      log.warn('打开表格时未在当前列表中找到，将继续打开', { tableId })
    }
    const title = typeof table?.name === 'string' ? table.name.trim() : ''
    openTableTabGuarded(storageKey, tableId, {
      meta,
      refreshSpaceId: spaceId,
      ...(title ? { title } : {}),
    })
  }, [spaceId, storageKey, tableMap])

  const openBrowserView = useCallback((crawlspaceId: string, viewId: string) => {
    if (!crawlspaceId) {
      log.warn('缺少 crawlspaceId，无法切换网页标签', { viewId })
      return
    }

    const nextKey = contextRegistry.buildTabKey('tabweb', viewId)
    logTabSwitch('openBrowserView:start', {
      spaceId,
      crawlspaceId,
      viewId,
      nextKey,
    })

    void activateBrowserView(crawlspaceId, viewId, {
      spaceId,
      selection: { tabScopeKey: storageKey, tabKey: nextKey },
    })
      .then((result) => {
        logTabSwitch('openBrowserView:done', { spaceId, viewId, result })
      })
      .catch((error) => {
        log.error('切换网页标签异常:', error)
      })
  }, [logTabSwitch, spaceId, storageKey])

  /**
   * 关闭浏览器视图：只销毁 crawlspace view（IPC + 本地 cache），
   * 不改 activeKey / tabOrder — 这些由 useCloseHandlers 统一回退。
   *
   * 历史：这里曾经在关闭活动 tabweb 时 `setActiveKey(spaceId, null)` 做乐观切 home，
   * 但 null 会让 shouldShowCanvasGroup 变 false，导致关闭 canvas 分组内的浏览器标签
   * 整个画布消失，且覆盖了 useCloseHandlers 计算的 survivor fallback。
   * BrowserPaneRenderer 通过 isActive/enabled 自行处理销毁期的过渡态，无需上层切 home。
   */
  const closeBrowserView = useCallback(async (crawlspaceId: string, viewId: string) => {
    log.debug('closeBrowserView', { crawlspaceId, viewId, seeds: seedManager.getSeeds(crawlspaceId).length })

    const closeResult = await closeCrawlspaceView(crawlspaceId, viewId)
    if (closeResult.ok) return closeResult

    const message = closeResult.message || i18n.t('error.closeWebTabFailed', { ns: 'context' })
    log.error('关闭网页标签失败:', { crawlspaceId, viewId, code: closeResult.code, message })
    toast({
      title: i18n.t('error.closeWebTabFailed', { ns: 'context' }),
      description: message,
      variant: 'destructive',
    })
    const error: Error & { code?: string } = new Error(message)
    error.code = closeResult.code
    throw error
  }, [closeCrawlspaceView])

  const createWebTab = useCallback(async (url?: string) => {
    if (pendingActionRef.current === 'createWebTab') {
      log.warn('创建网页标签操作正在进行中，跳过重复调用')
      return null
    }

    const actionId = ++actionSeqRef.current
    const prevKey = getActiveKeyNow()
    pendingActionRef.current = 'createWebTab'

    let nextKey: string | null = null
    try {
      const crawlspace = ensureScopedCrawlspace(spaceId, storageKey, { title: spaceName })
      const crawlspaceId = crawlspace.id
      const ipcAdapter = createElectronIpcAdapter(crawlspaceId, spaceId)
      const viewId = `view-${crawlspaceId}-${Date.now()}`
      nextKey = contextRegistry.buildTabKey('tabweb', viewId)

      const targetUrl = url || 'about:blank'
      const created = await ipcAdapter.createView(
        viewId,
        targetUrl,
        undefined,
        url ? undefined : i18n.t('label.newTab', { ns: 'context' }),
      )
      if (!created) {
        throw new Error(i18n.t('error.createWebTabFailed', { ns: 'context' }))
      }

      const result = await activateBrowserView(crawlspaceId, viewId, {
        spaceId,
        selection: { tabScopeKey: storageKey, tabKey: nextKey },
      })
      if (!result.ok) {
        throw new Error(result.message || i18n.t('error.switchWebTabFailed', { ns: 'context' }))
      }
      if (result.code === 'cancelled' || result.code === 'superseded') {
        throw new Error(i18n.t('error.switchWebTabFailed', { ns: 'context' }))
      }

      log.debug('createWebTab done', { crawlspaceId, viewId, seeds: seedManager.getSeeds(crawlspaceId).length })

      return { crawlspaceId, viewId }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t('error.createWebTabFailed', { ns: 'context' })
      log.error('创建网页标签失败，回滚状态:', error)
      const currentKey = getActiveKeyNow()
      if (nextKey && actionSeqRef.current === actionId && currentKey === nextKey) {
        setActiveKey(storageKey, prevKey)
      }
      toast({
        title: i18n.t('error.createWebTabFailed', { ns: 'context' }),
        description: message,
        variant: 'destructive',
      })
      return null
    } finally {
      pendingActionRef.current = null
    }
  }, [ensureScopedCrawlspace, getActiveKeyNow, setActiveKey, spaceId, spaceName, storageKey])

  /**
   * 打开嵌入式 Web App 标签（marketplace embeddedWeb 类 App 的通用入口）。
   * 与 createWebTab 共用 crawlspace 基础设施，但 tab type 为 appId，
   * 产品上作为独立 App 呈现。
   */
  const openEmbeddedWebApp = useCallback(async (appId: string) => {
    if (pendingActionRef.current === `openEmbeddedApp:${appId}`) {
      log.warn('嵌入式 App 打开操作正在进行中，跳过重复调用: %s', appId)
      return null
    }

    const handler = contextRegistry.getHandler(appId as ContextItemType)
    const embeddedConfig = handler?.embeddedWeb
    if (!embeddedConfig?.baseUrl) {
      log.error('openEmbeddedWebApp: handler 未声明 embeddedWeb.baseUrl: %s', appId)
      return null
    }

    const prevKey = getActiveKeyNow()
    pendingActionRef.current = `openEmbeddedApp:${appId}`

    let nextKey: string | null = null
    let viewId = ''
    let crawlspaceIdForRollback = ''
    let viewCreated = false
    try {
      const crawlspace = ensureScopedCrawlspace(spaceId, storageKey, { title: spaceName })
      crawlspaceIdForRollback = crawlspace.id
      const ipcAdapter = createElectronIpcAdapter(crawlspaceIdForRollback, spaceId)
      viewId = `view-${crawlspaceIdForRollback}-${Date.now()}`
      nextKey = contextRegistry.buildTabKey(appId as ContextItemType, viewId)
      const appTitle = handler?.displayLabel || appId

      useSpaceContextTabsStore.getState().openResourceTab(storageKey, {
        type: appId as ContextItemType,
        id: viewId,
        title: appTitle,
        meta: { spaceId, crawlspaceId: crawlspaceIdForRollback, url: embeddedConfig.baseUrl, embeddedAppId: appId },
      })

      const created = await ipcAdapter.createView(
        viewId,
        embeddedConfig.baseUrl,
        undefined,
        appTitle,
        embeddedConfig.sessionMode,
      )
      if (!created) {
        throw new Error(i18n.t('error.createWebTabFailed', { ns: 'context' }))
      }
      viewCreated = true

      const result = await crawlspaceContextClient.setActiveView(crawlspaceIdForRollback, viewId)
      if (!result?.success) {
        throw new Error(result?.error || i18n.t('error.switchWebTabFailed', { ns: 'context' }))
      }

      log.debug('openEmbeddedWebApp done: %s', appId, { crawlspaceId: crawlspaceIdForRollback, viewId })
      return { crawlspaceId: crawlspaceIdForRollback, viewId }
    } catch (error) {
      const message = error instanceof Error ? error.message : i18n.t('error.createWebTabFailed', { ns: 'context' })
      log.error('打开嵌入式 App 失败，回滚状态: %s', appId, error)
      if (viewCreated) {
        void closeCrawlspaceView(crawlspaceIdForRollback, viewId).catch((err: unknown) => {
          log.warn('openEmbeddedWebApp rollback close view failed', err)
        })
      }
      if (nextKey) {
        useSpaceContextTabsStore.getState().closeTab(storageKey, nextKey, prevKey ?? undefined)
      }
      toast({
        title: i18n.t('error.createWebTabFailed', { ns: 'context' }),
        description: message,
        variant: 'destructive',
      })
      return null
    } finally {
      pendingActionRef.current = null
    }
  }, [closeCrawlspaceView, ensureScopedCrawlspace, getActiveKeyNow, spaceId, spaceName, storageKey])

  /**
   * 🖥️ 创建新终端标签
   */
  const createTerminal = useCallback(() => {
    return createTerminalSessionInScope({ spaceId, storageKey })
  }, [spaceId, storageKey])

  /**
   * 🖥️ 打开已存在的终端标签
   */
  const openTerminal = useCallback((sessionId: string) => {
    openTerminalTabInScope(storageKey, sessionId)
  }, [storageKey])

  /**
   * 通用资源标签打开 — 由 handler.getTabLabel 提供默认标题
   * 所有 persist-only 类型的入口，新增 App 无需修改此函数
   */
  const openResource = useCallback((type: ContextItemType, id: string, title?: string, meta?: Record<string, unknown>) => {
    const handler = contextRegistry.getHandler(type)
    if (handler?.onSelect) {
      const tabKey = contextRegistry.buildTabKey(type, id)
      const dispatched = contextRegistry.dispatchSelect(
        { type, id, tabKey, title, meta: { spaceId, ...meta } },
        { spaceId, tabScopeKey: storageKey, closeBrowserView: () => {} },
      )
      // 云盘/侧栏使用独立的 tab scope。注册 handler 可能只在主 Space
      // 上接管选择，dispatch 失败时必须回退到通用资源标签，否则创建成功后
      // 资源会留在列表里但不会打开任何文档标签。
      if (dispatched) return
    }
    const storeTitle = useSpaceContextTabsStore.getState()
      .itemsBySpace[storageKey]?.[contextRegistry.buildTabKey(type, id)]?.title
    const stubItem: ContextItem = { type, id, tabKey: contextRegistry.buildTabKey(type, id) }
    const resolvedTitle = title || storeTitle || handler?.getTabLabel?.(stubItem) || id

    openResourceTabGuarded(storageKey, {
      type,
      id,
      title: resolvedTitle,
      meta: { spaceId, ...meta },
    }, spaceId)
  }, [spaceId, storageKey])

  /**
   * 🛠️ 打开 Agent 管理标签页（替代原设置弹窗）
   */
  const openSpaceSettings = useCallback((section?: string) => {
    openResource(
      'tabsettings',
      spaceId,
      getSpaceSettingsTitle(spaceId),
      section ? { section } : undefined,
    )
  }, [spaceId, openResource])

  const openAppHome = useCallback((appId: string, meta?: Record<string, unknown>) => {
    const model = resolveAppHomeTabModel(appId)
    openResource('apphome', appId, model.title, {
      appId,
      labelKey: model.labelKey,
      displayLabel: model.displayLabel,
      displayEmoji: model.displayEmoji,
      ...meta,
    })
  }, [openResource])

  const openSlide = useCallback((slideId: string, title?: string) => {
    openResource('tabslide', slideId, title)
  }, [openResource])

  const openSite = useCallback((siteId: string, title?: string) => {
    openResource('tabsite', siteId, title)
  }, [openResource])

  const openDocument = useCallback((documentId: string, title?: string, meta?: Record<string, unknown>) => {
    openResource('tabdoc', documentId, title, meta)
  }, [openResource])

  /**
   * 打开代码项目标签（特殊处理：base64 编码路径作为 ID，path 存入 meta）
   */
  const openCodeProject = useCallback((localPath: string) => {
    const id = btoa(unescape(encodeURIComponent(localPath)))
    const title = localPath.split('/').filter(Boolean).pop() || 'Code'
    openResource('tabcode', id, title, { path: localPath })
  }, [openResource])

  return {
    openHome,
    openTable,
    openBrowserView,
    closeBrowserView,
    createWebTab,
    openEmbeddedWebApp,
    createTerminal,
    openTerminal,
    openSpaceSettings,
    openAppHome,
    openResource,
    openSlide,
    openSite,
    openDocument,
    openCodeProject,
  }
}
