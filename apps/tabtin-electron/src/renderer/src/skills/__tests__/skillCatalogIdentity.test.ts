import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '../types'
import { mergeSkillCatalogEntries } from '../skillCatalogIdentity'

function userSkill(partial: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: 'skill-default',
    skill_key: 'user:same-slug',
    slug: 'same-slug',
    name: 'Same slug',
    source: 'user',
    ...partial,
  }
}

describe('能力市场云端 Skill 记录身份', () => {
  it('我的私有 Skill 与同 slug 的组织快照同时保留', () => {
    const mine = userSkill({
      skill_id: 'skill-private',
      visibility: 'private',
      owner_user_id: 'user-me',
    })
    const organizationSnapshot = userSkill({
      skill_id: 'skill-organization-snapshot',
      visibility: 'organization',
      organization_id: 'org-a',
      owner_user_id: 'user-other',
    })

    expect(mergeSkillCatalogEntries([mine, organizationSnapshot])).toEqual([
      mine,
      organizationSnapshot,
    ])
  })

  it('同 slug 的两条组织快照作为独立资产同时保留', () => {
    const firstSnapshot = userSkill({
      skill_id: 'skill-organization-snapshot-a',
      visibility: 'organization',
      organization_id: 'org-a',
      owner_user_id: 'user-a',
    })
    const secondSnapshot = userSkill({
      skill_id: 'skill-organization-snapshot-b',
      visibility: 'organization',
      organization_id: 'org-a',
      owner_user_id: 'user-b',
    })

    expect(mergeSkillCatalogEntries([firstSnapshot, secondSnapshot])).toEqual([
      firstSnapshot,
      secondSnapshot,
    ])
  })

  it('展示身份不改写 Agent 运行时 skill_key', () => {
    const snapshot = userSkill({
      skill_id: 'skill-organization-snapshot',
      visibility: 'organization',
      organization_id: 'org-a',
    })

    const [merged] = mergeSkillCatalogEntries([snapshot])

    expect(merged).toBe(snapshot)
    expect(merged.skill_key).toBe('user:same-slug')
  })

  it('Personal Plugin 运行时条目仍按 canonical key 抢占普通条目', () => {
    const pluginRuntime = userSkill({
      skill_id: 'user:same-slug',
      meta: { personal_plugin_id: 'plugin-a' },
    })
    const ordinaryRuntime = userSkill({ skill_id: 'user:same-slug' })

    expect(mergeSkillCatalogEntries([pluginRuntime, ordinaryRuntime])).toEqual([
      pluginRuntime,
    ])
  })
})
