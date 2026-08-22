/**
 * PlatformSurface 全局注册表测试。
 *
 * 覆盖：注册 / 查询 / 重复注册抛错 / getAllSurfaces 去重 / _clearRegistry
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  _registerSurface,
  getSurface,
  getAllSurfaces,
  _clearRegistry,
} from '../registry.js'
import type { RegisteredSurface } from '../types.js'

/** 构造一个最小 RegisteredSurface 用于测试 */
function _makeSurface(
  channel: string,
  httpPath: string = `/${channel.replace(':', '/')}`,
): RegisteredSurface {
  return Object.freeze({
    channel,
    httpPath,
    def: Object.freeze({
      module: channel.split(':')[0],
      verb: channel.split(':')[1],
      kind: 'local' as const,
      errorCodes: [] as readonly string[],
      handler: async () => ({}),
      bindings: { ipc: true, http: true },
    }),
  })
}

describe('Surface Registry', () => {
  beforeEach(() => {
    _clearRegistry()
  })

  it('注册后能按 channel 查询到', () => {
    const surface = _makeSurface('chat:export-md')
    _registerSurface(surface)

    const found = getSurface('chat:export-md')
    expect(found).toBe(surface)
  })

  it('未注册的 channel 返回 undefined', () => {
    expect(getSurface('nonexistent:channel')).toBeUndefined()
  })

  it('重复注册同一 channel 抛错', () => {
    const surface = _makeSurface('chat:export-md')
    _registerSurface(surface)

    expect(() => _registerSurface(surface)).toThrow('已注册')
  })

  it('getAllSurfaces 返回所有已注册 surface', () => {
    const s1 = _makeSurface('chat:export-md')
    const s2 = _makeSurface('workspace:open')
    _registerSurface(s1)
    _registerSurface(s2)

    const all = getAllSurfaces()
    expect(all).toHaveLength(2)
    expect(all).toContain(s1)
    expect(all).toContain(s2)
  })

  it('getAllSurfaces 对 alias 去重——同一 module:verb 注册到多个 channel 只出现一次', () => {
    const surface = _makeSurface('chat:export-md')
    _registerSurface(surface)
    // 模拟 alias 注册：channel 不同但 def.module + def.verb 相同
    _registerSurface({ ...surface, channel: 'chat:export' } as RegisteredSurface)

    const all = getAllSurfaces()
    // 虽然注册了 2 个 channel，但 module:verb 相同，getAllSurfaces 去重后只返回 1 个
    expect(all).toHaveLength(1)
    expect(all[0].channel).toBe('chat:export-md')
  })

  it('_clearRegistry 清空后查询返回 undefined', () => {
    _registerSurface(_makeSurface('chat:export-md'))
    expect(getSurface('chat:export-md')).toBeDefined()

    _clearRegistry()
    expect(getSurface('chat:export-md')).toBeUndefined()
  })

  it('_clearRegistry 清空后 getAllSurfaces 返回空数组', () => {
    _registerSurface(_makeSurface('chat:export-md'))
    _clearRegistry()

    expect(getAllSurfaces()).toHaveLength(0)
  })

  it('getAllSurfaces 返回值是冻结的（readonly）', () => {
    _registerSurface(_makeSurface('chat:export-md'))
    const all = getAllSurfaces()

    expect(Object.isFrozen(all)).toBe(true)
  })
})
