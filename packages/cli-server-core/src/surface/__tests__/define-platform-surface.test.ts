/**
 * definePlatformSurface 工厂函数测试。
 *
 * 覆盖：
 *   - 正常注册 + 返回值形状
 *   - module/verb 格式校验
 *   - 重复注册抛错
 *   - alias 注册
 *   - deprecated 字段透传
 *   - D-6 类型约束（@ts-expect-error 验证编译错误）
 *   - Object.freeze 冻结
 *   - 自定义 http path
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { definePlatformSurface } from '../define-platform-surface.js'
import { getSurface, _clearRegistry } from '../registry.js'
import { _clearSurfaceRuntime } from '../configure-surface-runtime.js'
import type { SurfaceKind } from '../types.js'

/** 构造测试用的 handler */
const _noopHandler = async () => ({ result: true })

beforeEach(() => {
  _clearRegistry()
  _clearSurfaceRuntime()
})

describe('definePlatformSurface', () => {
  it('正常注册一个 local surface，返回正确的 channel 和 httpPath', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: ['SESSION_NOT_FOUND', 'EXPORT_FAILED'] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })

    expect(surface.channel).toBe('chat:export-md')
    expect(surface.httpPath).toBe('/chat/export-md')
    expect(surface.def.module).toBe('chat')
    expect(surface.def.verb).toBe('export-md')
    expect(surface.def.kind).toBe('local')
    expect(surface.def.errorCodes).toEqual(['SESSION_NOT_FOUND', 'EXPORT_FAILED'])
  })

  it('注册后能从 registry 查到', () => {
    const surface = definePlatformSurface({
      module: 'workspace',
      verb: 'open',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })

    expect(getSurface('workspace:open')).toBe(surface)
  })

  it('返回的 RegisteredSurface 是冻结的', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'list',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })

    expect(Object.isFrozen(surface)).toBe(true)
    expect(Object.isFrozen(surface.def)).toBe(true)
  })

  describe('module/verb 格式校验', () => {
    it('大写字母开头被拒', () => {
      expect(() => definePlatformSurface({
        module: 'Chat',
        verb: 'export',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).toThrow('格式不合法')
    })

    it('包含下划线被拒', () => {
      expect(() => definePlatformSurface({
        module: 'chat',
        verb: 'export_md',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).toThrow('格式不合法')
    })

    it('数字开头被拒', () => {
      expect(() => definePlatformSurface({
        module: '1chat',
        verb: 'export',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).toThrow('格式不合法')
    })

    it('空字符串被拒', () => {
      expect(() => definePlatformSurface({
        module: '',
        verb: 'export',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).toThrow('格式不合法')
    })

    it('包含空格被拒', () => {
      expect(() => definePlatformSurface({
        module: 'chat app',
        verb: 'export',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).toThrow('格式不合法')
    })

    it('合法：小写字母、数字、连字符', () => {
      expect(() => definePlatformSurface({
        module: 'tab-data2',
        verb: 'list-records',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })).not.toThrow()
    })
  })

  it('重复注册同一 channel 抛错', () => {
    definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })

    expect(() => definePlatformSurface({
      module: 'chat',
      verb: 'export-md',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })).toThrow('已注册')
  })

  describe('alias 注册', () => {
    it('alias 也注册到 registry', () => {
      definePlatformSurface({
        module: 'chat',
        verb: 'export-md',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
        aliases: ['chat:export'],
      })

      expect(getSurface('chat:export')).toBeDefined()
      expect(getSurface('chat:export')!.def.module).toBe('chat')
    })

    it('alias 与主 channel 指向同一 handler', () => {
      const surface = definePlatformSurface({
        module: 'chat',
        verb: 'export-md',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
        aliases: ['chat:export'],
      })

      const aliasSurface = getSurface('chat:export')
      expect(aliasSurface!.def.handler).toBe(surface.def.handler)
    })

    it('alias 与已注册 channel 重名时抛错', () => {
      definePlatformSurface({
        module: 'chat',
        verb: 'export',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
      })

      expect(() => definePlatformSurface({
        module: 'chat',
        verb: 'export-md',
        kind: 'local',
        errorCodes: [] as const,
        handler: _noopHandler,
        bindings: { ipc: true, http: true },
        aliases: ['chat:export'],
      })).toThrow('已注册')
    })
  })

  it('deprecated 字段透传到 def', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'old-export',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
      deprecated: {
        since: '0.5.0',
        replacedBy: 'chat:export-md',
        removeAfter: '1.0.0',
      },
    })

    expect(surface.def.deprecated).toEqual({
      since: '0.5.0',
      replacedBy: 'chat:export-md',
      removeAfter: '1.0.0',
    })
  })

  it('proxied surface 正常注册（ipc: false）', () => {
    const surface = definePlatformSurface({
      module: 'agent',
      verb: 'update-settings',
      kind: 'proxied',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: false, http: true },
    })

    expect(surface.def.kind).toBe('proxied')
    expect(surface.def.bindings.ipc).toBe(false)
  })

  it('D-6 类型约束：proxied + ipc: true 编译错误', () => {
    // @ts-expect-error D-6: proxied surface 的 ipc 只能是 false
    definePlatformSurface({
      module: 'd6-test',
      verb: 'should-fail',
      kind: 'proxied' as const,
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })
  })

  it('自定义 http path', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'export-v2',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: { method: 'GET', path: '/custom/chat/export' } },
    })

    expect(surface.httpPath).toBe('/custom/chat/export')
  })

  it('http binding 为 boolean 时使用默认路径', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'fork',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: true },
    })

    expect(surface.httpPath).toBe('/chat/fork')
  })

  it('http binding 为 false 时仍然生成默认 httpPath', () => {
    const surface = definePlatformSurface({
      module: 'chat',
      verb: 'ipc-only',
      kind: 'local',
      errorCodes: [] as const,
      handler: _noopHandler,
      bindings: { ipc: true, http: false },
    })

    expect(surface.httpPath).toBe('/chat/ipc-only')
  })
})
