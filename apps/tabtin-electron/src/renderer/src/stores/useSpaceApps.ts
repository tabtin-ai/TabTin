/** @store-category domain */

/**
 * Space APP 管理 Store
 *
 * 从后端 GET /workspaces/{id}/apps 获取核心 APP 列表及启用状态。
 * 管理 Workspace 级 APP 启用状态与配置（；原 /spaces/.../apps 已 410）。
 *
 */
import { joinApiPath } from '@tabtin/config'
import { create } from 'zustand'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import { useSpaceStore } from '@tabtin/app-shell'
import { registerGenericEmbeddedWebHandlers } from '@/components/context-space/registry'
import type { AppSurface } from './appSurface'
import { createLogger } from '@/utils/logger'
import type { AppIconAssetDescriptor } from '@/types/appIcon'

const log = createLogger('SpaceApps')

export interface AppInfo {
  id: string
  name: string
  icon: string
  icon_asset?: AppIconAssetDescriptor | null
  can_create: boolean
  searchable: boolean
  enabled: boolean
  order: number
  // ui_contract（后端 additive 下发，旧版后端不含这些字段）
  desktop_group?: string
  category?: string
  context_type?: string | null
  ui_runtime?: string
  distribution?: string
  install_scope?: string
  /**
   * 三态分类真源（builtin/local/collaborative），来自后端 manifest 的 `surface`，
   * 由 GET /workspaces/{id}/apps 下发；技能包等未声明为 null。前端只做派生展示。
   */
  surface?: AppSurface | null
  embedded_web?: {
    baseUrl: string
    urlPatterns: string[]
    sessionMode: string
  } | null
  context_url_field?: string
  /** device 级 app 本地二进制是否就绪（仅 install_scope=device 时有意义） */
  _localReady?: boolean
}

type SpaceAppMap = Record<string, AppInfo[]>
type DisabledAppMap = Record<string, string[]>

export const EMPTY_APPS: AppInfo[] = []
export const EMPTY_DISABLED_APPS: string[] = []

export interface SpaceAppsState {
  /** spaceId → APP 列表 */
  appsBySpace: SpaceAppMap
  /** spaceId → disabled_apps */
  disabledBySpace: DisabledAppMap
  /** 正在加载的 Space */
  loadingSpaces: Set<string>

  loadSpaceApps: (spaceId: string) => Promise<void>
  updateDisabledApps: (spaceId: string, disabledApps: string[]) => Promise<void>
  isAppEnabled: (spaceId: string, appId: string) => boolean
  getEnabledApps: (spaceId: string) => AppInfo[]
  getCreatableApps: (spaceId: string) => AppInfo[]
  /**
   * 清除指定 Organization 下所有 Space 的缓存 apps 数据。
   * 在 Organization 应用卸载后由 useOrganizationAppCatalog 调用，
   * 确保下次访问 Space 时重新从后端拉取（拉取结果已不含被卸载的 app）。
   */
  invalidateByOrganization: (organizationId: string) => void
  reset: () => void
}

