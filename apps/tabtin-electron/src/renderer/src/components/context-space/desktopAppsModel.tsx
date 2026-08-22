import React, { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { TFunction } from 'i18next'
import { contextRegistry } from './registry'
// 从 leaf 模块 instance 取 homeSectionRegistry，避免与 homeRegistry →
// homeSections/desktopApps.tsx → DesktopAppsPane → 本模块 的循环依赖（见
// desktopAppsConstants.ts 的 TDZ 说明）。section 注册由 './registry'（index）
// 经 apphome handler 传递触发，早于本模块任何 hook 执行。
import { homeSectionRegistry } from './registry/instance'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import type { AppInfo } from '@stores/useSpaceApps'
import type { AppSurface } from '@stores/useOrganizationAppCatalog'

// 常量来自不参与 registry 循环依赖的 leaf 模块；此处统一 re-export 保持既有引用路径。
export {
  DESKTOP_APPS_HOME_ID,
  TABFOLDER_HOME_ID,
  PINNED_APPS_STORAGE_KEY,
  MAX_PINNED_DESKTOP_APPS,
} from './desktopAppsConstants'
import {
  PINNED_APPS_STORAGE_KEY,
  MAX_PINNED_DESKTOP_APPS,
} from './desktopAppsConstants'
import {
  getManifestDistribution,
  getManifestOrder,
  resolveSectionFromManifest,
} from './desktopAppsCatalog'

/**
 * 默认置顶名单。现有 manifest catalog 字段（category / desktopGroup / canCreate /
 * searchable / isDefaultEnabled / order）无法无损表达该名单（按「协作组 +
 * isDefaultEnabled + order 前 N」推导会得到 tabslide/tabvideo 而非 tabtracker），
 * 在不发明新 catalog 概念的前提下保留显式配置。
 * TODO: manifest catalog 增加置顶表达后迁移。
 *
 * 云盘（cloud-resources）仍在任务模式「更多」/侧栏置顶露出；#7160 只收敛主导航
 * 「云文档」域的文件入口（见 CLOUD_DOCS_SHOW_DRIVE），不藏任务侧云盘。
 */
const DEFAULT_PINNED_APP_IDS = ['cloud-resources', 'tabdata', 'tabdoc']
export const DESKTOP_RAIL_EXCLUDED_APP_IDS = new Set(['tabtracker'])

// 置顶列表由「更多应用」面板、桌面主页、左侧栏三处共享。若各自用组件本地 state，
// 一处 pin/unpin 不会通知另一处（例如面板点置顶、侧栏不刷新）。这里改成订阅同一份
// localStorage 的外部 store：写入即广播，所有消费方通过 useSyncExternalStore 同步更新。
const PINNED_APPS_CHANGED_EVENT = 'tabtin:desktop-pinned-apps-changed'

const DESKTOP_APP_GROUP_ORDER = [
  'collaborative',
  'local',
  'other',
] as const

const DESKTOP_APP_GROUP_LABEL_KEYS: Record<string, string> = {
  collaborative: 'desktop.group.collaborative',
  local: 'desktop.group.local',
  other: 'desktop.group.other',
}

const DESKTOP_APP_GROUP_FALLBACK_LABELS: Record<string, string> = {
  collaborative: '协作应用',
  local: '单机应用',
  other: '其他',
}

/**
 * 7/10 上线保障名单（2026-07-05 口径）——**manifest 缺失 / 无法回答时的分组兜底**。
 *
 * 分组第一优先级是 manifest `catalog.desktopGroup`（见 desktopAppsCatalog.ts）；
 * 本名单只兜三种情况：repo 内无 manifest（skill、远端安装 app）、manifest 未声明
 * desktopGroup、desktopGroup 属于未映射组（capabilities，组内语义混杂）。
 * 名单内 app 的最终分组被 desktopAppsModel.guarantee.test.tsx 锁死为与 7/10
 * 现状一致——改这里或改映射表前先看那份 snapshot 测试。
 */
export const GUARANTEED_COLLABORATIVE_APP_IDS = new Set([
  'cloud-resources',
  'tabdata',
  'tabdoc',
  'tabtracker',
  'skill',
])

export const GUARANTEED_STANDALONE_APP_IDS = new Set([
  'tabfolder',
])

/**
 * 不在「更多应用」总览展示（仍可通过侧栏/其他入口使用）。
 * manifest catalog 没有「隐藏于总览」的表达（不发明新概念），保留显式配置。
 * TODO: manifest catalog 支持展示面声明后迁移。
 */
export const DESKTOP_APPS_EXCLUDED_IDS = new Set([
  'tabfiles',
  'tabcode',
  // 产品确认下架（2026-07-08），勿随 manifest catalog 升组
  //（其 manifest 声明 desktopGroup=cloudResources，会被升进协作组）。
  'tabsite',
  // 产品确认：暂不在「更多应用」总览露出（未达交付态 / 入口收敛）
  'tabslide',
  'marketplace',
  // ：技能入口迁到任务侧栏「技能库」，应用门不再重复露出。
  'skill',
])

/** 7/10 保障：浏览器、终端等内置本机能力，与 tabfolder 同归「单机应用」。 */
export const GUARANTEED_BUILTIN_APP_IDS = new Set([
  'tabweb',
  'terminal',
])

/**
 * distribution 兜底（仅用于卡片标签，不参与分组）。
 * 常规 app 的 distribution 已由 manifest（getManifestDistribution）提供；
 * 这里只兜 repo 内无 manifest 的平台功能项。
 */
const KNOWN_APP_DISTRIBUTION_FALLBACK: Record<string, string> = {
  skill: 'builtin',
}

export interface DesktopAppEntry {
  id: string
  label: string
  icon: React.ReactNode
  mode: 'home' | 'create'
  groupId: string
  /** 安装来源（manifest distribution）；卡片标签仅区分内置 / 应用市场，不再展示协作等 surface 标签。 */
  distribution?: string
  /** 组内排序权重（manifest catalog.order）；缺失排组内末尾。 */
  order?: number
}

// 聚合/虚拟项不进后端 app-catalog（无法 join 到 surface），在构造处显式归类为协作。
const VIRTUAL_COLLABORATIVE_APP_IDS = new Set(['cloud-resources'])

export interface DesktopAppGroup {
  id: string
  label: string
  entries: DesktopAppEntry[]
}

/**
 * 「更多应用」分组解析（ P3）：
 * 1. manifest `catalog.desktopGroup`（经映射表，第一优先）；
 * 2. 7/10 保障名单兜底（manifest 缺失 / desktopGroup 未声明 / 属未映射组）；
 * 3. 一律「其他」。
 */
function groupForApp(appId: string): string {
  const manifestSection = resolveSectionFromManifest(appId)
  if (manifestSection) return manifestSection
  if (GUARANTEED_COLLABORATIVE_APP_IDS.has(appId)) return 'collaborative'
  if (GUARANTEED_STANDALONE_APP_IDS.has(appId) || GUARANTEED_BUILTIN_APP_IDS.has(appId)) return 'local'
  return 'other'
}

function parsePinnedRaw(raw: string | null): string[] {
  if (!raw) return DEFAULT_PINNED_APP_IDS
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_PINNED_APP_IDS
    return parsed.filter((id): id is string => (
      typeof id === 'string' &&
      id.length > 0 &&
      !DESKTOP_RAIL_EXCLUDED_APP_IDS.has(id)
    ))
  } catch {
    return DEFAULT_PINNED_APP_IDS
  }
}

