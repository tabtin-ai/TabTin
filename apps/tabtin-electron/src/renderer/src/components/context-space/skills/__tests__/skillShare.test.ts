import { describe, expect, it, vi } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import {
  buildOrganizationSnapshotSlug,
  findOrganizationSlugConflict,
  nextVersionLabelForShare,
  resolveShareSourceDir,
  shareSkillToOrganization,
} from '../skillShare'

function skill(partial: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    skill_id: 's1',
    skill_key: 'user:111',
    name: '111',
    source: 'user',
    ...partial,
  }
}

describe('nextVersionLabelForShare', () => {
  it('starts at 0.0.1 then bumps patch', () => {
    expect(nextVersionLabelForShare(skill({}))).toBe('0.0.1')
    expect(nextVersionLabelForShare(skill({ latest_version_label: '0.0.1' }))).toBe('0.0.2')
  })
})

describe('buildOrganizationSnapshotSlug', () => {
  it('同一组织稳定、不同组织隔离，并保持在 slug 长度限制内', () => {
    expect(buildOrganizationSnapshotSlug('daily-report', 'org-1')).toBe('daily-report-org-org1')
    expect(buildOrganizationSnapshotSlug('daily-report', 'org-2')).toBe('daily-report-org-org2')
    expect(buildOrganizationSnapshotSlug('x'.repeat(100), 'organization-123')).toHaveLength(64)
  })
})

describe('resolveShareSourceDir', () => {
  it('device skill uses path directly', async () => {
    const dir = await resolveShareSourceDir({
      skill: skill({
        source: 'device',
        path: '/Users/demo/.agents/skills/demo',
        skill_key: 'device:demo',
      }),
      spaceId: 'sp-1',
      organizationId: 'org-1',
      resolveLocalPath: vi.fn(),
    })
    expect(dir).toBe('/Users/demo/.agents/skills/demo')
  })

  it('本机原件缺失时恢复云端最新发布版本，再返回恢复后的目录', async () => {
    const resolveLocalPath = vi.fn()
      .mockResolvedValueOnce({ skillDir: '/skills/demo', mdExists: false })
      .mockResolvedValueOnce({ skillDir: '/skills/demo', mdExists: true })
    const restorePublishedVersion = vi.fn().mockResolvedValue(undefined)
    const source = skill({
      package_id: 'pkg-1',
      latest_version_seq: 3,
      path: '',
    })

    const dir = await resolveShareSourceDir({
      skill: source,
      spaceId: 'sp-1',
      organizationId: 'org-1',
      resolveLocalPath,
      restorePublishedVersion,
    })

    expect(dir).toBe('/skills/demo')
    expect(restorePublishedVersion).toHaveBeenCalledWith({
      skill: source,
      spaceId: 'sp-1',
      organizationId: 'org-1',
      versionSeq: 3,
    })
    expect(resolveLocalPath).toHaveBeenCalledTimes(2)
  })

  it('本机原件与云端发布版本都不存在时返回明确不可恢复错误', async () => {
    await expect(resolveShareSourceDir({
      skill: skill({ package_id: undefined, latest_version_seq: null, path: '' }),
      spaceId: 'sp-1',
      organizationId: 'org-1',
      resolveLocalPath: vi.fn().mockResolvedValue({ skillDir: '/skills/demo', mdExists: false }),
      restorePublishedVersion: vi.fn(),
    })).rejects.toThrow('该 Skill 从未发布且本机原件已丢失，无法恢复')
  })

  it('本机原件存在时不请求云端恢复', async () => {
    const restorePublishedVersion = vi.fn()
    const dir = await resolveShareSourceDir({
      skill: skill({ package_id: 'pkg-1', latest_version_seq: 3 }),
      spaceId: 'sp-1',
      organizationId: 'org-1',
      resolveLocalPath: vi.fn().mockResolvedValue({ skillDir: '/skills/demo', mdExists: true }),
      restorePublishedVersion,
    })

    expect(dir).toBe('/skills/demo')
    expect(restorePublishedVersion).not.toHaveBeenCalled()
  })

  it('云端安装完成但 SKILL.md 未落盘时停止共享', async () => {
    const restorePublishedVersion = vi.fn().mockResolvedValue(undefined)
    await expect(resolveShareSourceDir({
      skill: skill({ package_id: 'pkg-1', latest_version_seq: 3, path: '' }),
      spaceId: 'sp-1',
      organizationId: 'org-1',
      resolveLocalPath: vi.fn().mockResolvedValue({ skillDir: '/skills/demo', mdExists: false }),
      restorePublishedVersion,
    })).rejects.toThrow('云端版本恢复后仍未找到 SKILL.md，无法共享')

    expect(restorePublishedVersion).toHaveBeenCalledOnce()
  })
})

