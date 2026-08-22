/**
 * skill/read-content surface handler 单测。
 *
 * 覆盖：
 *   - skillKey 为空 → SurfaceError VALIDATION_ERROR
 *   - registry 未初始化 → SurfaceError SKILL_REGISTRY_UNAVAILABLE
 *   - exact key 匹配成功
 *   - exact key 不命中 → path-part fallback 命中
 *   - 完全未找到 → 返回 {content: null}
 *   - skillsReady 超时 → 抛错
 *   - registry 集成：channel / httpPath / errorCodes / alias
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { _clearRegistry, getSurface } from '../../surface/registry.js'
import { SurfaceError } from '../../surface/types.js'
import {
  createSkillReadContentSurface,
  type SkillReadContentDeps,
  type SkillReadContentInput,
} from '../skill-read-content.js'

// ─── mock 工具 ──────────────────────────────────────────────────────

function _createMockRegistry(skills: Array<{ canonicalKey: string; content?: string | null }>) {
  return {
    listAll: () => skills,
    getByKey: (key: string) => skills.find((s) => s.canonicalKey === key),
  }
}

function _createDeps(overrides: Partial<SkillReadContentDeps> = {}): SkillReadContentDeps {
  return {
    getSkillsReady: () => Promise.resolve(),
    getSkillsRegistry: () => _createMockRegistry([
      { canonicalKey: 'bundled:platform/test-skill', content: '# Test Skill\nContent here' },
      { canonicalKey: 'workspace:my-skill', content: 'workspace skill content' },
    ]),
    ...overrides,
  }
}

// ─── 测试 ──────────────────────────────────────────────────────────

describe('skill/read-content surface', () => {
  beforeEach(() => {
    _clearRegistry()
  })

  describe('输入校验', () => {
    it('skillKey 为空时抛 SurfaceError VALIDATION_ERROR', async () => {
      const surface = createSkillReadContentSurface(_createDeps())
      try {
        await surface.def.handler({} as SkillReadContentInput, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('skillKey 为 undefined 时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillReadContentSurface(_createDeps())
      try {
        await surface.def.handler({ skillKey: '' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })
  })

  describe('registry 状态', () => {
    it('registry 未初始化时抛 SKILL_REGISTRY_UNAVAILABLE', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsRegistry: () => null,
      }))
      try {
        await surface.def.handler({ skillKey: 'test' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('SKILL_REGISTRY_UNAVAILABLE')
      }
    })

    it('registry 未初始化但有 Space 上下文时回退读取本地 SKILL.md', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsRegistry: () => null,
        resolveSkillDir: (spaceId, organizationId, slug) => `/platform/${organizationId}/${spaceId}/skills/${slug}`,
        readSkillFile: async (skillDir, fileName) =>
          `${skillDir}/${fileName}` === '/platform/wt-1/sp-1/skills/daily-report/SKILL.md'
            ? '# Daily Report\nContent'
            : null,
      }))

      const result = await surface.def.handler(
        { skillKey: 'user:daily-report', spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.content).toBe('# Daily Report\nContent')
    })

    it('registry 未初始化但有源文件路径时回退读取内置 SKILL.md', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsRegistry: () => null,
        readSourceSkillFile: async (docPath) =>
          docPath === '/repo/packages/apps/tabdoc/skills/tabdoc-operator/SKILL.md'
            ? '# TabDoc Operator'
            : null,
      }))

      const result = await surface.def.handler(
        {
          skillKey: 'app:tabdoc/tabdoc-operator',
          sourceDocPath: '/repo/packages/apps/tabdoc/skills/tabdoc-operator/SKILL.md',
        },
        {} as never,
      )

      expect(result.content).toBe('# TabDoc Operator')
    })

    it('skillsReady 为 null 时跳过等待，直接查 registry', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsReady: () => null,
      }))
      const result = await surface.def.handler(
        { skillKey: 'bundled:platform/test-skill' },
        {} as never,
      )
      expect(result.content).toContain('Test Skill')
    })
  })

  describe('查找逻辑', () => {
    it('exact key 匹配成功', async () => {
      const surface = createSkillReadContentSurface(_createDeps())
      const result = await surface.def.handler(
        { skillKey: 'bundled:platform/test-skill' },
        {} as never,
      )
      expect(result.content).toBe('# Test Skill\nContent here')
    })

    it('exact key 不匹配 → path-part fallback 命中', async () => {
      const surface = createSkillReadContentSurface(_createDeps())
      const result = await surface.def.handler(
        { skillKey: 'platform/test-skill' },
        {} as never,
      )
      expect(result.content).toBe('# Test Skill\nContent here')
    })

    it('完全未找到 → content 为 null', async () => {
      const surface = createSkillReadContentSurface(_createDeps())
      const result = await surface.def.handler(
        { skillKey: 'nonexistent' },
        {} as never,
      )
      expect(result.content).toBeNull()
    })

    it('registry 未命中但有 Space 上下文时回退读取本地文件', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        resolveSkillDir: (spaceId, organizationId, slug) => `/platform/${organizationId}/${spaceId}/skills/${slug}`,
        readSkillFile: async (skillDir, fileName) =>
          `${skillDir}/${fileName}` === '/platform/wt-1/sp-1/skills/new-draft/SKILL.md'
            ? '# New Draft'
            : null,
      }))

      const result = await surface.def.handler(
        { skillKey: 'user:new-draft', spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.content).toBe('# New Draft')
    })

    it('user skill 有本地文件时优先返回本地工作副本而不是 registry 快照', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsRegistry: () => _createMockRegistry([
          { canonicalKey: 'user:daily-report', content: '# Registry Stale Draft' },
        ]),
        resolveSkillDir: (spaceId, organizationId, slug) => `/platform/${organizationId}/${spaceId}/skills/${slug}`,
        readSkillFile: async (skillDir, fileName) =>
          `${skillDir}/${fileName}` === '/platform/wt-1/sp-1/skills/daily-report/SKILL.md'
            ? '# Local Fresh Draft'
            : null,
      }))

      const result = await surface.def.handler(
        { skillKey: 'user:daily-report', spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.content).toBe('# Local Fresh Draft')
    })

    it('registry 未命中但有源文件路径时回退读取内置源文件', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        readSourceSkillFile: async (docPath) =>
          docPath === '/repo/packages/skills/bundled/platform/device/operations/SKILL.md'
            ? '# Device Operations'
            : null,
      }))

      const result = await surface.def.handler(
        {
          skillKey: 'platform:device/operations',
          sourceDocPath: '/repo/packages/skills/bundled/platform/device/operations/SKILL.md',
        },
        {} as never,
      )

      expect(result.content).toBe('# Device Operations')
    })

    it('本地文件未命中时继续回退读取内置源文件', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        resolveSkillDir: (spaceId, organizationId, slug) =>
          `/platform/${organizationId}/${spaceId}/skills/${slug}`,
        readSkillFile: async () => null,
        readSourceSkillFile: async (docPath) =>
          docPath === '/repo/packages/skills/bundled/platform/device/operations/SKILL.md'
            ? '# Device Operations'
            : null,
      }))

      const result = await surface.def.handler(
        {
          skillKey: 'platform:device/operations',
          spaceId: 'sp-1',
          organizationId: 'wt-1',
          sourceDocPath: '/repo/packages/skills/bundled/platform/device/operations/SKILL.md',
        },
        {} as never,
      )

      expect(result.content).toBe('# Device Operations')
    })

    it('无 colon 的 key 也走 fallback', async () => {
      const surface = createSkillReadContentSurface(_createDeps({
        getSkillsRegistry: () => _createMockRegistry([
          { canonicalKey: 'bundled:simple', content: 'simple content' },
        ]),
      }))
      const result = await surface.def.handler(
        { skillKey: 'simple' },
        {} as never,
      )
      expect(result.content).toBe('simple content')
    })
  })

  describe('registry 集成', () => {
    it('注册到正确的 channel 和 httpPath', () => {
      const surface = createSkillReadContentSurface(_createDeps())
      expect(surface.channel).toBe('skill:read-content')
      expect(surface.httpPath).toBe('/skill/read-content')
    })

    it('通过 registry 可查到', () => {
      createSkillReadContentSurface(_createDeps())
      const found = getSurface('skill:read-content')
      expect(found).toBeDefined()
      expect(found!.def.kind).toBe('local')
    })

    it('errorCodes 闭集正确', () => {
      const surface = createSkillReadContentSurface(_createDeps())
      expect(surface.def.errorCodes).toEqual(['VALIDATION_ERROR', 'SKILL_REGISTRY_UNAVAILABLE'])
    })
  })
})
