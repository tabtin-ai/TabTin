/** @store-category domain */

/**
 * Organization 应用目录 Store
 *
 * 从后端 GET /organizations/{id}/app-catalog 获取全量应用列表（CORE_APPS + MARKETPLACE_APPS），
 * 在内存中执行搜索和分类过滤。
 *
 * marketplace app 分两种安装粒度（安装均先走后端 API 落 OrganizationAppInstall 记录）：
 * - installScope=organization：后端 install/uninstall API 管理全生命周期
 * - installScope=device：后端落记录 + 客户端本地下载/移除二进制
 */

import { joinApiPath } from '@tabtin/config'
import { create } from 'zustand'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { registerResetAction } from './sessionResetRegistry'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { electronFetch } from '@/services/electronFetch'
import { createLogger } from '@/utils/logger'
import type { AppIconAssetDescriptor } from '@/types/appIcon'
import type { AppSurface } from './appSurface'

export type { AppSurface } from './appSurface'

const log = createLogger('OrganizationAppCatalog')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 应用形态（三态分类 SSOT）。真源在后端 manifest 的 `surface` 字段，
 * 由 app-catalog / space apps API 暴露。前端只做派生展示，不再维护硬编码 ID 表。
 */
export interface CatalogApp {
  id: string
  name: string
  icon: string
  icon_asset?: AppIconAssetDescriptor | null
  description: string
  detail_description: string
  screenshots: string[]
  category: string
  source: 'builtin' | 'marketplace' | 'core'
  install_scope?: 'device' | 'organization'
  /** 三态分类真源；技能包等未声明为 null/undefined */
  surface?: AppSurface | null
  installed: boolean | null
  is_default_enabled: boolean
  order: number
  version: string | null
  installable?: boolean
}

export interface CatalogCategory {
  id: string
  name: string
  count: number
}

interface OrganizationAppCatalogState {
  /** 全量应用列表（后端一次性返回） */
  apps: CatalogApp[]
  categories: CatalogCategory[]
  canManage: boolean
  isLoading: boolean
  error: string | null

  /** 本地筛选状态 */
  searchQuery: string
  selectedCategory: string
  expandedAppId: string | null

  /** 正在安装/卸载中的 App ID（供 UI 展示 loading 态） */
  installingAppId: string | null
  uninstallingAppId: string | null
}

interface OrganizationAppCatalogActions {
  loadCatalog: (organizationId: string) => Promise<void>
  installApp: (organizationId: string, appId: string) => Promise<boolean>
  uninstallApp: (organizationId: string, appId: string) => Promise<{ affected_spaces: number }>
  setSearchQuery: (query: string) => void
  setSelectedCategory: (category: string) => void
  setExpandedAppId: (appId: string | null) => void
  reset: () => void
  getFilteredApps: () => CatalogApp[]
}

type OrganizationAppCatalogStore = OrganizationAppCatalogState & OrganizationAppCatalogActions

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getAuthHeaders = (): HeadersInit => {
  const token = useAuthStore.getState().accessToken
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function catalogApiRequest<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<{ data: T | null; error: string | null; status: number }> {
  try {
    const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `${url}`), {
      headers: getAuthHeaders(),
      ...options,
    })
    const json = await resp.json().catch(() => null)

    if (!resp.ok) {
      const errorMsg = json?.message || json?.detail || `HTTP ${resp.status}`
      return { data: null, error: errorMsg, status: resp.status }
    }

    return { data: json?.data ?? json, error: null, status: resp.status }
  } catch (error) {
    log.error('API request failed:', { url, error })
    return {
      data: null,
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    }
  }
}

function filterApps(
  apps: CatalogApp[],
  searchQuery: string,
  selectedCategory: string,
): CatalogApp[] {
  let filtered = apps

  if (selectedCategory && selectedCategory !== 'all') {
    filtered = filtered.filter((app) => app.category === selectedCategory)
  }

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase()
    filtered = filtered.filter(
      (app) =>
        (app.name ?? '').toLowerCase().includes(q) ||
        (app.description ?? '').toLowerCase().includes(q),
    )
  }

  return filtered
}

/**
 * 统一应用市场的「协作」分区数据源：只保留后端标记 surface==='collaborative' 的应用。
 * 内置（builtin）属「更多应用」总览、本机（local）走 personalPluginMarketplaceClient，
 * 均不进本市场。分类完全吃后端 surface，不再依赖前端硬编码 ID 表。
 */
function filterCollaborativeApps(apps: CatalogApp[]): CatalogApp[] {
  return apps.filter((app) => app.surface === 'collaborative')
}

function categoriesForProductApps(
  apps: CatalogApp[],
  categories: CatalogCategory[],
): CatalogCategory[] {
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]))
  const counts = new Map<string, number>()
  for (const app of apps) counts.set(app.category, (counts.get(app.category) ?? 0) + 1)
  const backendOrder = categories
    .map((category) => category.id)
    .filter((id) => id !== 'all' && counts.has(id))
  const remaining = Array.from(counts.keys())
    .filter((id) => !backendOrder.includes(id))
    .sort((left, right) => left.localeCompare(right))

  return [
    {
      id: 'all',
      name: categoryNames.get('all') ?? i18n.t('settings:appCatalog.categories.all', { defaultValue: 'All' }),
      count: apps.length,
    },
    ...[...backendOrder, ...remaining]
      .map((id) => ({
        id,
        name: categoryNames.get(id) ?? id,
        count: counts.get(id) ?? 0,
      })),
  ]
}

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

