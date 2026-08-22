/**
 * cli-space-desktop-cache · device_permissions 缓存纯模块单测
 * （Wave 2.1 · 规范 § 6.5 命令行侧兑现）。
 *
 * 该缓存从 cli-server.ts 抽到独立纯模块（无 electron 依赖），所以测试
 * 可以直接 import 真实函数，而不需要 mock cli-server 的整个路由依赖链。
 */

import { describe, it, expect, beforeEach } from 'vitest'

import {
  setCurrentSpaceDevicePermissions,
  getCurrentSpaceDevicePermissions,
} from '../cli-space-desktop-cache'

describe('setCurrentSpaceDevicePermissions · cli-server 缓存', () => {
  beforeEach(() => {
    setCurrentSpaceDevicePermissions(null)
  })

  it('null / undefined 清空缓存', () => {
    setCurrentSpaceDevicePermissions({ desktop_observe: 'block' })
    setCurrentSpaceDevicePermissions(null)
    expect(getCurrentSpaceDevicePermissions()).toBeNull()

    setCurrentSpaceDevicePermissions({ desktop_observe: 'block' })
    setCurrentSpaceDevicePermissions(undefined as unknown as null)
    expect(getCurrentSpaceDevicePermissions()).toBeNull()
  })

  it('数组 / 非对象视作无效，清空缓存', () => {
    setCurrentSpaceDevicePermissions({ desktop_observe: 'block' })
    setCurrentSpaceDevicePermissions([] as unknown as Record<string, string>)
    expect(getCurrentSpaceDevicePermissions()).toBeNull()
  })

  it('保存对象的浅拷贝，原对象后续 mutate 不影响缓存', () => {
    const src = { desktop_observe: 'block', desktop_input: 'confirm' }
    setCurrentSpaceDevicePermissions(src)
    expect(getCurrentSpaceDevicePermissions()).toEqual(src)
    ;(src as Record<string, string>).desktop_observe = 'allow'
    expect(getCurrentSpaceDevicePermissions()?.desktop_observe).toBe('block')
  })

  it('非字符串 value 被过滤（保守清理），避免传入对象注入', () => {
    setCurrentSpaceDevicePermissions({
      desktop_observe: 'block',
      garbage: 42 as unknown as string,
      nested: { foo: 1 } as unknown as string,
    })
    expect(getCurrentSpaceDevicePermissions()).toEqual({ desktop_observe: 'block' })
  })

  it('空对象合法（表达"已同步，当前无 block"）', () => {
    setCurrentSpaceDevicePermissions({})
    expect(getCurrentSpaceDevicePermissions()).toEqual({})
  })
})