async function fetchSpaceApps(spaceId: string): Promise<{ apps: AppInfo[]; disabled_apps: string[] }> {
  const token = await getAuthToken()
  // spaceId 实为 Workspace.id（id 复用）；走 WORKSPACE 路径，避免 /spaces 410。
  const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WORKSPACE.APP_SETTINGS(spaceId)}`)
  const response = await apiRequest({
    url,
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  // Electron adapter returns an HTTP response object, while Django wraps payloads
  // in { success, data }. Normalize both layers here.
  const raw = response?.data ?? response
  const data = raw?.data ?? raw
  return {
    apps: data?.apps ?? [],
    disabled_apps: data?.disabled_apps ?? [],
  }
}

async function putDisabledApps(spaceId: string, disabledApps: string[]): Promise<{ apps: AppInfo[]; disabled_apps: string[] }> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, `${API_ENDPOINTS.WORKSPACE.APP_SETTINGS(spaceId)}`)
  const response = await apiRequest({
    url,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ disabled_apps: disabledApps }),
  })
  // Keep PUT parsing consistent with GET: unwrap HTTP response + Django envelope.
  const raw = response?.data ?? response
  const data = raw?.data ?? raw
  return {
    apps: data?.apps ?? [],
    disabled_apps: data?.disabled_apps ?? [],
  }
}

const SPACE_APPS_TTL_MS = 5 * 60_000
const _spaceAppsLoadedAt = new Map<string, number>()

export const useSpaceApps = create<SpaceAppsState>((set, get) => {
  const loadSpaceApps = async (spaceId: string) => {
    const state = get()
    if (state.loadingSpaces.has(spaceId)) return
    const cachedAt = _spaceAppsLoadedAt.get(spaceId)
    if (state.appsBySpace[spaceId] && cachedAt && Date.now() - cachedAt < SPACE_APPS_TTL_MS) return
    const nextLoadingSpaces = new Set([...state.loadingSpaces, spaceId])
    set({
      appsBySpace: state.appsBySpace,
      disabledBySpace: state.disabledBySpace,
      loadingSpaces: nextLoadingSpaces,
    })

    try {
      const { apps, disabled_apps } = await fetchSpaceApps(spaceId)
      _spaceAppsLoadedAt.set(spaceId, Date.now())
      registerGenericEmbeddedWebHandlers(apps)

      // 对 device 级 app 补充本地二进制就绪状态
      try {
        const localInstalled = (await window.tabtin?.marketplace.listInstalled()) as Record<string, unknown> | null
        if (localInstalled) {
          for (const app of apps) {
            if (app.install_scope === 'device') {
              ;(app as any)._localReady = app.id in localInstalled
            }
          }
        }
      } catch {
        // best-effort: IPC 不可用时不标记 ready 状态
      }

      set((prev) => {
        return {
          appsBySpace: { ...prev.appsBySpace, [spaceId]: apps },
          disabledBySpace: { ...prev.disabledBySpace, [spaceId]: disabled_apps },
          loadingSpaces: new Set([...prev.loadingSpaces].filter(id => id !== spaceId)),
        }
      })

      const discoveryPatterns = apps
        .filter(app => app.embedded_web?.urlPatterns?.length)
        .map(app => ({
          appId: app.id,
          appName: app.name,
          patterns: app.embedded_web!.urlPatterns,
        }))
      // 即便空数组也要推送：本 sourceId=spaceId 在主进程 patternsBySource 中可能
      // 残留上一次进入该 Space 时的旧 patterns（或与 marketplace-api source 合并），
      // 不推送会让"切换到无 marketplace App 的 Space"时旧条目永久挂在内存。
      window.tabtin?.appDiscovery.updatePatterns(discoveryPatterns, spaceId)
    } catch (error) {
      log.error('loadSpaceApps failed:', { spaceId, error })
      set((prev) => {
        return {
          loadingSpaces: new Set([...prev.loadingSpaces].filter(id => id !== spaceId)),
        }
      })
    }
  }

  const updateDisabledApps = async (spaceId: string, disabledApps: string[]) => {
    try {
      const { apps, disabled_apps } = await putDisabledApps(spaceId, disabledApps)
      set((prev) => {
        return {
          appsBySpace: { ...prev.appsBySpace, [spaceId]: apps },
          disabledBySpace: { ...prev.disabledBySpace, [spaceId]: disabled_apps },
        }
      })
    } catch (error) {
      log.error('updateDisabledApps failed:', { spaceId, error })
    }
  }

  return {
    appsBySpace: {},
    disabledBySpace: {},
    loadingSpaces: new Set(),
    loadSpaceApps,
    updateDisabledApps,
    isAppEnabled: (spaceId, appId) => {
      const apps = get().appsBySpace[spaceId]
      if (!apps) return true
      const app = apps.find(a => a.id === appId)
      return app?.enabled ?? true
    },
    getEnabledApps: (spaceId) => {
      const apps = get().appsBySpace[spaceId] ?? []
      return apps.filter(a => a.enabled)
    },
    getCreatableApps: (spaceId) => {
      const apps = get().appsBySpace[spaceId] ?? []
      return apps.filter(a => a.enabled && a.can_create)
    },

    invalidateByOrganization: (organizationId: string) => {
      const spaces = useSpaceStore.getState().spaces
      const targetSpaceIds = new Set(
        spaces.filter((s) => s.organization_id === organizationId).map((s) => s.id),
      )
      if (targetSpaceIds.size === 0) return

      set((prev) => {
        const newAppsBySpace = { ...prev.appsBySpace }
        const newDisabledBySpace = { ...prev.disabledBySpace }
        const newLoadingSpaces = new Set(prev.loadingSpaces)
        for (const spaceId of targetSpaceIds) {
          delete newAppsBySpace[spaceId]
          delete newDisabledBySpace[spaceId]
          newLoadingSpaces.delete(spaceId)
          _spaceAppsLoadedAt.delete(spaceId)
        }
        return {
          appsBySpace: newAppsBySpace,
          disabledBySpace: newDisabledBySpace,
          loadingSpaces: newLoadingSpaces,
        }
      })
    },

    reset: () => {
      _spaceAppsLoadedAt.clear()
      set({ appsBySpace: {}, disabledBySpace: {}, loadingSpaces: new Set() })
    },
  }
})

import { registerResetAction } from './sessionResetRegistry'
registerResetAction('space-apps', 'reset', () => useSpaceApps.getState().reset())

/**
 * 订阅指定 App 的启用状态，状态变化时触发组件重渲染。
 *
 * 与 `useSpaceApps(s => s.isAppEnabled)(spaceId, appId)` 不同：
 * 后者返回稳定的函数引用，appsBySpace 变化时组件不会重渲染。
 * 本 hook 的 selector 直接返回 boolean，确保启用/禁用切换能实时反映。
 */
export function useSpaceAppEnabled(spaceId: string, appId: string): boolean {
  return useSpaceApps((s) => {
    const apps = s.appsBySpace[spaceId]
    if (!apps) return true
    return apps.find((a) => a.id === appId)?.enabled ?? true
  })
}
