import { useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpaceContextTabsStore } from '@/stores/useSpaceContextTabsStore'
import { useCanvasLayoutStore } from '@/stores/useCanvasLayoutStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useCrawlTabStore } from '@/stores/useCrawlTabStore'
import { useViewStore } from '@/stores/useViewStore'
import { contextRegistry } from '../../context-space/registry'
import { useSpaceContextNavigation } from '../../context-space/hooks/useSpaceContextNavigation'
import { resolveChatContextDisplay } from '../context/resolveChatContextDisplay'
import type { ContextItemType, ContextTabKey } from '../../context-space/registry/types'
import type { SpaceContext } from '../../context-space/SpaceContextContainer'
import type { Table, ViewStore } from '@tabtin/table-core'
import {
  buildFocusedSurfaceContextKey,
  useFocusedSurfaceStore,
  type FocusedSurface,
} from '@/stores/useFocusedSurfaceStore'

function resolveFocusedSurfaceTitle(surface: FocusedSurface): string {
  const root = surface.rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const file = surface.focusedFilePath?.replace(/\\/g, '/')
  if (file) {
    if (file.startsWith(`${root}/`)) return file.slice(root.length + 1)
    return file.split('/').filter(Boolean).pop() ?? file
  }
  return root.split('/').filter(Boolean).pop() ?? surface.rootPath
}

export function selectCrawlViewMetaDeps(
  state: ReturnType<typeof useCrawlTabStore.getState>,
  input: { activeContextType?: string | null; activeContextId?: string | null },
): string {
  const { activeContextType, activeContextId } = input
  if (!activeContextId) return ''
  const handler = activeContextType ? contextRegistry.getHandler(activeContextType) : null
  const metaDeps = handler?.appMeta?.metaDeps
  if (!metaDeps?.useCrawlViewUrl && !metaDeps?.useCrawlViewTitle) return ''

  for (const cache of Object.values(state.crawlspaceContextCache)) {
    const view = cache.viewList.find(v => v.viewId === activeContextId)
    if (!view) continue
    const parts: string[] = []
    if (metaDeps.useCrawlViewUrl) parts.push(view.url ?? '')
    if (metaDeps.useCrawlViewTitle) parts.push(view.title ?? '')
    return parts.join('|')
  }
  return ''
}

export interface UseChatPanelContextParams {
  selectedSpace: SpaceContext | null
  tabScopeKey?: string | null
  tables: Table[]
  variant: 'panel' | 'embedded'
}

