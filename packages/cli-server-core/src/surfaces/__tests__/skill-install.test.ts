/**
 * skill/install surface handler 单测。
 *
 * 覆盖：
 *   - skillKey / userId 校验
 *   - isValidSkillKey 不通过
 *   - 安装成功 → 返回 {filesWritten}
 *   - 安装失败 → SurfaceError INSTALL_FAILED
 *   - registry 集成：channel / httpPath / errorCodes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { _clearRegistry, getSurface } from '../../surface/registry.js'
import { SurfaceError } from '../../surface/types.js'
import {
  createSkillInstallSurface,
  type SkillInstallDeps,
  type SkillInstallInput,
} from '../skill-install.js'

function _createDeps(overrides: Partial<SkillInstallDeps> = {}): SkillInstallDeps {
  return {
    isValidSkillKey: () => true,
    resolveSkillDir: (skillKey, ctx) =>
      ctx.organizationId
        ? `/data/users/${ctx.userId}/organizations/${ctx.organizationId}/skills/${skillKey}`
        : `/data/users/${ctx.userId}/skills/${skillKey}`,
    installSkillFromBundle: vi.fn().mockResolvedValue({ ok: true, filesWritten: 3 }),
    ...overrides,
  }
}

const _VALID_INPUT: SkillInstallInput = {
  skillKey: 'bundled:test-skill',
  userId: 'user-001',
  organizationId: 'org-001',
  files: [
    {
      path: 'SKILL.md',
      sha256: 'abc',
      size: 100,
      download_url: 'https://example.com/SKILL.md',
      content_type: 'text/markdown',
    },
  ],
}

describe('skill/install surface', () => {
  beforeEach(() => {
    _clearRegistry()
  })

  describe('输入校验', () => {
    it('skillKey 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillInstallSurface(_createDeps())
      try {
        await surface.def.handler({ ..._VALID_INPUT, skillKey: '' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('isValidSkillKey 返回 false 时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillInstallSurface(
        _createDeps({
          isValidSkillKey: () => false,
        }),
      )
      try {
        await surface.def.handler(_VALID_INPUT, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
        expect((err as SurfaceError).message).toContain('格式不合法')
      }
    })

    it('userId 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillInstallSurface(_createDeps())
      try {
        await surface.def.handler({ ..._VALID_INPUT, userId: '' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
        expect((err as SurfaceError).message).toContain('userId')
      }
    })

    it('userId=_unscoped 时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillInstallSurface(_createDeps())
      try {
        await surface.def.handler({ ..._VALID_INPUT, userId: '_unscoped' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
        expect((err as SurfaceError).message).toContain('userId')
      }
    })
  })

  describe('安装逻辑', () => {
    it('安装成功返回 filesWritten', async () => {
      const surface = createSkillInstallSurface(_createDeps())
      const result = await surface.def.handler(_VALID_INPUT, {} as never)
      expect(result.filesWritten).toBe(3)
    })

    it('installSkillFromBundle 收到正确参数', async () => {
      const mockInstall = vi.fn().mockResolvedValue({ ok: true, filesWritten: 1 })
      const surface = createSkillInstallSurface(
        _createDeps({
          installSkillFromBundle: mockInstall,
        }),
      )
      await surface.def.handler(_VALID_INPUT, {} as never)
      expect(mockInstall).toHaveBeenCalledWith({
        skillKey: 'bundled:test-skill',
        files: _VALID_INPUT.files,
        targetDir:
          '/data/users/user-001/organizations/org-001/skills/bundled:test-skill',
        meta: undefined,
      })
    })

    it('可从 resolveUserId 回退取 userId', async () => {
      const mockInstall = vi.fn().mockResolvedValue({ ok: true, filesWritten: 1 })
      const surface = createSkillInstallSurface(
        _createDeps({
          installSkillFromBundle: mockInstall,
          resolveUserId: async () => 'user-from-auth',
        }),
      )
      await surface.def.handler(
        { ..._VALID_INPUT, userId: undefined, organizationId: undefined },
        {} as never,
      )
      expect(mockInstall).toHaveBeenCalledWith(
        expect.objectContaining({
          targetDir: '/data/users/user-from-auth/skills/bundled:test-skill',
        }),
      )
    })

    it('安装失败时抛 INSTALL_FAILED', async () => {
      const surface = createSkillInstallSurface(
        _createDeps({
          installSkillFromBundle: vi.fn().mockResolvedValue({
            ok: false,
            filesWritten: 0,
            error: 'disk full',
          }),
        }),
      )
      try {
        await surface.def.handler(_VALID_INPUT, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('INSTALL_FAILED')
        expect((err as SurfaceError).message).toContain('disk full')
      }
    })
  })

  describe('registry 集成', () => {
    it('注册到正确的 channel', () => {
      const surface = createSkillInstallSurface(_createDeps())
      expect(surface.channel).toBe('skill:install')
      expect(surface.httpPath).toBe('/skill/install')
    })

    it('通过 registry 可查到', () => {
      createSkillInstallSurface(_createDeps())
      expect(getSurface('skill:install')).toBeDefined()
    })

    it('errorCodes 闭集', () => {
      const surface = createSkillInstallSurface(_createDeps())
      expect(surface.def.errorCodes).toEqual(['VALIDATION_ERROR', 'INSTALL_FAILED'])
    })
  })
})
