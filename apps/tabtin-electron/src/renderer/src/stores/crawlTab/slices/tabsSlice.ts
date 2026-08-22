/**
 * Tabs slice — createTab, createWorkspace, updateTab,
 * getSpaceCrawlspace, ensureSpaceCrawlspace, createTemporaryTab,
 * closeTemporaryTabs, clearAll.
 *
 * Extracted from useCrawlTabStore.ts for single-responsibility.
 *
 * # Partition 解析（本地化退役 Wave 2 之后）
 *
 * `createWorkspace` 的 partition 字段优先级：
 *   1. 调用方显式传入 `config.partition` → 直接使用（尊重上游）
 *   2. 调用方提供 `spaceId` → 走 `getPartitionForSpaceSync(spaceId)`
 *      （`browserEnvSnapshot` 镜像，永远返回真实 partition string）
 *   3. 都没有 → throw（这条路径理论上不可达，硬守把假设兜住）
 *
 * 整个流程**同步**，不涉及 IPC、cache、pending 占位。镜像启动期未就绪
 * 时，`getPartitionForSpaceSync` 会返回默认 env partition；订阅 mirror
 * 事件后 workspace 的 partition 字段会被升级到最新值（用户改绑定 / 镜像
 * 首次加载完成都会触发）。
 *
 * # 与 Wave 1 之前的对比
 *
 * Wave 1 之前 renderer 有一整套 cache / prime / generation / LRU /
 * `_writePartitionHook` / pending 占位机制，因为云端 BES 启动期需要异步
 * 等 bootstrap，pending 期 cookie 不能落盘。本地化退役后这些都消失了，
 * renderer 直接信任主进程 BES 的同步真值。
 *
 * # 已知遗留（推到 Wave 3 解决）
 *
 * 启动期镜像未就绪时（< 几百毫秒）创建的 workspace partition 落到默认
 * env，主进程 view 创建后 partition 被焊死在 webContents.session 里。
 * 镜像加载完成后 listener 把 store 字段升级到正确 partition，但**主进程
 * 已创建的 view 不会自动重建** —— 后续切到该 view 会触发 `crawl-view:show`
 * 的 partition mismatch 检查。Wave 3 会把 partition mismatch 路径改成
 * "主动 destroy + 重建 + toast 提示"。本期在 listener 检测到 partition
 * 升级时打 warn 日志，便于 dogfood 期排查。
 */

import i18n from '@/i18n'
import { logger } from '@/utils/logger'
import { getAgentWorkspaceDefaults } from '../../../crawlspace/workspace-defaults'
import {
  DEFAULT_ENV_PARTITION,
  buildSessionPartition,
  ensureBrowserEnvSnapshotStarted,
  getPartitionForSpaceSync,
  subscribeBrowserEnvSnapshot,
} from '../../browserEnvSnapshot'
import type {
  CrawlTab,
  CrawlTabKind,
  CrawlTabMetadata,
  CrawlspaceConfig,
  CrawlspaceContextCache,
  CrawlspacePersistedViewSeed,
  CrawlspacePreviewState,
} from '../types'
import {
  ensureCrawlspaceContextSubscription,
  releaseAllCrawlspaceContextSubscriptions,
} from '../crawlspaceContextSubscriptionRegistry'

const MAX_PERSISTED_TABS = 30

const ENV_PARTITION_PREFIX = 'tabtin:env:'

/** 仅升级 `tabtin:env:*` 系列的 partition —— 显式传入的非 env partition 不被覆盖。 */
function isManagedEnvPartition(partition: string): boolean {
  return partition.startsWith(ENV_PARTITION_PREFIX)
}

/**
 * 模块级订阅句柄：listener 在镜像更新时同步升级 workspace config 的
 * partition 字段。createTabsActions 在整个 app 生命周期内只被调用一次
 * （zustand slice 单例），所以模块级是 OK 的。
 */
let _snapshotUnsubscribe: (() => void) | null = null