export function useChatPanelContext({
  selectedSpace,
  tabScopeKey,
  tables,
  variant,
}: UseChatPanelContextParams) {
  const { t } = useTranslation('chat')
  const spaceId = selectedSpace?.id
  const storageKey = tabScopeKey || spaceId

  const activeContextKey = useSpaceContextTabsStore(state => {
    if (!storageKey) return null
    return state.activeKeyBySpace[storageKey] ?? null
  })

  const activeContextMeta = useMemo(() => {
    if (!activeContextKey) return null
    return contextRegistry.parseTabKey(activeContextKey)
  }, [activeContextKey])

  const activeContextType = activeContextMeta?.type ?? null
  const activeContextId = activeContextMeta?.id ?? null
  const activeTableId = activeContextMeta?.type === 'tabdata' ? activeContextMeta.id : null

  const spaceName = selectedSpace?.name

  const activeTable = useMemo(() => {
    if (!activeTableId) return null
    return tables.find(t => t.id === activeTableId) ?? null
  }, [activeTableId, tables])

  const activeTabItem = useSpaceContextTabsStore(
    useCallback((s) => {
      if (!storageKey || !activeContextKey) return null
      return s.itemsBySpace[storageKey]?.[activeContextKey] ?? null
    }, [storageKey, activeContextKey]),
  )

  const focusedSurfaceContextKey = buildFocusedSurfaceContextKey(storageKey, activeContextKey)
  const focusedSurface = useFocusedSurfaceStore(
    useCallback(
      state => focusedSurfaceContextKey
        ? state.byContextKey[focusedSurfaceContextKey]?.surface ?? null
        : null,
      [focusedSurfaceContextKey],
    ),
  )
  // `apphome:<appId>` 是应用首页的容器 Tab，真正的推荐场景是其 id（如
  // `apphome:tabdata` → `tabdata`），不能把抽象的 `apphome` 传给聊天面板。
  // 跨 Space 首页的 id 可能是复合值，此时以持久化 meta.appId 为准。
  const resolvedActiveContextType = activeContextType === 'apphome'
    ? (
      typeof activeTabItem?.meta?.appId === 'string'
        ? activeTabItem.meta.appId
        : activeContextMeta?.id ?? null
    )
    : activeContextType
  const agentContextType = focusedSurface?.appType ?? resolvedActiveContextType

  /** 通用 metaDeps 订阅：根据当前 handler 的声明式依赖自动订阅 store 变化 */
  const metaDepsTabKey = useSpaceContextTabsStore(
    useCallback((s) => {
      if (!storageKey || !activeContextType || !activeContextKey) return ''
      const handler = contextRegistry.getHandler(activeContextType as ContextItemType)
      const tabMetaKeys = handler?.appMeta?.metaDeps?.tabMetaKeys
      if (!tabMetaKeys?.length) return ''
      const meta = s.itemsBySpace[storageKey]?.[activeContextKey]?.meta
      if (!meta) return ''
      return tabMetaKeys.map(k => String(meta[k] ?? '')).join('|')
    }, [storageKey, activeContextType, activeContextKey]),
  )
  const metaDepsCrawlView = useCrawlTabStore(
    useCallback((state) => {
      return selectCrawlViewMetaDeps(state, {
        activeContextType,
        activeContextId,
      })
    }, [activeContextType, activeContextId]),
  )
  const metaDepsViewStoreId = useViewStore(
    // ViewStore 来自 createStoreHost 工厂，selector 类型签名是 `<R = T>(selector?: (state: T) => R)`
    // —— selector 可选，导致 useCallback 包裹时 TS 推断不出 state 类型，必须显式注解。
    // 其他 useSpaceContextTabsStore / useCrawlTabStore 走 zustand `create<T>`，
    // selector 必填所以推断成功。
    useCallback((state: ViewStore) => {
      if (!activeContextMeta?.id) return ''
      const handler = contextRegistry.getHandler(activeContextMeta.type as ContextItemType)
      if (!handler?.appMeta?.metaDeps?.useViewStoreId) return ''
      // 仅当 ViewStore 当前绑定在 active table 时才返回 viewId，避免别表残留
      return state.tableId === activeContextMeta.id ? (state.currentViewId ?? '') : ''
    }, [activeContextMeta?.type, activeContextMeta?.id]),
  )

  const activeAppMeta = useMemo<Record<string, any> | null>(() => {
    // 这三个 selector 是 handler 声明的跨 store 失效令牌；resolve() 会自行读取
    // 对应 store，因此这里只需消费令牌来触发重算。
    void metaDepsTabKey
    void metaDepsCrawlView
    void metaDepsViewStoreId
    if (!activeContextMeta) return null
    const { type, id } = activeContextMeta
    const appMeta = contextRegistry.getAppMeta(type as ContextItemType)
    const tabKey = activeContextKey
    const storedItem = activeTabItem

    let resolvedMeta: Record<string, any> | null = null
    if (appMeta?.resolve) {
      resolvedMeta = appMeta.resolve({
        type: type as ContextItemType,
        id,
        tabKey: (tabKey || `${type}:${id}`) as ContextTabKey,
        title: storedItem?.title,
        meta: storedItem?.meta,
      })
    } else if (appMeta) {
      resolvedMeta = { [appMeta.idField]: id }
      if (appMeta.titleField) {
        resolvedMeta[appMeta.titleField] = storedItem?.title || null
      }
    }

    if (!focusedSurface) return resolvedMeta

    if (focusedSurface.appType === 'tabcode') {
      return {
        ...(resolvedMeta ?? {}),
        current_code_project_path: focusedSurface.rootPath,
        current_code_file: focusedSurface.focusedFilePath,
      }
    }

    return {
      ...(resolvedMeta ?? {}),
      ...(resolvedMeta?.sandbox_path ? {} : { current_folder_path: focusedSurface.rootPath }),
      current_file_path: focusedSurface.focusedFilePath,
    }
  }, [
    activeContextMeta,
    activeContextKey,
    activeTabItem,
    metaDepsTabKey,
    metaDepsCrawlView,
    metaDepsViewStoreId,
    focusedSurface,
  ])

  const tabOrder = useSpaceContextTabsStore(
    useCallback((s) => storageKey ? s.tabOrderBySpace[storageKey] : undefined, [storageKey]),
  )
  const tabItems = useSpaceContextTabsStore(
    useCallback((s) => storageKey ? s.itemsBySpace[storageKey] : undefined, [storageKey]),
  )
  const activeTabKey = useSpaceContextTabsStore(
    useCallback((s) => storageKey ? s.activeKeyBySpace[storageKey] : undefined, [storageKey]),
  )
  const spaceGroups = useCanvasLayoutStore(
    useCallback((s) => storageKey ? s.spaceGroups[storageKey] : undefined, [storageKey]),
  )

  // PRD §4.3 红线 #6：openTabs 是 LLM 看到的"用户当前打开了哪些 tab"上下文，
  // 必须**单独过滤一次**（不能假设上层已过滤），否则会把别 session 的
  // subagent_session 也喂给 LLM，造成上下文入侵。
  const currentSessionId = useChatStore(s => s.currentSessionId)

  const openTabs = useMemo(() => {
    if (!spaceId) return null
    const order = tabOrder ?? []
    const items = tabItems ?? {}
    if (order.length === 0) return null

    const focusedKey = activeTabKey ?? null
    const groups = spaceGroups ?? []

    // 单独过滤一次：handler.isVisibleInContext 返回 false 的 tab 不进 openTabs。
    // 与 useTabSync 的 visibleTabKeys 同语义（接同一个 handler 钩子），但口径独立计算
    // 以保证"Agent 看到的 openTabs"与"UI 显示的 visibleTabKeys"永远一致。
    const visibilityCtx = { spaceId, currentSessionId }
    const isItemVisible = (type: string, item: typeof items[string] | null): boolean => {
      const handler = contextRegistry.getHandler(type)
      if (!handler?.isVisibleInContext) return true
      const ctxItem = item
        ? { type, id: item.id, tabKey: item.tabKey as ContextTabKey, title: item.title, meta: item.meta }
        : null
      if (!ctxItem) return true
      return handler.isVisibleInContext(ctxItem, visibilityCtx)
    }

    const tabKeyToGroup = new Map<string, { groupId: string; paneCount: number }>()
    for (const group of groups) {
      for (const pane of group.panes) {
        if (pane.content?.tabKey) {
          tabKeyToGroup.set(pane.content.tabKey, {
            groupId: group.id,
            paneCount: group.panes.filter(p => p.content?.tabKey).length,
          })
        }
      }
    }

    const resolveTab = (key: string) => {
      const item = items[key]
      const active = key === focusedKey
      const groupInfo = tabKeyToGroup.get(key)
      // 隐藏 tab 不进 openTabs（PRD §4.3 红线 #6）
      const parsedType = item?.type ?? contextRegistry.parseTabKey(key)?.type
      if (parsedType && !isItemVisible(parsedType, item ?? null)) return null
      // 两个分支都用同一个 shape（title 可选），让下面 P4.1 fallback 能统一访问
      // base.title 而不必做 narrow。
      let base: { type: string; id: string; title?: string } | null = item
        ? { type: item.type, id: item.id, title: item.title }
        : (() => {
            const parsed = contextRegistry.parseTabKey(key)
            return parsed ? { type: parsed.type, id: parsed.id, title: undefined } : null
          })()
      if (!base) return null

      // P4.1（2026-05-14）：title 缺失兜底——deep link / 历史 tab restore 等
      // 路径下 SpaceContextTabsStore 里的 title 可能还没 hydrate，导致 LLM
      // 看到「多维表「未命名」(id: ff35df32)」而不是真实表名。这里反查对应
      // handler 的 resolveTabItem 拿到 store 里的实时标题。
      //
      // 性能注释（R4.1 review 后维持当前实现）：browser.tsx 的 resolveTabItem
      // 是 O(crawlspaces × views) 查找；这里 N tab × O(handler 内部) 在 useMemo
      // 热路径。但 short-circuit `!base.title` 保证正常 hydration 后零调用——
      // 只在 deep link / restore 短暂窗口触发，且 N=缺 title 的 tab 数通常 ≤ 2。
      // 实测可接受；未来若触发率高（dev mode 计数器观察）再做 handler 内部
      // Map 缓存。
      if (!base.title && spaceId) {
        const handler = contextRegistry.getHandler(base.type)
        if (handler?.resolveTabItem) {
          try {
            const resolved = handler.resolveTabItem(base.id, {
              spaceId,
              tabKey: key as ContextTabKey,
              persistedItem: item ?? null,
            })
            if (resolved?.title) base = { ...base, title: resolved.title }
          } catch { /* resolveTabItem 内部异常不应拖累 context block 装配 */ }
        }
      }
      const meta = item?.meta as Record<string, any> | undefined
      const extra: Record<string, any> = {}
      if (meta?.path) extra.path = meta.path
      if (meta?.kind) extra.kind = meta.kind
      if (meta?.url) extra.url = meta.url
      if (meta?.session_id) extra.session_id = meta.session_id

      if (active && focusedSurface) {
        return {
          type: focusedSurface.appType,
          id: focusedSurface.rootPath,
          title: resolveFocusedSurfaceTitle(focusedSurface),
          active: true,
          ...(groupInfo ? { group_id: groupInfo.groupId } : {}),
          path: focusedSurface.focusedFilePath ?? focusedSurface.rootPath,
          app_key: focusedSurface.appType,
          display_name: contextRegistry.getAgentDisplayName(focusedSurface.appType),
        }
      }

      // ── Agent-facing 字段（2026-05-14 重构）────────────────────
      //
      // 旧 context-injector 在 main 进程靠 case-by-case 处理 type / appType，对
      // apphome 还要二次推断「这是 X App 的首页」。renderer 这里**直接预解析**
      // 把 Agent 看到的语义字段填好，让 main 进程零 case-switch 渲染：
      //
      //   - app_key：真正的 App 类型（apphome 的话取 meta.appId）
      //   - display_name：Agent 跟用户对话用的中文名（"多维表" 等）
      //   - is_home：是否是该 App 的首页（resource list / launcher 页）
      //
      // 兼容：app_home 字段保留（旧 schema 消费者继续可用）。
      const isHome = base.type === 'apphome'
      const appKey = isHome && typeof meta?.appId === 'string' ? meta.appId : base.type
      if (isHome && typeof meta?.appId === 'string') extra.app_home = meta.appId
      extra.app_key = appKey
      extra.display_name = contextRegistry.getAgentDisplayName(appKey)
      if (isHome) extra.is_home = true

      return {
        ...base,
        active,
        ...(groupInfo ? { group_id: groupInfo.groupId } : {}),
        ...(Object.keys(extra).length > 0 ? extra : {}),
      }
    }

    return order.map(resolveTab).filter(Boolean) as Array<{
      type: string; id: string; title?: string; active?: boolean; group_id?: string
      path?: string; kind?: string; url?: string; session_id?: string; app_home?: string
      app_key?: string; display_name?: string; is_home?: boolean
    }>
  }, [spaceId, tabOrder, tabItems, activeTabKey, spaceGroups, currentSessionId, focusedSurface])

  const {
    createWebTab,
    createTerminal,
  } = useSpaceContextNavigation({
    spaceId: spaceId || '__unknown__',
    tabScopeKey: storageKey,
    spaceName: spaceName,
    tables,
  })

  // PRD v3.1 修订：detached → 主窗工作台开 subagent_session tab 的 IPC listener
  // 已迁到 `components/app/AppChatSync.tsx`（主窗专属、永远存活的窗口级单例），
  // 避免之前挂在 ChatPanel 里因 detach / Space 切换 / hot-Space cleanup 反复销毁
  // 导致 detached drill-in 主窗没人接的问题。此处不再注册 listener。

  const targetGraphType = useMemo<'chat' | null>(() => {
    if (variant === 'embedded') {
      return spaceId ? 'chat' : null
    }
    if (activeContextType === 'tabdata' && activeTableId) {
      return 'chat'
    }
    if (activeContextType === 'tabweb') {
      return 'chat'
    }
    if (spaceId && !activeContextKey) {
      return 'chat'
    }
    return null
  }, [activeContextType, activeTableId, activeContextKey, spaceId, variant])

  const contextDisplay = useMemo(() => {
    return resolveChatContextDisplay({
      activeContextKey,
      activeContextType: agentContextType,
      activeTable,
      activeAppMeta,
      activeTabTitle: activeTabItem?.title ?? null,
      activeTabMeta: activeTabItem?.meta,
      spaceName,
      t,
    })
  }, [
    activeContextKey,
    agentContextType,
    activeTable,
    activeAppMeta,
    activeTabItem?.title,
    activeTabItem?.meta,
    spaceName,
    t,
  ])

  return {
    activeContextKey,
    activeContextMeta,
    activeContextType: agentContextType,
    activeTableId,
    activeTable,
    activeAppMeta,
    openTabs,
    createWebTab,
    createTerminal,
    targetGraphType,
    contextDisplay,
  }
}