describe('shareSkillToOrganization', () => {
  const baseDeps = {
    organizationId: 'org-1',
    displayName: 'Demo',
    resolveSkillDir: async () => '/skills/demo',
    collectFiles: async () => ({
      files: [{ path: 'SKILL.md', content: '---\nname: demo\n---\n' }],
      skipped: [],
    }),
    hasSkillMd: () => true,
    createSkill: vi.fn(),
    publishSkill: vi.fn(),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
  }

  it('我的已发布 Skill：创建组织快照，原件保持私有', async () => {
    const createSkill = vi.fn().mockResolvedValue({
      skill_id: 'snapshot-1',
      skill_key: 'user:demo-snapshot',
      name: 'Demo',
    })
    const publishSkill = vi.fn().mockResolvedValue({})
    const original = skill({
      name: 'Demo',
      visibility: 'private',
      has_published: true,
      owner_user_id: 'u1',
    })
    const result = await shareSkillToOrganization({
      ...baseDeps,
      skill: original,
      createSkill,
      publishSkill,
    })
    expect(result.mode).toBe('organization_snapshot')
    expect(result.skill.skill_id).toBe('snapshot-1')
    expect(result.skill.visibility).toBe('organization')
    expect(original.visibility).toBe('private')
    expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      name: 'Demo',
    }))
    expect(publishSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'snapshot-1',
      visibility: 'organization',
    }))
    expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({
      slug: '111-org-org1',
      slug_conflict_policy: 'reject',
    }))
  })

  it('我的未发布 Skill：也从当前文件创建独立组织快照', async () => {
    const createSkill = vi.fn().mockResolvedValue({
      skill_id: 'snapshot-2',
      skill_key: 'user:demo-snapshot',
      name: 'Demo',
    })
    const publishSkill = vi.fn().mockResolvedValue({})
    const result = await shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', has_published: false }),
      createSkill,
      publishSkill,
    })
    expect(result.mode).toBe('organization_snapshot')
    expect(createSkill).toHaveBeenCalled()
    expect(publishSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'snapshot-2',
      visibility: 'organization',
    }))
  })

  it('组织接入副本移除来源后重新共享，不重复套组织与副本后缀', async () => {
    const createSkill = vi.fn().mockResolvedValue({
      skill_id: 'snapshot-reshared',
      skill_key: 'user:test-share-delete-0-org-3bf04d7a576e',
      name: '测试共享移除',
    })

    await shareSkillToOrganization({
      ...baseDeps,
      organizationId: '3bf04d7a-576e-4df7-ab83-738abd56b9c0',
      displayName: '测试共享移除',
      skill: skill({
        skill_key: 'user:test-share-delete-0-org-3bf04d7a576e-copy',
        slug: 'test-share-delete-0-org-3bf04d7a576e-copy',
        name: '测试共享移除',
        visibility: 'private',
        owner_user_id: 'u1',
      }),
      createSkill,
      publishSkill: vi.fn().mockResolvedValue({}),
    })

    expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'test-share-delete-0-org-3bf04d7a576e',
      slug_conflict_policy: 'reject',
    }))
  })

  it('重复共享不复用旧快照，重复标识错误原样返回', async () => {
    const createSkill = vi.fn().mockRejectedValue(new Error('标识名已存在'))
    const publishSkill = vi.fn()
    const deleteSkill = vi.fn()
    await expect(shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private' }),
      createSkill,
      publishSkill,
      deleteSkill,
    })).rejects.toThrow('标识名已存在')
    expect(createSkill).toHaveBeenCalled()
    expect(publishSkill).not.toHaveBeenCalled()
    expect(deleteSkill).not.toHaveBeenCalled()
  })

  it('重试共享时复用当前用户同 slug 的私有半成品', async () => {
    const createSkill = vi.fn()
    const publishSkill = vi.fn().mockResolvedValue({})
    const deleteSkill = vi.fn()
    const orphan = skill({
      skill_id: 'orphan-1',
      skill_key: 'user:111-org-org1',
      slug: '111-org-org1',
      owner_user_id: 'u1',
      visibility: 'private',
    })

    const result = await shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', owner_user_id: 'u1' }),
      currentUserId: 'u1',
      organizationSkills: [orphan],
      createSkill,
      publishSkill,
      deleteSkill,
    })

    expect(result.skill.skill_id).toBe('orphan-1')
    expect(createSkill).not.toHaveBeenCalled()
    expect(publishSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'orphan-1',
      visibility: 'organization',
    }))
    expect(deleteSkill).not.toHaveBeenCalled()
  })

  it.each([
    'Network error: Request timeout',
    '数据验证失败: 标识名已存在',
  ])('create 返回“%s”后重新拉取并恢复服务端私有半成品', async (createError) => {
    const orphan = skill({
      skill_id: 'orphan-after-timeout',
      skill_key: 'user:111-org-org1',
      slug: '111-org-org1',
      owner_user_id: 'u1',
      visibility: 'private',
    })
    const reloadSkills = vi.fn().mockResolvedValue([orphan])
    const publishSkill = vi.fn().mockResolvedValue({})

    const result = await shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', owner_user_id: 'u1' }),
      currentUserId: 'u1',
      organizationSkills: [],
      createSkill: vi.fn().mockRejectedValue(new Error(createError)),
      reloadSkills,
      publishSkill,
    })

    expect(result.skill.skill_id).toBe('orphan-after-timeout')
    expect(reloadSkills).toHaveBeenCalledOnce()
    expect(publishSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'orphan-after-timeout',
    }))
  })

  it('不复用其他用户的同 slug 私有 Skill', async () => {
    const reloadSkills = vi.fn().mockResolvedValue([
      skill({
        skill_id: 'other-user-skill',
        skill_key: 'user:111-org-org1',
        slug: '111-org-org1',
        owner_user_id: 'u2',
        visibility: 'private',
      }),
    ])
    const publishSkill = vi.fn()

    await expect(shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', owner_user_id: 'u1' }),
      currentUserId: 'u1',
      organizationSkills: [],
      createSkill: vi.fn().mockRejectedValue(new Error('标识名已存在')),
      reloadSkills,
      publishSkill,
    })).rejects.toThrow('标识名已存在')

    expect(publishSkill).not.toHaveBeenCalled()
  })

  it('publish 响应超时但服务端已完成时按组织精选结果成功收口', async () => {
    const published = skill({
      skill_id: 'snapshot-after-timeout',
      skill_key: 'user:111-org-org1',
      slug: '111-org-org1',
      owner_user_id: 'u1',
      organization_id: 'org-1',
      visibility: 'organization',
    })
    const deleteSkill = vi.fn()

    const result = await shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', owner_user_id: 'u1' }),
      currentUserId: 'u1',
      createSkill: vi.fn().mockResolvedValue({
        skill_id: 'snapshot-after-timeout',
        skill_key: 'user:111-org-org1',
        slug: '111-org-org1',
        owner_user_id: 'u1',
        visibility: 'private',
      }),
      publishSkill: vi.fn().mockRejectedValue(new Error('socket hang up')),
      reloadSkills: vi.fn().mockResolvedValue([published]),
      deleteSkill,
    })

    expect(result.skill.visibility).toBe('organization')
    expect(deleteSkill).not.toHaveBeenCalled()
  })

  it('publish 结果不确定且尚未可见时保留私有半成品供下次恢复', async () => {
    const deleteSkill = vi.fn()

    await expect(shareSkillToOrganization({
      ...baseDeps,
      skill: skill({ name: 'Demo', visibility: 'private', owner_user_id: 'u1' }),
      currentUserId: 'u1',
      createSkill: vi.fn().mockResolvedValue({
        skill_id: 'pending-1',
        skill_key: 'user:111-org-org1',
        slug: '111-org-org1',
        owner_user_id: 'u1',
        visibility: 'private',
      }),
      publishSkill: vi.fn().mockRejectedValue(new Error('Network error: Request timeout')),
      reloadSkills: vi.fn().mockResolvedValue([]),
      deleteSkill,
    })).rejects.toThrow('Request timeout')

    expect(deleteSkill).not.toHaveBeenCalled()
  })

  it('共享前对照组织精选：标识名重复则禁止 create/publish', async () => {
    const createSkill = vi.fn()
    const publishSkill = vi.fn()
    await expect(shareSkillToOrganization({
      ...baseDeps,
      skill: skill({
        source: 'device',
        skill_key: 'device:brainstorming',
        name: 'brainstorming',
        path: '/skills/brainstorming',
      }),
      displayName: 'brainstorming',
      organizationSkills: [
        skill({
          skill_id: 'org-existing',
          skill_key: 'user:brainstorming-org-org1',
          slug: 'brainstorming-org-org1',
          name: 'brainstorming',
          source: 'user',
          visibility: 'organization',
          organization_id: 'org-1',
        }),
      ],
      createSkill,
      publishSkill,
    })).rejects.toThrow(/组织内已存在相同标识名/)
    expect(createSkill).not.toHaveBeenCalled()
    expect(publishSkill).not.toHaveBeenCalled()
  })

  it('findOrganizationSlugConflict 只匹配当前组织精选', () => {
    expect(findOrganizationSlugConflict({
      snapshotSlug: 'demo-org-org1',
      organizationId: 'org-1',
      organizationSkills: [
        skill({
          slug: 'demo-org-org1',
          skill_key: 'user:demo-org-org1',
          visibility: 'organization',
          organization_id: 'org-2',
          source: 'user',
        }),
      ],
    })).toBeNull()
    expect(findOrganizationSlugConflict({
      snapshotSlug: 'demo-org-org1',
      organizationId: 'org-1',
      organizationSkills: [
        skill({
          slug: 'demo-org-org1',
          skill_key: 'user:demo-org-org1',
          visibility: 'organization',
          organization_id: 'org-1',
          source: 'user',
        }),
      ],
    })).toEqual({ slug: 'demo-org-org1' })
  })

  it('本机物化时 create 带组织专属 slug 和严格冲突策略', async () => {
    const createSkill = vi.fn().mockResolvedValue({
      skill_id: 'new-1',
      skill_key: 'user:ai-pm-self-tracking',
      name: 'Ai Pm Self Tracking',
    })
    await shareSkillToOrganization({
      ...baseDeps,
      displayName: 'Ai Pm Self Tracking',
      skill: skill({
        source: 'device',
        skill_id: undefined,
        skill_key: 'device:ai-pm-self-tracking',
        name: 'Ai Pm Self Tracking',
        path: '/skills/demo',
      }),
      createSkill,
      publishSkill: vi.fn().mockResolvedValue({}),
    })
    expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Ai Pm Self Tracking',
      slug: 'ai-pm-self-tracking-org-org1',
      slug_conflict_policy: 'reject',
    }))
  })

  it('本机物化失败会删半成品', async () => {
    const deleteSkill = vi.fn().mockResolvedValue(undefined)
    await expect(shareSkillToOrganization({
      ...baseDeps,
      skill: skill({
        source: 'device',
        skill_id: undefined,
        path: '/skills/demo',
        name: 'Demo',
      }),
      createSkill: vi.fn().mockResolvedValue({ skill_id: 'half', name: 'Demo' }),
      publishSkill: vi.fn().mockRejectedValue(new Error('发布失败硬错误')),
      deleteSkill,
    })).rejects.toThrow(/发布失败硬错误/)
    expect(deleteSkill).toHaveBeenCalledWith('half')
  })
})
