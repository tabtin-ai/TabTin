/**
 * skill/uninstall surface handler 单测。
 *
 * 覆盖：
 *   - skillKey / userId 校验
 *   - 目标不存在 → 幂等返回 {missing: true}
 *   - 目标不是目录 → SurfaceError UNINSTALL_FAILED
 *   - 删除成功 → 返回 {}
 *   - 删除后二次确认不存在 → 返回 {missing: true}
 *   - 删除失败 → SurfaceError UNINSTALL_FAILED
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { _clearRegistry, getSurface } from '../../surface/registry.js'
import { SurfaceError } from '../../surface/types.js'
import {
  createSkillUninstallSurface,
  type SkillUninstallDeps,
} from '../skill-uninstall.js'

function _createDeps(overrides: Partial<SkillUninstallDeps> = {}): SkillUninstallDeps {
  return {
    isValidSkillKey: () => true,
    resolveSkillDir: (skillKey, ctx) =>
      ctx.organizationId
        ? `/data/users/${ctx.userId}/organizations/${ctx.organizationId}/skills/${skillKey}`
        : `/data/users/${ctx.userId}/skills/${skillKey}`,
    uninstallSkillLocal: vi.fn().mockResolvedValue(true),
    statOrNull: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    ...overrides,
  }
}

const _VALID = {
  skillKey: 'bundled:test',
  userId: 'user-001',
  organizationId: 'org-001',
}

describe('skill/uninstall surface', () => {
  beforeEach(() => {
    _clearRegistry()
  })

  describe('输入校验', () => {
    it('skillKey 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillUninstallSurface(_createDeps())
      try {
        await surface.def.handler({ ..._VALID, skillKey: '' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('isValidSkillKey 返回 false 时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillUninstallSurface(
        _createDeps({
          isValidSkillKey: () => false,
        }),
      )
      try {
        await surface.def.handler({ ..._VALID, skillKey: 'bad!key' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('userId 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillUninstallSurface(_createDeps())
      try {
        await surface.def.handler({ ..._VALID, userId: '' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
        expect((err as SurfaceError).message).toContain('userId')
      }
    })
  })

  describe('卸载逻辑', () => {
    it('目标不存在 → 幂等返回 {missing: true}', async () => {
      const surface = createSkillUninstallSurface(
        _createDeps({
          statOrNull: vi.fn().mockResolvedValue(null),
        }),
      )
      const result = await surface.def.handler(_VALID, {} as never)
      expect(result.missing).toBe(true)
    })

    it('目标不是目录 → 抛 UNINSTALL_FAILED', async () => {
      const surface = createSkillUninstallSurface(
        _createDeps({
          statOrNull: vi.fn().mockResolvedValue({ isDirectory: () => false }),
        }),
      )
      try {
        await surface.def.handler(_VALID, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('UNINSTALL_FAILED')
        expect((err as SurfaceError).message).toContain('not a directory')
      }
    })

    it('删除成功 → 返回空对象', async () => {
      const surface = createSkillUninstallSurface(_createDeps())
      const result = await surface.def.handler(_VALID, {} as never)
      expect(result.missing).toBeUndefined()
    })

    it('uninstallSkillLocal 返回 false 但二次 stat 确认已删除 → 返回 {missing: true}', async () => {
      const statMock = vi
        .fn()
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockResolvedValueOnce(null)
      const surface = createSkillUninstallSurface(
        _createDeps({
          uninstallSkillLocal: vi.fn().mockResolvedValue(false),
          statOrNull: statMock,
        }),
      )
      const result = await surface.def.handler(_VALID, {} as never)
      expect(result.missing).toBe(true)
    })

    it('删除失败且二次 stat 仍存在 → 抛 UNINSTALL_FAILED', async () => {
      const statMock = vi.fn().mockResolvedValue({ isDirectory: () => true })
      const surface = createSkillUninstallSurface(
        _createDeps({
          uninstallSkillLocal: vi.fn().mockResolvedValue(false),
          statOrNull: statMock,
        }),
      )
      try {
        await surface.def.handler(_VALID, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('UNINSTALL_FAILED')
      }
    })
  })

  describe('registry 集成', () => {
    it('注册到正确的 channel', () => {
      const surface = createSkillUninstallSurface(_createDeps())
      expect(surface.channel).toBe('skill:uninstall')
      expect(surface.httpPath).toBe('/skill/uninstall')
    })

    it('通过 registry 可查到', () => {
      createSkillUninstallSurface(_createDeps())
      expect(getSurface('skill:uninstall')).toBeDefined()
    })
  })
})