function ensureSnapshotSubscription(get: () => TabsStore, set: SetFn): void {
  if (_snapshotUnsubscribe) return
  _snapshotUnsubscribe = subscribeBrowserEnvSnapshot(() => {
    const current = get().crawlspaceConfigById
    let changed = false
    const next: Record<string, CrawlspaceConfig> = { ...current }
    for (const [csId, cfg] of Object.entries(current)) {
      const cfgSpaceId = cfg.spaceId ?? (cfg as { projectId?: string }).projectId
      if (!cfgSpaceId) continue
      if (!isManagedEnvPartition(cfg.partition)) continue
      const expected = getPartitionForSpaceSync(cfgSpaceId)
      if (cfg.partition === expected) continue
      // 升级 renderer state 后，下次 `crawl-view:show` 调用会带新 partition
      // 触发主进程 ipc-handlers `crawl-view:show` 的 partition mismatch 路径
      // 销毁旧 view + 用新 partition 重建（Wave 3 收尾）。dogfood 期看到这
      // 条 info 不算 bug，但每次启动都出现说明镜像加载延迟过大，需要 BES
      // 启动期排查。
      console.info(
        '[CrawlTabStore] workspace partition 升级 → 触发主进程 view 重建:',
        { crawlspaceId: csId, spaceId: cfgSpaceId, from: cfg.partition, to: expected },
      )
      next[csId] = { ...cfg, partition: expected }
      changed = true
    }
    if (!changed) return
    set((state) => {
      const tabs = state.tabs.map((t) => {
        if (t.kind !== 'workspace') return t
        const cfgBefore = t.metadata?.crawlspaceConfig
        if (!cfgBefore) return t
        const cfgSpaceId = cfgBefore.spaceId ?? (cfgBefore as { projectId?: string }).projectId
        if (!cfgSpaceId) return t
        if (!isManagedEnvPartition(cfgBefore.partition)) return t
        const expected = getPartitionForSpaceSync(cfgSpaceId)
        if (cfgBefore.partition === expected) return t
        return {
          ...t,
          metadata: {
            ...t.metadata,
            crawlspaceConfig: { ...cfgBefore, partition: expected },
          },
        }
      })
      return {
        crawlspaceConfigById: next,
        tabs,
      }
    })
  })
}

/** 仅测试用：解除模块级订阅（搭配 `__resetBrowserEnvSnapshotForTests`）。 */
export function __resetSpacePartitionCacheForTests(): void {
  try {
    _snapshotUnsubscribe?.()
  } catch {
    /* ignore */
  }
  _snapshotUnsubscribe = null
}

const SESSION_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

export interface TabsStore {
  tabs: CrawlTab[]
  crawlspacePreviewStates: Record<string, CrawlspacePreviewState>
  crawlspaceContextCache: Record<string, CrawlspaceContextCache>
  crawlspaceDeferredViewIdsByCS: Record<string, Set<string>>
  crawlspacePersistedViews: Record<string, CrawlspacePersistedViewSeed[]>
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  _coldStartPendingByCS: Record<string, boolean>
  _recentlyClosedViewIds: Set<string>
  deleteTab: (tabId: string) => void
  getSpaceCrawlspace?: (spaceId: string) => CrawlTab | null
  getScopedCrawlspace?: (scopeKey: string) => CrawlTab | null
  rehomeScopedCrawlspace?: (fromScopeKey: string, toScopeKey: string) => string | null
  createWorkspace?: (config: any) => CrawlTab
}

type GetFn = () => TabsStore
type SetFn = (
  partial: Partial<TabsStore> | ((state: TabsStore) => Partial<TabsStore>),
) => void

function sanitizeCrawlspaceIdPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96)
  return safe || 'unknown'
}