// useSyncExternalStore 要求「底层未变时 getSnapshot 返回同一引用」，否则会无限重渲染。
// 缓存上次读到的 raw 与解析结果，raw 不变就复用同一数组引用。
let cachedPinnedRaw: string | null | undefined
let cachedPinnedValue: string[] = DEFAULT_PINNED_APP_IDS

function readPinnedAppIds(): string[] {
  if (typeof window === 'undefined') return DEFAULT_PINNED_APP_IDS
  let raw: string | null
  try {
    raw = window.localStorage.getItem(PINNED_APPS_STORAGE_KEY)
  } catch {
    return DEFAULT_PINNED_APP_IDS
  }
  if (raw === cachedPinnedRaw) return cachedPinnedValue
  cachedPinnedRaw = raw
  cachedPinnedValue = parsePinnedRaw(raw)
  return cachedPinnedValue
}

function savePinnedAppIds(ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PINNED_APPS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // localStorage may be unavailable in hardened shells.
  }
  // 同窗口内原生 storage 事件不会自发，主动广播让本窗口的所有订阅方立即刷新。
  window.dispatchEvent(new Event(PINNED_APPS_CHANGED_EVENT))
}

function subscribePinnedAppIds(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(PINNED_APPS_CHANGED_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(PINNED_APPS_CHANGED_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

/**
 * 「更多应用」总览项。展示过滤仍看后端 `surface`（技能等为 null 需跳过）；
 * 卡片标签只看 `distribution`（内置 / 应用市场），不再展示协作类 surface 标签。
 *
 * @param spaceApps 当前 Space 的后端 app 列表；未就绪时传 undefined。
 */
export function useDesktopAppEntries(
  t: TFunction<'context'>,
  spaceApps?: AppInfo[],
): DesktopAppEntry[] {
  return useMemo(() => {
    const surfaceByAppId = new Map<string, AppSurface | null>()
    const distributionByAppId = new Map<string, string>()
    for (const app of spaceApps ?? []) {
      surfaceByAppId.set(app.id, app.surface ?? null)
      if (app.distribution) distributionByAppId.set(app.id, app.distribution)
    }
    const resolveSurface = (appId: string): AppSurface | null | undefined => {
      if (VIRTUAL_COLLABORATIVE_APP_IDS.has(appId)) return 'collaborative'
      return surfaceByAppId.get(appId)
    }

    const map = new Map<string, DesktopAppEntry>()
    const add = (entry: DesktopAppEntry) => {
      if (!map.has(entry.id)) map.set(entry.id, entry)
    }

    // 任务模式「更多」/桌面应用目录：云盘入口常驻（完整上传/挂载/文件夹能力）。
    //  对「云文档」主域的文件收敛见 CLOUD_DOCS_SHOW_DRIVE，不作用于此处。
    add({
      id: 'cloud-resources',
      label: t('home.cloudDrive', { defaultValue: '云盘' }),
      icon: <TabTypeEmoji appIdOrType="cloud-resources" />,
      mode: 'home',
      groupId: groupForApp('cloud-resources'),
      distribution: 'builtin',
      // 虚拟聚合项无 manifest，显式给最小权重保持组内第一。
      order: 0,
    })
    for (const handler of contextRegistry.getAppEntries()) {
      const appId = handler.appId ?? (handler.type as string)
      if (DESKTOP_APPS_EXCLUDED_IDS.has(appId)) continue
      const surface = resolveSurface(appId)
      const isGuaranteed = GUARANTEED_COLLABORATIVE_APP_IDS.has(appId)
        || GUARANTEED_STANDALONE_APP_IDS.has(appId)
        || GUARANTEED_BUILTIN_APP_IDS.has(appId)
      if (surface === null && !isGuaranteed) continue
      const label = t(`appName.${appId}`, { defaultValue: handler.displayLabel || appId })
      const icon = <TabTypeEmoji appIdOrType={appId} />
      // ：panel 类 App 若没有 apphome 渲染面（homeSection / sidebarPanel），
      // 说明其面板是独立 tab 类型（如 tabphone → TabPhonePaneHost），走 'home' 会
      // 打开一个只显示标题的死页面——入口应直接走 createHandlers 打开面板。
      const isPanelWithoutAppHome = handler.appEntryMode === 'panel'
        && !homeSectionRegistry.has(appId)
        && !handler.sidebarPanel
      add({
        id: appId,
        label,
        icon,
        mode: handler.appEntryMode === 'create' || isPanelWithoutAppHome ? 'create' : 'home',
        groupId: groupForApp(appId),
        distribution: distributionByAppId.get(appId)
          ?? getManifestDistribution(appId)
          ?? KNOWN_APP_DISTRIBUTION_FALLBACK[appId],
        order: getManifestOrder(appId),
      })
    }

    // 产品确认：暂不在「更多应用」总览露出「市场」入口（与 DESKTOP_APPS_EXCLUDED_IDS 对齐）。
    // 硬编码 add 不走上方 handler 循环的 continue，故在此注释保留，便于日后恢复。
    // add({
    //   id: 'marketplace',
    //   label: t('marketplace.title', { defaultValue: '市场' }),
    //   icon: <SidebarTypeIcon appIdOrType="marketplace" />,
    //   mode: 'home',
    //   groupId: groupForApp('marketplace'),
    // })

    return Array.from(map.values())
  }, [t, spaceApps])
}

export function useGroupedDesktopAppEntries(
  appEntries: DesktopAppEntry[],
  t: TFunction<'context'>,
): DesktopAppGroup[] {
  return useMemo(() => {
    const byGroup = new Map<string, DesktopAppEntry[]>()
    for (const entry of appEntries) {
      const groupId = entry.groupId || 'other'
      if (!byGroup.has(groupId)) byGroup.set(groupId, [])
      byGroup.get(groupId)!.push(entry)
    }
    // 组内按 manifest catalog.order 升序；缺 order 的（无 manifest 项）排组内末尾，
    // 同权重保持注册顺序（Array#sort 稳定排序）。
    for (const entries of byGroup.values()) {
      entries.sort(
        (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
      )
    }
    const orderedGroups = [
      ...DESKTOP_APP_GROUP_ORDER.filter(groupId => byGroup.has(groupId)),
      ...Array.from(byGroup.keys()).filter(
        groupId => !DESKTOP_APP_GROUP_ORDER.includes(groupId as typeof DESKTOP_APP_GROUP_ORDER[number]),
      ),
    ]
    return orderedGroups.map(groupId => ({
      id: groupId,
      label: t(DESKTOP_APP_GROUP_LABEL_KEYS[groupId] ?? 'desktop.group.other', {
        defaultValue: DESKTOP_APP_GROUP_FALLBACK_LABELS[groupId] ?? groupId,
      }),
      entries: byGroup.get(groupId) ?? [],
    }))
  }, [appEntries, t])
}

export function usePinnedDesktopAppIds() {
  const pinnedAppIds = useSyncExternalStore(
    subscribePinnedAppIds,
    readPinnedAppIds,
    () => DEFAULT_PINNED_APP_IDS,
  )

  const pinApp = useCallback((appId: string): string | null => {
    const current = readPinnedAppIds()
    if (current.includes(appId)) return null
    const next = [...current, appId]
    let removedAppId: string | null = null
    if (next.length > MAX_PINNED_DESKTOP_APPS) {
      removedAppId = next.shift() ?? null
    }
    savePinnedAppIds(next)
    return removedAppId
  }, [])

  const unpinApp = useCallback((appId: string) => {
    const current = readPinnedAppIds()
    if (!current.includes(appId)) return
    savePinnedAppIds(current.filter(id => id !== appId))
  }, [])

  return { pinnedAppIds, pinApp, unpinApp }
}