const initialState: OrganizationAppCatalogState = {
  apps: [],
  categories: [],
  canManage: false,
  isLoading: false,
  error: null,
  searchQuery: '',
  selectedCategory: 'all',
  expandedAppId: null,
  installingAppId: null,
  uninstallingAppId: null,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** 递增请求序号，防止旧请求覆盖新 Organization 数据 */
let _loadRequestSeq = 0

export const useOrganizationAppCatalog = create<OrganizationAppCatalogStore>(
  (set, get) => ({
    ...initialState,

    loadCatalog: async (organizationId: string) => {
      const seq = ++_loadRequestSeq
      set({ isLoading: true, error: null })

      const { data, error } = await catalogApiRequest<{
        apps: CatalogApp[]
        categories: CatalogCategory[]
        can_manage: boolean
      }>(API_ENDPOINTS.ORGANIZATION.APP_CATALOG(organizationId))

      if (seq !== _loadRequestSeq) return

      if (error || !data) {
        set({
          isLoading: false,
          error: error || i18n.t('settings:appCatalog.loadFailed'),
        })
        return
      }

      const apps = filterCollaborativeApps(data.apps ?? [])

      set({
        apps,
        categories: categoriesForProductApps(apps, data.categories ?? []),
        canManage: data.can_manage ?? false,
        isLoading: false,
        error: null,
      })
    },

    installApp: async (organizationId: string, appId: string) => {
      const { apps } = get()
      const targetApp = apps.find(a => a.id === appId)
      const isDeviceScope = targetApp?.install_scope === 'device'

      const prevApps = apps
      set({
        installingAppId: appId,
        apps: apps.map((app) =>
          app.id === appId ? { ...app, installed: true } : app,
        ),
      })

      try {
        // 所有 marketplace app 都在后端落 OrganizationAppInstall 记录
        const { data, error } = await catalogApiRequest<{
          app_id: string
          installed: boolean
        }>(API_ENDPOINTS.ORGANIZATION.APP_INSTALL(organizationId, appId), {
          method: 'POST',
        })
        if (error || !data?.installed) throw new Error(error || 'Install failed')

        // device 级 app 额外下载本地二进制
        if (isDeviceScope) {
          const manifest = await catalogApiRequest<Record<string, unknown>>(
            API_ENDPOINTS.ORGANIZATION.APP_CATALOG(organizationId) + `/${appId}/manifest`,
          )
          if (manifest.data) {
            await window.tabtin!.marketplace.installApp(appId, manifest.data)
          }
        }

        set({ installingAppId: null })
        toast.success(i18n.t('settings:appCatalog.installSuccess'))
        invalidateSpaceAppsCache(organizationId)
        return true
      } catch (err) {
        set({ installingAppId: null, apps: prevApps })
        toast.error(i18n.t('settings:appCatalog.installFailed'))
        log.error('Install failed:', { organizationId, appId, err })
        return false
      }
    },

    uninstallApp: async (organizationId: string, appId: string) => {
      const { apps } = get()
      const targetApp = apps.find(a => a.id === appId)
      const isDeviceScope = targetApp?.install_scope === 'device'
      const fallbackResult = { affected_spaces: 0 }

      const prevApps = apps
      set({
        uninstallingAppId: appId,
        apps: apps.map((app) =>
          app.id === appId ? { ...app, installed: false } : app,
        ),
      })

      try {
        const { data, error } = await catalogApiRequest<{
          app_id: string
          uninstalled: boolean
          affected_spaces?: number
        }>(API_ENDPOINTS.ORGANIZATION.APP_UNINSTALL(organizationId, appId), {
          method: 'POST',
        })
        if (error) throw new Error(error)
        const affectedSpaces = data?.affected_spaces ?? 0

        // device 级应用还需要清掉本机二进制；后端 Organization 安装记录同样必须删除，
        // 否则刷新目录后仍会显示已安装。
        if (isDeviceScope) {
          await window.tabtin!.marketplace.uninstallApp(appId)
        }

        set({ uninstallingAppId: null })
        toast.success(i18n.t('settings:appCatalog.uninstallSuccess', { count: affectedSpaces }))
        invalidateSpaceAppsCache(organizationId)
        return { affected_spaces: affectedSpaces }
      } catch (err) {
        set({ uninstallingAppId: null, apps: prevApps })
        toast.error(i18n.t('settings:appCatalog.uninstallFailed'))
        log.error('Uninstall failed:', { organizationId, appId, err })
        return fallbackResult
      }
    },

    setSearchQuery: (query: string) => {
      set({ searchQuery: query })
    },

    setSelectedCategory: (category: string) => {
      set({ selectedCategory: category })
    },

    setExpandedAppId: (appId: string | null) => {
      set({ expandedAppId: appId })
    },

    reset: () => {
      _loadRequestSeq++
      set(initialState)
    },

    getFilteredApps: () => {
      const { apps, searchQuery, selectedCategory } = get()
      return filterApps(apps, searchQuery, selectedCategory)
    },
  }),
)

// ---------------------------------------------------------------------------
// Cross-store integration
// ---------------------------------------------------------------------------

/**
 * 安装/卸载 Organization App 后，精确清除该 Organization 下的 Space Apps 缓存，
 * 确保 Space 侧边栏立即反映变更。延迟 import 避免循环依赖。
 */
function invalidateSpaceAppsCache(organizationId: string): void {
  try {
    const { useSpaceApps } = require('./useSpaceApps') as typeof import('./useSpaceApps')
    useSpaceApps.getState().invalidateByOrganization(organizationId)
  } catch (err) {
    log.warn('Failed to invalidate space apps cache', { organizationId, err })
  }
}

// ---------------------------------------------------------------------------
// Session reset registration
// ---------------------------------------------------------------------------

registerResetAction('organization-app-catalog', 'reset', () =>
  useOrganizationAppCatalog.getState().reset(),
)