export function createTabsActions(get: GetFn, set: SetFn) {
  ensureBrowserEnvSnapshotStarted()
  ensureSnapshotSubscription(get, set)

  return {
    createTab: (url: string, name?: string, options?: {
      temporary?: boolean
      autoClose?: boolean
      id?: string
      skipAutoSelect?: boolean
      runId?: string
      kind?: CrawlTabKind
      legacy?: boolean
      metadata?: CrawlTabMetadata
    }): CrawlTab => {
      if (options?.metadata?.crawlspaceId) {
        throw new Error(i18n.t('crawl:tabStore.errors.workspaceViewInTabs'))
      }
      const resolvedKind: CrawlTabKind = options?.kind || (options?.temporary ? 'temporary' : 'normal')
      if (resolvedKind === 'workspace') {
        throw new Error(i18n.t('crawl:tabStore.errors.createTabWorkspaceNotAllowed'))
      }
      if (!options?.legacy && globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
        console.warn('[CrawlTabStore]', i18n.t('crawl:tabStore.warnings.legacyCreateTab'), {
          kind: resolvedKind, url
        })
      }
      const initialState = get()

      const shouldDeduplicate = resolvedKind === 'normal' && !options?.id && url.trim() !== ''
      if (shouldDeduplicate) {
        const existing = initialState.tabs.find(
          (tab) => tab.url === url && tab.kind === 'normal' && !tab.temporary
        )
        if (existing) {
          const nextTab: CrawlTab = {
            ...existing,
            name: name || existing.name,
            url,
            updatedAt: new Date()
          }
          set((state) => ({
            tabs: state.tabs.map((tab) => (tab.id === existing.id ? nextTab : tab)),
          }))
          return nextTab
        }
      }

      if (resolvedKind === 'normal') {
        const persistedTabs = initialState.tabs.filter(
          (tab) => !tab.temporary && tab.kind === 'normal'
        )
        if (persistedTabs.length >= MAX_PERSISTED_TABS) {
          const oldest = persistedTabs.reduce((acc, tab) =>
            tab.createdAt < acc.createdAt ? tab : acc
          )
          if (globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
            console.warn('[CrawlTabStore] Persisted tabs limit exceeded, removing oldest tab:', oldest.id)
          }
          get().deleteTab(oldest.id)
        }
      }

      const latestState = get()
      const now = new Date()
      const newTab: CrawlTab = {
        id: options?.id || `crawl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: name || i18n.t('crawl:tabs.defaultName', {
          count: latestState.tabs.filter((tab) => tab.kind === resolvedKind).length + 1
        }),
        url,
        createdAt: now,
        updatedAt: now,
        temporary: options?.temporary,
        autoClose: options?.autoClose,
        runId: options?.runId,
        kind: resolvedKind,
        metadata: options?.metadata
      }

      set((state) => ({
        tabs: [...state.tabs, newTab],
      }))

      return newTab
    },

    createWorkspace: (
      config: Omit<CrawlspaceConfig, 'crawlspaceId' | 'partition'> & {
        partition?: string
        crawlspaceId?: string
        sessionName?: string
      }
    ): CrawlTab => {
      if (!config?.profile) {
        throw new Error(i18n.t('crawl:tabStore.errors.createWorkspaceMissingProfile'))
      }
      // 调用方必须提供 spaceId 或显式 partition —— 否则 workspace 没有
      // session 隔离依据。已知调用路径均满足；这里硬 throw 让新增的
      // 不合法调用立即被发现。
      const spaceIdForGuard = config.spaceId ?? (config as { projectId?: string }).projectId
      if (!spaceIdForGuard && !config.partition) {
        throw new Error(i18n.t('crawl:tabStore.errors.createWorkspaceMissingSpaceOrPartition'))
      }

      const now = new Date()
      const crawlspaceId = config.crawlspaceId ||
        (globalThis.crypto?.randomUUID
          ? `cs-${globalThis.crypto.randomUUID()}`
          : (() => {
            throw new Error(i18n.t('crawl:tabStore.errors.createWorkspaceMissingRandomUUID'))
          })())

      const existing = get().tabs.find(tab => tab.id === crawlspaceId)
      if (existing) {
        throw new Error(i18n.t('crawl:tabStore.errors.createWorkspaceIdExists', { id: crawlspaceId }))
      }

      // 优先级：调用方显式 partition > 命名 session 独立隔离 partition >
      // spaceId 镜像查询 > 默认 env partition。
      //
      // BR-29：命名 session（`config.sessionName`）是隔离的浏览器身份，必须
      // 用独立 partition，绝不能落回 Space 的 env partition（会读到真实登录态
      // 的 Cookie）。session partition 由 crawlspaceId 推导、稳定可复用，且前缀
      // 非 `tabtin:env:` → 不被 `subscribeBrowserEnvSnapshot` listener 升级回
      // env partition，也不被 `CookieSyncService` 同步默认环境 Cookie。
      //
      // 非 session workspace 仍走原逻辑：镜像在 boot 期异步加载；首帧未就绪时
      // `getPartitionForSpaceSync` 返回默认 env partition，镜像就绪 / 用户改
      // 绑定后由 listener 升级到正确值。
      const partition =
        config.partition
        ?? (config.sessionName
          ? buildSessionPartition(crawlspaceId)
          : spaceIdForGuard
            ? getPartitionForSpaceSync(spaceIdForGuard)
            : DEFAULT_ENV_PARTITION)

      const crawlspaceConfig: CrawlspaceConfig = {
        crawlspaceId,
        ...(config.browserScopeKey ? { browserScopeKey: config.browserScopeKey } : {}),
        spaceId: spaceIdForGuard,
        pluginId: config.pluginId,
        pluginConfig: config.pluginConfig,
        uiConfig: config.uiConfig,
        profile: config.profile,
        partition,
        runPrefix: config.runPrefix,
        ...(config.sessionName ? { sessionName: config.sessionName } : {}),
        ...(config.sessionColor ? { sessionColor: config.sessionColor } : {}),
      }

      const newTab: CrawlTab = {
        id: crawlspaceId,
        name: config.uiConfig?.defaultTitle || config.pluginId || i18n.t('crawl:tabs.workspaceDefaultName'),
        url: '',
        createdAt: now,
        updatedAt: now,
        kind: 'workspace',
        metadata: { crawlspaceConfig }
      }

      set((state) => ({
        tabs: [...state.tabs, newTab],
        crawlspaceContextCache: {
          ...state.crawlspaceContextCache,
          [crawlspaceId]: { activeViewId: null, viewList: [] }
        },
        crawlspacePersistedViews: {
          ...state.crawlspacePersistedViews,
          [crawlspaceId]: []
        },
        crawlspaceConfigById: {
          ...state.crawlspaceConfigById,
          [crawlspaceId]: crawlspaceConfig
        }
      }))

      // 创建即订阅——避免"已 createWorkspace 但 CrawlspaceWorkspace 还未挂载"
      // 期间，Agent 工具（ContextSpaceToolHandler.list_context_space）/ 资源
      // 监控（resource-monitor.buildViewTitleById）等仅 cache 路径读到空数据。
      // ensureCrawlspaceContextSubscription 是幂等的——后续 CrawlspaceWorkspace
      // 挂载触发的 ensureCrawlspaceContextCache 不会重复订阅。
      // 注意调用时机：必须在 set(...) 之后——此时空 cache 已写入，registry
      // listener 收到首帧 snapshot 时不会撞 race。
      ensureCrawlspaceContextSubscription(crawlspaceId)

      return newTab
    },

    getSpaceCrawlspace: (spaceId: string): CrawlTab | null => {
      const state = get()
      return (
        state.tabs.find(
          tab =>
            tab.kind === 'workspace' &&
            !tab.metadata?.crawlspaceConfig?.sessionName &&
            !tab.metadata?.crawlspaceConfig?.browserScopeKey &&
            (tab.metadata?.crawlspaceConfig?.spaceId ?? tab.metadata?.crawlspaceConfig?.projectId) === spaceId
        ) || null
      )
    },

    getScopedCrawlspace: (scopeKey: string): CrawlTab | null => {
      const state = get()
      return (
        state.tabs.find(
          tab =>
            tab.kind === 'workspace' &&
            !tab.metadata?.crawlspaceConfig?.sessionName &&
            tab.metadata?.crawlspaceConfig?.browserScopeKey === scopeKey
        ) || null
      )
    },

    rehomeScopedCrawlspace: (fromScopeKey: string, toScopeKey: string): string | null => {
      if (!fromScopeKey || !toScopeKey || fromScopeKey === toScopeKey) return null
      const self = get() as TabsStore & {
        getScopedCrawlspace: (scopeKey: string) => CrawlTab | null
      }
      const source = self.getScopedCrawlspace(fromScopeKey)
      if (!source) return null
      const target = self.getScopedCrawlspace(toScopeKey)
      if (target && target.id !== source.id) return null
      const current = get()
      const config = current.crawlspaceConfigById[source.id] ?? source.metadata?.crawlspaceConfig
      if (!config) return null
      const rehomed = { ...config, browserScopeKey: toScopeKey }
      set(state => ({
        crawlspaceConfigById: { ...state.crawlspaceConfigById, [source.id]: rehomed },
        tabs: state.tabs.map(tab => tab.id === source.id
          ? { ...tab, metadata: { ...tab.metadata, crawlspaceConfig: rehomed } }
          : tab),
      }))
      return source.id
    },

    getNamedCrawlspace: (spaceId: string, sessionName: string): CrawlTab | null => {
      const state = get()
      return (
        state.tabs.find(
          tab =>
            tab.kind === 'workspace' &&
            tab.metadata?.crawlspaceConfig?.sessionName === sessionName &&
            (tab.metadata?.crawlspaceConfig?.spaceId ?? tab.metadata?.crawlspaceConfig?.projectId) === spaceId
        ) || null
      )
    },

    getSpaceSessionList: (spaceId: string): Array<{ sessionName: string; crawlspaceId: string }> => {
      const state = get()
      return state.tabs
        .filter(
          tab =>
            tab.kind === 'workspace' &&
            tab.metadata?.crawlspaceConfig?.sessionName &&
            (tab.metadata?.crawlspaceConfig?.spaceId ?? tab.metadata?.crawlspaceConfig?.projectId) === spaceId
        )
        .map(tab => ({
          sessionName: tab.metadata!.crawlspaceConfig!.sessionName!,
          crawlspaceId: tab.id,
        }))
    },

    ensureNamedCrawlspace: (spaceId: string, sessionName: string, options?: { title?: string; sessionColor?: string }): CrawlTab => {
      const self = get() as TabsStore & {
        getNamedCrawlspace: (id: string, name: string) => CrawlTab | null
        getSpaceSessionList: (id: string) => Array<{ sessionName: string; crawlspaceId: string }>
        createWorkspace: (config: any) => CrawlTab
      }
      const existing = self.getNamedCrawlspace(spaceId, sessionName)
      if (existing) {
        const config = existing.metadata?.crawlspaceConfig
        if (config && !get().crawlspaceConfigById[existing.id]) {
          set(state => ({
            crawlspaceConfigById: {
              ...state.crawlspaceConfigById,
              [existing.id]: config
            }
          }))
        }
        return existing
      }
      const defaults = getAgentWorkspaceDefaults()
      const shortSpaceId = spaceId.length > 8 ? spaceId.slice(0, 8) : spaceId
      const crawlspaceId = `cs-session-${shortSpaceId}-${sessionName}`
      const existingSessions = self.getSpaceSessionList(spaceId)
      const color = options?.sessionColor || SESSION_COLORS[existingSessions.length % SESSION_COLORS.length]
      return self.createWorkspace({
        spaceId,
        profile: defaults.profile,
        runPrefix: defaults.runPrefix,
        sessionName,
        sessionColor: color,
        crawlspaceId,
        uiConfig: {
          ...defaults.uiConfig,
          defaultTitle: options?.title || sessionName,
        },
        pluginConfig: {},
      })
    },

    ensureSpaceCrawlspace: (spaceId: string, options?: { title?: string }): CrawlTab => {
      const self = get() as TabsStore & {
        getSpaceCrawlspace: (id: string) => CrawlTab | null
        createWorkspace: (config: any) => CrawlTab
      }
      const existing = self.getSpaceCrawlspace(spaceId)
      if (existing) {
        const config = existing.metadata?.crawlspaceConfig
        if (config && !get().crawlspaceConfigById[existing.id]) {
          set(state => ({
            crawlspaceConfigById: {
              ...state.crawlspaceConfigById,
              [existing.id]: config
            }
          }))
        }
        return existing
      }
      const defaults = getAgentWorkspaceDefaults()
      return self.createWorkspace({
        spaceId: spaceId,
        profile: defaults.profile,
        runPrefix: defaults.runPrefix,
        uiConfig: {
          ...defaults.uiConfig,
          defaultTitle: options?.title || defaults.uiConfig?.defaultTitle
        },
        pluginConfig: {}
      })
    },

    ensureScopedCrawlspace: (spaceId: string, scopeKey: string, options?: { title?: string }): CrawlTab => {
      const self = get() as TabsStore & {
        getScopedCrawlspace: (key: string) => CrawlTab | null
        createWorkspace: (config: any) => CrawlTab
      }
      const normalizedScopeKey = scopeKey.trim() || spaceId
      const defaults = getAgentWorkspaceDefaults()
      const healConfig = (tab: CrawlTab): CrawlTab => {
        const metaConfig = tab.metadata?.crawlspaceConfig
        const stored = get().crawlspaceConfigById[tab.id] ?? metaConfig
        if (!stored) return tab

        const needsRehydrate = !get().crawlspaceConfigById[tab.id]
        const needsProfile = !stored.profile
        const needsPartition = !stored.partition
        if (!needsRehydrate && !needsProfile && !needsPartition) return tab

        const healed: CrawlspaceConfig = {
          ...stored,
          crawlspaceId: stored.crawlspaceId || tab.id,
          browserScopeKey: stored.browserScopeKey || normalizedScopeKey,
          spaceId: stored.spaceId || spaceId,
          profile: stored.profile || defaults.profile,
          partition:
            stored.partition
            || (spaceId ? getPartitionForSpaceSync(spaceId) : DEFAULT_ENV_PARTITION),
          runPrefix: stored.runPrefix || defaults.runPrefix,
        }
        set(state => ({
          crawlspaceConfigById: {
            ...state.crawlspaceConfigById,
            [tab.id]: healed,
          },
          tabs: state.tabs.map(candidate =>
            candidate.id === tab.id
              ? {
                  ...candidate,
                  metadata: {
                    ...candidate.metadata,
                    crawlspaceConfig: healed,
                  },
                  updatedAt: new Date(),
                }
              : candidate,
          ),
        }))
        return get().tabs.find(candidate => candidate.id === tab.id) ?? tab
      }

      const existing = self.getScopedCrawlspace(normalizedScopeKey)
      if (existing) {
        return healConfig(existing)
      }

      const crawlspaceId = `cs-scope-${sanitizeCrawlspaceIdPart(normalizedScopeKey)}`
      const orphanById = get().tabs.find(
        tab => tab.kind === 'workspace' && tab.id === crawlspaceId,
      )
      if (orphanById) {
        // 确定性 id 已存在但 browserScopeKey 对不上（持久化半残）时，写回 scope
        // 并愈合 profile/partition，避免 createWorkspace 因 id 冲突抛错。
        const base = orphanById.metadata?.crawlspaceConfig
        const patched: CrawlspaceConfig = {
          crawlspaceId,
          spaceId: base?.spaceId || spaceId,
          profile: base?.profile || defaults.profile,
          partition:
            base?.partition
            || (spaceId ? getPartitionForSpaceSync(spaceId) : DEFAULT_ENV_PARTITION),
          runPrefix: base?.runPrefix || defaults.runPrefix,
          browserScopeKey: normalizedScopeKey,
          ...(base?.pluginId ? { pluginId: base.pluginId } : {}),
          ...(base?.pluginConfig ? { pluginConfig: base.pluginConfig } : {}),
          ...(base?.uiConfig ? { uiConfig: base.uiConfig } : {}),
          ...(base?.sessionName ? { sessionName: base.sessionName } : {}),
          ...(base?.sessionColor ? { sessionColor: base.sessionColor } : {}),
        }
        set(state => ({
          crawlspaceConfigById: {
            ...state.crawlspaceConfigById,
            [orphanById.id]: patched,
          },
          tabs: state.tabs.map(candidate =>
            candidate.id === orphanById.id
              ? {
                  ...candidate,
                  metadata: { ...candidate.metadata, crawlspaceConfig: patched },
                  updatedAt: new Date(),
                }
              : candidate,
          ),
        }))
        return get().tabs.find(candidate => candidate.id === orphanById.id) ?? orphanById
      }

      return self.createWorkspace({
        spaceId,
        browserScopeKey: normalizedScopeKey,
        profile: defaults.profile,
        runPrefix: defaults.runPrefix,
        crawlspaceId,
        uiConfig: {
          ...defaults.uiConfig,
          defaultTitle: options?.title || defaults.uiConfig?.defaultTitle
        },
        pluginConfig: {}
      })
    },

    updateTab: (tabId: string, updates: Partial<CrawlTab>) => {
      set((state) => ({
        tabs: state.tabs.map(tab =>
          tab.id === tabId
            ? { ...tab, ...updates, updatedAt: new Date() }
            : tab
        ),
      }))
    },

    clearAll: () => {
      // 不重订阅 listener —— 模块级 `_snapshotUnsubscribe` 在整个 app 生命
      // 周期里只装一次，clearAll 仅清 store 数据；新账号挂载后 listener
      // 仍会用同一个 get/set 闭包工作（zustand store 单例）。
      // 🆕 Wave 3.1: 释放所有 crawlspace context 订阅；applier 保留，
      // 后续业务实体重建时由 ensureCrawlspaceContextCache 重新驱动。
      releaseAllCrawlspaceContextSubscriptions()
      set({
        tabs: [],
        crawlspacePreviewStates: {},
        crawlspaceContextCache: {},
        crawlspaceDeferredViewIdsByCS: {},
        crawlspacePersistedViews: {},
        crawlspaceConfigById: {},
        _coldStartPendingByCS: {},
        _recentlyClosedViewIds: new Set<string>(),
      })
      logger.log('Crawl tab data cleared')
    },

    createTemporaryTab: (url: string, name?: string): CrawlTab => {
      const self = get() as TabsStore & { createTab: (...args: any[]) => CrawlTab }
      return self.createTab(url, name || i18n.t('context:label.crawling'), {
        temporary: true,
        autoClose: true,
        kind: 'temporary',
        legacy: true
      })
    },

    closeTemporaryTabs: () => {
      const temporaryTabs = get().tabs.filter(tab => tab.temporary)
      temporaryTabs.forEach(tab => {
        get().deleteTab(tab.id)
      })
    },
  }
}
