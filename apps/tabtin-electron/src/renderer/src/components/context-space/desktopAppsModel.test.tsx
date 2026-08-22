import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import {
  DESKTOP_APPS_EXCLUDED_IDS,
  GUARANTEED_BUILTIN_APP_IDS,
  GUARANTEED_COLLABORATIVE_APP_IDS,
  GUARANTEED_STANDALONE_APP_IDS,
  useDesktopAppEntries,
} from './desktopAppsModel'
import type { AppInfo } from '@stores/useSpaceApps'

  // 分组第一优先读 manifest catalog.desktopGroup（desktopAppsCatalog 不 mock，
  // 直接吃真实 packages/apps/*/app.json）；保障名单只兜 manifest 无法回答的项。
  // 卡片标签只看 distribution。
vi.mock('./registry/instance', () => ({
  homeSectionRegistry: {
    has: (appId: string) => ['tabdoc', 'tabslide'].includes(appId),
    get: vi.fn(),
  },
}))

vi.mock('./registry', () => ({
  contextRegistry: {
    getAppEntries: () => [
      { type: 'tabweb', appId: 'tabweb', appEntryMode: 'create', displayLabel: 'Browser', displayEmoji: '🌐' },
      { type: 'cowart', appId: 'cowart', appEntryMode: 'resources', displayLabel: 'Cowart', displayEmoji: '🐮' },
      { type: 'tabdoc', appId: 'tabdoc', appEntryMode: 'resources', displayLabel: 'Docs', displayEmoji: '📄' },
      { type: 'skill', appId: 'skill', appEntryMode: 'panel', displayLabel: 'Skills', displayEmoji: '🔧', sidebarPanel: true },
      { type: 'tabslide', appId: 'tabslide', appEntryMode: 'resources', displayLabel: 'Slide', displayEmoji: '📽️' },
    ],
    getHandlerByAppId: (appId: string) => {
      const entries = [
        { appId: 'tabweb', appEntryMode: 'create' as const },
        { appId: 'cowart', appEntryMode: 'resources' as const },
        { appId: 'tabdoc', appEntryMode: 'resources' as const },
      ]
      return entries.find((entry) => entry.appId === appId) ?? null
    },
  },
}))

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction<'context'>

function makeApp(id: string, surface: AppInfo['surface'], distribution?: string): AppInfo {
  return { id, name: id, icon: '', can_create: false, searchable: false, enabled: true, order: 0, surface, distribution }
}

describe('useDesktopAppEntries surface filtering', () => {
  it('groups apps by manifest catalog.desktopGroup with July 10 guarantee fallback', () => {
    const spaceApps: AppInfo[] = [
      makeApp('tabweb', 'builtin', 'builtin'),
      makeApp('cowart', 'local', 'marketplace'),
      makeApp('tabdoc', 'collaborative', 'builtin'),
      makeApp('skill', null),
      // tabslide 故意不在后端列表里 → surface undefined → 兜底保留，不误判过滤
    ]
    const { result } = renderHook(() => useDesktopAppEntries(t, spaceApps))
    const byId = new Map(result.current.map((entry) => [entry.id, entry]))

    expect(byId.get('tabweb')?.groupId).toBe('local')
    expect(byId.get('tabweb')?.distribution).toBe('builtin')
    expect(byId.get('tabdoc')?.groupId).toBe('collaborative')
    expect(byId.get('tabdoc')?.distribution).toBe('builtin')
    expect(byId.has('cowart')).toBe(true)
    expect(byId.get('cowart')?.groupId).toBe('other')
    expect(byId.get('cowart')?.distribution).toBe('marketplace')
    expect(byId.has('skill-pack')).toBe(false)
    // ：skill 迁任务侧栏「技能库」，不再出现在「更多应用」。
    expect(byId.has('skill')).toBe(false)
    // 产品确认：tabslide/marketplace 已从「更多应用」总览排除。
    expect(byId.has('tabslide')).toBe(false)
    expect(byId.has('marketplace')).toBe(false)
    expect(byId.get('cloud-resources')?.distribution).toBe('builtin')
  })

  it('documents July 10 guaranteed app ids', () => {
    expect(GUARANTEED_COLLABORATIVE_APP_IDS.has('cloud-resources')).toBe(true)
    expect(GUARANTEED_COLLABORATIVE_APP_IDS.has('tabdata')).toBe(true)
    expect(GUARANTEED_COLLABORATIVE_APP_IDS.has('tabdoc')).toBe(true)
    expect(GUARANTEED_COLLABORATIVE_APP_IDS.has('skill')).toBe(true)
    expect(GUARANTEED_COLLABORATIVE_APP_IDS.has('tabslide')).toBe(false)
    expect(GUARANTEED_BUILTIN_APP_IDS.has('tabweb')).toBe(true)
    expect(GUARANTEED_STANDALONE_APP_IDS.has('tabfolder')).toBe(true)
    expect(DESKTOP_APPS_EXCLUDED_IDS.has('tabfiles')).toBe(true)
    expect(DESKTOP_APPS_EXCLUDED_IDS.has('tabcode')).toBe(true)
    expect(DESKTOP_APPS_EXCLUDED_IDS.has('tabslide')).toBe(true)
    expect(DESKTOP_APPS_EXCLUDED_IDS.has('marketplace')).toBe(true)
    expect(DESKTOP_APPS_EXCLUDED_IDS.has('skill')).toBe(true)
  })

  it('keeps all entries before space apps load (undefined) to avoid flicker', () => {
    const { result } = renderHook(() => useDesktopAppEntries(t, undefined))
    const ids = result.current.map((entry) => entry.id)

    // 就绪前不做过滤（此时后端 local 插件的 handler 也尚未注册，不会真正露出）。
    expect(ids).toContain('tabweb')
    expect(ids).toContain('tabdoc')
    expect(ids).toContain('cloud-resources')
    // 排除表项即使在 spaceApps 未就绪时也不进总览。
    expect(ids).not.toContain('marketplace')
    expect(ids).not.toContain('tabslide')
    expect(ids).not.toContain('skill')
  })
})
