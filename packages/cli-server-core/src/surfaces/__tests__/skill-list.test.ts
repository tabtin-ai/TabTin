/**
 * skill/list surface handler 单测。
 *
 * 覆盖：
 *   - spaceId / organizationId 必填
 *   - skillsReady 超时 / registry 缺失降级为 SKILL_REGISTRY_UNAVAILABLE
 *   - handler 先 ensureSpaceSkills，再从 LocalSkillRegistry.listForSpace 转 UI 条目
 *   - registry 集成：channel / httpPath / errorCodes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { _clearRegistry, getSurface } from '../../surface/registry.js'
import { SurfaceError } from '../../surface/types.js'
import {
  createSkillListSurface,
  type SkillListDeps,
  type SkillListInput,
} from '../skill-list.js'

function _createMockRegistry() {
  return {
    listForSpace: (spaceId: string) => [
      {
        canonicalKey: 'app:tabdoc/tabdoc-operator',
        source: 'app' as const,
        metaSource: 'app' as const,
        scope: 'space',
        appId: 'tabdoc',
        spaceId,
        slug: 'tabdoc-operator',
        name: 'TabDoc Operator',
        description: 'Operate TabDoc from Tin.',
        version: '1.0.0',
        docPath: `/platform/wt-1/spaces/${spaceId}/skills/tabdoc-operator/SKILL.md`,
        primaryEnv: 'TABDOC_API_KEY',
        tags: ['docs', 'editor'],
        xTabtinApps: ['tabdoc'],
        rootKind: 'space',
      },
      {
        canonicalKey: 'platform:device/operations',
        source: 'platform' as const,
        metaSource: 'platform' as const,
        scope: 'space',
        appId: 'device',
        spaceId,
        slug: 'operations',
        name: 'Device Operations',
        description: 'Use device capabilities.',
        docPath: `/platform/wt-1/spaces/${spaceId}/skills/operations/SKILL.md`,
      },
    ],
  }
}

function _createDeps(overrides: Partial<SkillListDeps> = {}): SkillListDeps {
  return {
    getSkillsReady: () => Promise.resolve(),
    getSkillsRegistry: () => _createMockRegistry(),
    ensureSpaceSkills: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('skill/list surface', () => {
  beforeEach(() => {
    _clearRegistry()
    vi.clearAllMocks()
  })

  describe('输入校验', () => {
    it('spaceId 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillListSurface(_createDeps())
      try {
        await surface.def.handler({ organizationId: 'wt-1' } as SkillListInput, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })

    it('organizationId 为空时抛 VALIDATION_ERROR', async () => {
      const surface = createSkillListSurface(_createDeps())
      try {
        await surface.def.handler({ spaceId: 'sp-1' } as SkillListInput, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('VALIDATION_ERROR')
      }
    })
  })

  describe('本地 registry 列表', () => {
    it('先 ensureSpaceSkills，再返回 UI 兼容条目', async () => {
      const ensureSpaceSkills = vi.fn().mockResolvedValue(undefined)
      const surface = createSkillListSurface(_createDeps({ ensureSpaceSkills }))

      const result = await surface.def.handler(
        { spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(ensureSpaceSkills).toHaveBeenCalledWith('wt-1', 'sp-1')
      expect(result.skills).toHaveLength(2)
      expect(result.skills[0]).toMatchObject({
        skill_id: 'tabdoc-operator',
        skill_key: 'app:tabdoc/tabdoc-operator',
        source: 'app',
        app_id: 'tabdoc',
        path: '/platform/wt-1/spaces/sp-1/skills/tabdoc-operator',
        doc_path: '/platform/wt-1/spaces/sp-1/skills/tabdoc-operator/SKILL.md',
        status: 'enabled',
        enabled: true,
        primary_env: 'TABDOC_API_KEY',
        tags: ['docs', 'editor'],
      })
      expect(result.skills[0].meta).toMatchObject({
        source: 'app',
        appId: 'tabdoc',
        when_to_use: undefined,
        x_tabtin_apps: ['tabdoc'],
      })
    })

    it('透出 SKILL.md 富元数据，tags 不被 x-tabtin-apps 覆盖', async () => {
      const surface = createSkillListSurface(_createDeps({
        getSkillsRegistry: () => ({
          listForSpace: (spaceId: string) => [
            {
              canonicalKey: 'app:tabphone/phone-operator',
              source: 'app' as const,
              metaSource: 'app' as const,
              scope: 'space',
              appId: 'tabphone',
              spaceId,
              slug: 'phone-operator',
              name: 'Phone Operator',
              description: 'Operate phones from Tin.',
              version: '0.1.0',
              docPath: `/platform/wt-1/spaces/${spaceId}/skills/phone-operator/SKILL.md`,
              tags: ['device', 'automation'],
              xTabtinApps: ['tabphone'],
              requires: { bins: ['adb'] },
              install: [
                {
                  id: 'android-platform-tools',
                  kind: 'brew' as const,
                  formula: 'android-platform-tools',
                  bins: ['adb'],
                },
              ],
              osFilter: ['darwin', 'linux'],
              agents: [
                {
                  filename: 'phone-agent.md',
                  name: 'Phone Agent',
                  description: 'Controls an attached phone.',
                },
              ],
              emoji: ':phone:',
              homepage: 'https://tabtin.example/phone',
              always: true,
              rootKind: 'space',
            },
          ],
        }),
      }))

      const result = await surface.def.handler(
        { spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.skills).toHaveLength(1)
      expect(result.skills[0]).toMatchObject({
        skill_id: 'phone-operator',
        skill_key: 'app:tabphone/phone-operator',
        tags: ['device', 'automation'],
        requires: { bins: ['adb'] },
        install: [
          expect.objectContaining({
            id: 'android-platform-tools',
            kind: 'brew',
            bins: ['adb'],
          }),
        ],
        os_filter: ['darwin', 'linux'],
        agents: [
          expect.objectContaining({
            filename: 'phone-agent.md',
            name: 'Phone Agent',
          }),
        ],
        emoji: ':phone:',
        homepage: 'https://tabtin.example/phone',
        always: true,
      })
      expect(result.skills[0].tags).not.toEqual(['tabphone'])
      expect(result.skills[0].meta).toMatchObject({
        tags: ['device', 'automation'],
        x_tabtin_apps: ['tabphone'],
      })
    })

    it('skillsReady 为 null 时仍可直接 ensure + 查询 registry', async () => {
      const surface = createSkillListSurface(_createDeps({
        getSkillsReady: () => null,
      }))

      const result = await surface.def.handler(
        { spaceId: 'sp-2', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.skills.map(s => s.skill_key)).toEqual([
        'app:tabdoc/tabdoc-operator',
        'platform:device/operations',
      ])
    })

    it('合并已启用 Personal Plugin skills 并标记来源插件', async () => {
      const surface = createSkillListSurface(_createDeps({
        getSkillsRegistry: () => ({
          listForSpace: () => [
            {
              canonicalKey: 'user:systematic-debugging',
              source: 'user' as const,
              metaSource: 'user' as const,
              scope: 'space',
              spaceId: 'sp-1',
              slug: 'systematic-debugging',
              name: 'Local Systematic Debugging',
              description: 'A local user skill with the same key.',
              docPath: '/platform/wt-1/spaces/sp-1/skills/systematic-debugging/SKILL.md',
              rootKind: 'space',
            },
          ],
        }),
        listPersonalPluginSkills: vi.fn().mockResolvedValue([
          {
            canonicalKey: 'user:systematic-debugging',
            source: 'user',
            metaSource: 'user',
            scope: 'space',
            spaceId: 'sp-1',
            slug: 'systematic-debugging',
            name: 'Systematic Debugging',
            description: 'Find root causes before fixing.',
            docPath: '/platform/wt-1/spaces/__marketplace__/plugins/installed/superpowers/skills/systematic-debugging/SKILL.md',
            rootKind: 'space',
            personalPluginId: 'superpowers',
            personalPluginName: 'superpowers',
            personalPluginDisplayName: 'Superpowers',
          },
        ]),
      }))

      const result = await surface.def.handler(
        { spaceId: 'sp-1', organizationId: 'wt-1' },
        {} as never,
      )

      expect(result.skills.map(s => s.skill_key)).toEqual(['user:systematic-debugging'])
      expect(result.skills[0]).toMatchObject({
        name: 'Systematic Debugging',
        slug: 'systematic-debugging',
      })
      expect(result.skills[0]?.meta).toMatchObject({
        source: 'user',
        personal_plugin_id: 'superpowers',
        personal_plugin_name: 'superpowers',
        personal_plugin_display_name: 'Superpowers',
      })
    })
  })

  describe('registry 状态', () => {
    it('registry 未初始化时抛 SKILL_REGISTRY_UNAVAILABLE', async () => {
      const surface = createSkillListSurface(_createDeps({
        getSkillsRegistry: () => null,
      }))

      try {
        await surface.def.handler({ spaceId: 'sp-1', organizationId: 'wt-1' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('SKILL_REGISTRY_UNAVAILABLE')
      }
    })

    it('ensureSpaceSkills 失败时抛 SKILL_REGISTRY_UNAVAILABLE', async () => {
      const surface = createSkillListSurface(_createDeps({
        ensureSpaceSkills: vi.fn().mockRejectedValue(new Error('ensure failed')),
      }))

      try {
        await surface.def.handler({ spaceId: 'sp-1', organizationId: 'wt-1' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('SKILL_REGISTRY_UNAVAILABLE')
        expect((err as SurfaceError).message).toContain('ensure failed')
      }
    })

    it('skillsReady 超时时抛 SKILL_REGISTRY_UNAVAILABLE', async () => {
      const surface = createSkillListSurface(_createDeps({
        getSkillsReady: () => new Promise(() => {}),
        readyTimeoutMs: 5,
      }))

      try {
        await surface.def.handler({ spaceId: 'sp-1', organizationId: 'wt-1' }, {} as never)
        expect.fail('应该抛出错误')
      } catch (err) {
        expect(err).toBeInstanceOf(SurfaceError)
        expect((err as SurfaceError).code).toBe('SKILL_REGISTRY_UNAVAILABLE')
      }
    })
  })

  describe('registry 集成', () => {
    it('注册到正确的 channel 和 httpPath', () => {
      const surface = createSkillListSurface(_createDeps())
      expect(surface.channel).toBe('skill:list')
      expect(surface.httpPath).toBe('/skill/list')
    })

    it('通过 registry 可查到', () => {
      createSkillListSurface(_createDeps())
      const found = getSurface('skill:list')
      expect(found).toBeDefined()
      expect(found!.def.kind).toBe('local')
    })

    it('errorCodes 闭集正确', () => {
      const surface = createSkillListSurface(_createDeps())
      expect(surface.def.errorCodes).toEqual(['VALIDATION_ERROR', 'SKILL_REGISTRY_UNAVAILABLE'])
    })
  })
})
