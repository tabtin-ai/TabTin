import { describe, it, expect } from 'vitest'
import {
  PROFILES,
  getProfilePreset,
  mergeProfileConfig,
  listProfiles,
} from '../profiles'
import type { ViewFactoryConfig } from '../types'

// ---------------------------------------------------------------------------
// getProfilePreset
// ---------------------------------------------------------------------------

describe('getProfilePreset', () => {
  it.each([
    'user-tab',
    'agent-workspace',
    'background-task',
    'temporary-preview',
  ] as const)('应返回 %s 的预设配置', (profile) => {
    const preset = getProfilePreset(profile)
    expect(preset).toBeDefined()
    expect(preset.displayMode).toBeTruthy()
    expect(typeof preset.persistent).toBe('boolean')
    expect(typeof preset.autoClose).toBe('boolean')
    expect(typeof preset.showInSidebar).toBe('boolean')
    expect(preset.description).toBeTruthy()
  })

  it('未知 profile 应抛出错误', () => {
    expect(() => getProfilePreset('nonexistent' as any)).toThrow('未知的 ViewProfile')
  })

  it('user-tab 应为持久化模式', () => {
    const preset = getProfilePreset('user-tab')
    expect(preset.persistent).toBe(true)
    expect(preset.showInSidebar).toBe(true)
  })

  it('background-task 应为隐藏且自动关闭', () => {
    const preset = getProfilePreset('background-task')
    expect(preset.displayMode).toBe('hidden')
    expect(preset.autoClose).toBe(true)
    expect(preset.showInSidebar).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// listProfiles
// ---------------------------------------------------------------------------

describe('listProfiles', () => {
  it('应返回全部预设', () => {
    const list = listProfiles()
    expect(list.length).toBe(Object.keys(PROFILES).length)
    expect(list.length).toBeGreaterThanOrEqual(4)
  })

  it('每个元素应有 profile 和 preset', () => {
    for (const entry of listProfiles()) {
      expect(typeof entry.profile).toBe('string')
      expect(entry.preset).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// mergeProfileConfig
// ---------------------------------------------------------------------------

describe('mergeProfileConfig', () => {
  const minimal: ViewFactoryConfig = {
    profile: 'user-tab',
    id: 'view-1',
  }

  it('应合并预设的默认值', () => {
    const merged = mergeProfileConfig(minimal)
    expect(merged.profile).toBe('user-tab')
    expect(merged.id).toBe('view-1')
    expect(merged.persistent).toBe(true)
    expect(merged.showInSidebar).toBe(true)
    expect(merged.autoClose).toBe(false)
    expect(merged.displayMode).toBe('embedded')
  })

  it('用户配置应覆盖预设', () => {
    const config: ViewFactoryConfig = {
      profile: 'user-tab',
      id: 'view-2',
      persistent: false,
      showInSidebar: false,
      displayMode: 'hidden',
    }
    const merged = mergeProfileConfig(config)
    expect(merged.persistent).toBe(false)
    expect(merged.showInSidebar).toBe(false)
    expect(merged.displayMode).toBe('hidden')
  })

  it('未知 profile 应抛出错误', () => {
    expect(() =>
      mergeProfileConfig({ profile: 'unknown-profile' as any, id: 'x' }),
    ).toThrow('未知的 ViewProfile')
  })

  it('hidden 模式应生成屏幕外 bounds', () => {
    const config: ViewFactoryConfig = {
      profile: 'background-task',
      id: 'bg-1',
    }
    const merged = mergeProfileConfig(config)
    expect(merged.bounds.x).toBeLessThan(0)
  })

  it('自定义 bounds 应覆盖默认值', () => {
    const config: ViewFactoryConfig = {
      profile: 'background-task',
      id: 'bg-2',
      bounds: { x: 100, y: 100, width: 800, height: 600 },
    }
    const merged = mergeProfileConfig(config)
    expect(merged.bounds).toEqual({ x: 100, y: 100, width: 800, height: 600 })
  })

  it('应设置合理的默认 keepAliveDuration', () => {
    const merged = mergeProfileConfig(minimal)
    expect(merged.keepAliveDuration).toBe(300000)
  })

  it('url 默认应为空字符串', () => {
    const merged = mergeProfileConfig(minimal)
    expect(merged.url).toBe('')
  })

  it('proxy 未指定时应为 undefined', () => {
    const merged = mergeProfileConfig(minimal)
    expect(merged.proxy).toBeUndefined()
  })

  it('antiDetect 应继承预设', () => {
    const merged = mergeProfileConfig(minimal)
    const preset = getProfilePreset('user-tab')
    expect(merged.antiDetect).toEqual(preset.antiDetect)
  })

  it('用户 antiDetect 应覆盖预设', () => {
    const customAntiDetect = {
      userAgent: { preset: 'desktop' as const, randomize: true },
    }
    const config: ViewFactoryConfig = {
      profile: 'user-tab',
      id: 'v',
      antiDetect: customAntiDetect as any,
    }
    const merged = mergeProfileConfig(config)
    expect(merged.antiDetect).toEqual(customAntiDetect)
  })

  it('notifyRenderer 默认跟随 showInSidebar', () => {
    const merged = mergeProfileConfig({ profile: 'background-task', id: 'x' })
    expect(merged.notifyRenderer).toBe(false)
  })
})
