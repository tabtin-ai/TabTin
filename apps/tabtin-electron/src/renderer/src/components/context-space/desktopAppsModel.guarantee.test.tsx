/**
 * 7/10 上线保障名单分组 snapshot（ P3 验收红线）。
 *
 * 锁住 2026-07-05 口径：保障名单内每个 app 在「更多应用」最终分组中**必然出现**，
 * 且分组与上线现状完全一致。分组数据源重构（硬编码集合 → manifest catalog 驱动）
 * 前后本测试都必须保持绿——名单外的 app 允许跟随 manifest 变化，名单内的不允许。
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { useDesktopAppEntries } from './desktopAppsModel'
import type { AppInfo } from '@stores/useSpaceApps'

vi.mock('./registry/instance', () => ({
  homeSectionRegistry: {
    has: (appId: string) => ['tabdoc', 'tabdata'].includes(appId),
    get: vi.fn(),
  },
}))

// 模拟真实 handler 注册面：覆盖保障名单全部 app + 名单外对照项。
vi.mock('./registry', () => ({
  contextRegistry: {
    getAppEntries: () => [
      { type: 'tabweb', appId: 'tabweb', appEntryMode: 'resources', displayLabel: 'Browser' },
      { type: 'tabdata', appId: 'tabdata', appEntryMode: 'resources', displayLabel: 'Tables' },
      { type: 'tabdoc', appId: 'tabdoc', appEntryMode: 'resources', displayLabel: 'Docs' },
      { type: 'skill', appId: 'skill', appEntryMode: 'panel', displayLabel: 'Skills', sidebarPanel: true },
      { type: 'tabtracker', appId: 'tabtracker', appEntryMode: 'panel', displayLabel: 'Tracker', sidebarPanel: true },
      { type: 'tabfolder', appId: 'tabfolder', appEntryMode: 'resources', displayLabel: 'Directories' },
      { type: 'terminal', appId: 'terminal', appEntryMode: 'create', displayLabel: 'Terminal' },
      // 名单外对照：分组不受本 snapshot 锁定，但不允许「消失」以外的异常。
      { type: 'tabslide', appId: 'tabslide', appEntryMode: 'resources', displayLabel: 'Slides' },
      // repo 里没有 manifest 的远端安装 app：只能靠兜底逻辑归组。
      { type: 'remote-only-app', appId: 'remote-only-app', appEntryMode: 'resources', displayLabel: 'Remote' },
      // 已下架 app（2026-07-08）：即使 handler 被注册，也必须被 DESKTOP_APPS_EXCLUDED_IDS
      // 拦下，不得随 manifest catalog（desktopGroup=cloudResources）升进协作组。
      { type: 'tabsite', appId: 'tabsite', appEntryMode: 'resources', displayLabel: 'Sites' },
    ],
  },
}))

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction<'context'>

function makeApp(id: string, surface: AppInfo['surface'], distribution?: string): AppInfo {
  return { id, name: id, icon: '', can_create: false, searchable: false, enabled: true, order: 0, surface, distribution }
}

/**
 * 7/10 保障名单 → 分组现状（desktopAppsModel 2026-07-05 口径）。
 */
const JULY10_GUARANTEED_GROUPS: Record<string, 'collaborative' | 'local'> = {
  'cloud-resources': 'collaborative',
  tabdata: 'collaborative',
  tabdoc: 'collaborative',
  tabtracker: 'collaborative',
  // skill 已迁任务侧栏「技能库」，不再出现在「更多应用」总览。
  tabfolder: 'local',
  tabweb: 'local',
  terminal: 'local',
}

const spaceAppsFixture: AppInfo[] = [
  makeApp('tabweb', 'builtin', 'builtin'),
  makeApp('tabdata', 'collaborative', 'builtin'),
  makeApp('tabdoc', 'collaborative', 'builtin'),
  makeApp('skill', null),
  makeApp('tabtracker', 'collaborative', 'builtin'),
  makeApp('tabfolder', 'builtin', 'builtin'),
  makeApp('terminal', 'builtin', 'builtin'),
  makeApp('tabslide', 'collaborative', 'builtin'),
  makeApp('remote-only-app', 'collaborative', 'marketplace'),
  // 已下架 app：即使后端也下发（surface=collaborative），同样不得出现。
  makeApp('tabsite', 'collaborative', 'builtin'),
]

describe('7/10 保障名单分组 snapshot（验收红线）', () => {
  it('spaceApps 就绪时：名单内每个 app 必然出现且分组与现状一致', () => {
    const { result } = renderHook(() => useDesktopAppEntries(t, spaceAppsFixture))
    const byId = new Map(result.current.map((entry) => [entry.id, entry]))

    for (const [appId, expectedGroup] of Object.entries(JULY10_GUARANTEED_GROUPS)) {
      expect(byId.has(appId), `保障名单 app「${appId}」必须出现在最终分组中`).toBe(true)
      expect(byId.get(appId)?.groupId, `保障名单 app「${appId}」分组必须与 7/10 现状一致`).toBe(expectedGroup)
    }
  })

  it('spaceApps 未就绪（undefined）时：名单内 app 同样必然出现且分组一致', () => {
    const { result } = renderHook(() => useDesktopAppEntries(t, undefined))
    const byId = new Map(result.current.map((entry) => [entry.id, entry]))

    for (const [appId, expectedGroup] of Object.entries(JULY10_GUARANTEED_GROUPS)) {
      expect(byId.has(appId), `保障名单 app「${appId}」必须出现在最终分组中`).toBe(true)
      expect(byId.get(appId)?.groupId, `保障名单 app「${appId}」分组必须与 7/10 现状一致`).toBe(expectedGroup)
    }
  })

  it('repo 无 manifest、又不在保障名单的 app 落「其他」组，不消失', () => {
    const { result } = renderHook(() => useDesktopAppEntries(t, spaceAppsFixture))
    const byId = new Map(result.current.map((entry) => [entry.id, entry]))

    expect(byId.get('remote-only-app')?.groupId).toBe('other')
  })

  it('已下架的 tabsite 不得出现在任何分组（产品确认下架 2026-07-08）', () => {
    for (const spaceApps of [spaceAppsFixture, undefined]) {
      const { result } = renderHook(() => useDesktopAppEntries(t, spaceApps))
      expect(
        result.current.some((entry) => entry.id === 'tabsite'),
        'tabsite 已下架，不得随 manifest catalog 升进协作组出现在应用面板',
      ).toBe(false)
    }
  })

  it('产品确认暂藏的入口不得出现在「更多应用」总览', () => {
    const hiddenIds = [
      'tabslide',
      'marketplace',
      'skill',
    ]
    for (const spaceApps of [spaceAppsFixture, undefined]) {
      const { result } = renderHook(() => useDesktopAppEntries(t, spaceApps))
      for (const appId of hiddenIds) {
        expect(
          result.current.some((entry) => entry.id === appId),
          `${appId} 已从「更多应用」总览隐藏`,
        ).toBe(false)
      }
    }
  })
})
