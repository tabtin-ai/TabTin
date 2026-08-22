import { describe, expect, it } from 'vitest'
import {
  canAssignSkillToAgent,
  canToggleSkillAvailability,
  isDefaultAgentSystemKitSkill,
  isSkillEnabledInCurrentSpace,
  isSkillInstalledInSpace,
} from '../skillPanelFilters'
import type { SkillIndexEntry } from '@/skills/types'

function skill(partial: Partial<SkillIndexEntry> & Pick<SkillIndexEntry, 'source' | 'skill_key'>): SkillIndexEntry {
  return {
    skill_id: partial.skill_id ?? partial.skill_key,
    slug: partial.slug ?? 'demo',
    name: partial.name ?? 'demo',
    description: partial.description ?? '',
    enabled: partial.enabled,
    installed: partial.installed,
    installed_version_seq: partial.installed_version_seq,
    ...partial,
  } as SkillIndexEntry
}

describe('skillPanelFilters user-gate opt-out', () => {
  it('本机扫描：扫到即已安装；缺 enabled 字段 = 总闸开', () => {
    const device = skill({ source: 'device', skill_key: 'device:local-cli' })
    expect(isSkillInstalledInSpace(device, {})).toBe(true)
    expect(isSkillEnabledInCurrentSpace(device)).toBe(true)
  })

  it('仅显式 enabled===false 为关', () => {
    const off = skill({ source: 'device', skill_key: 'device:local-cli', enabled: false })
    const on = skill({ source: 'device', skill_key: 'device:local-cli', enabled: true })
    expect(isSkillEnabledInCurrentSpace(off)).toBe(false)
    expect(isSkillEnabledInCurrentSpace(on)).toBe(true)
  })

  it('platform 内置仍恒开', () => {
    const platform = skill({
      source: 'platform',
      skill_key: 'platform:table',
      distribution: 'builtin',
    })
    expect(isSkillEnabledInCurrentSpace(platform)).toBe(true)
  })

  it('技能库页不再展示总闸开关', () => {
    expect(canToggleSkillAvailability(skill({ source: 'device', skill_key: 'device:x' }))).toBe(false)
    expect(canToggleSkillAvailability(skill({ source: 'user', skill_key: 'user:x' }))).toBe(false)
  })

  it('系统套件含平台、内置 App、本机，不含货架压缩包', () => {
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'platform',
      skill_key: 'platform:device/operations',
    }))).toBe(true)
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'app',
      skill_key: 'app:tabdata/table-operator',
      distribution: 'builtin',
    }))).toBe(true)
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'device',
      skill_key: 'device:local-helper',
    }))).toBe(true)
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'app',
      skill_key: 'app:tabtin-writing-tools-pack/humanizer-zh',
      distribution: 'marketplace',
    }))).toBe(false)
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'app',
      skill_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
      distribution: 'marketplace',
    }))).toBe(false)
    expect(isDefaultAgentSystemKitSkill(skill({
      source: 'user',
      skill_key: 'user:my-skill',
    }))).toBe(false)
  })

  it('其他分身添加池排除系统套件', () => {
    const device = skill({ source: 'device', skill_key: 'device:local-helper' })
    const user = skill({ source: 'user', skill_key: 'user:my-skill' })
    expect(canAssignSkillToAgent(device, { isDefaultAgent: true })).toBe(true)
    expect(canAssignSkillToAgent(device, { isDefaultAgent: false })).toBe(false)
    expect(canAssignSkillToAgent(user, { isDefaultAgent: false })).toBe(true)
  })

})
