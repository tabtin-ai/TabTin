import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import {
  canEditSkillFiles,
  getSkillDetailKind,
  getSkillDetailProductState,
  isBuiltinCatalogSkill,
  isFirstPartyStarterPackSkill,
} from '../skillProductState'

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: 'skill-1',
    skill_key: 'user:demo',
    name: 'Demo',
    source: 'user',
    owner_user_id: 'user-1',
    visibility: 'private',
    has_published: false,
    ...overrides,
  }
}

describe('skillProductState', () => {
  it('Mine tab：owner 自己的 user skill 给管理动作 + 删除；不再暴露总闸开关', () => {
    const state = getSkillDetailProductState(skill({}), 'user-1', 'mine')

    expect(state.detailKind).toBe('my_skill')
    expect(state.canToggleAvailability).toBe(false)
    expect(state.canShowSaveAsCopy).toBe(false)
    // 系统不判断内容成熟度：owner 私有 Skill 可直接团队可见。
    expect(state.canShowMakeTeamVisible).toBe(true)
    expect(state.canShowChangeCategory).toBe(true)
    expect(state.canShowDelete).toBe(true)
  })

  it('Installed tab：技能库无总闸开关；marketplace 走卸载心智', () => {
    const mine = getSkillDetailProductState(skill({}), 'user-1', 'enabled')
    expect(mine.canToggleAvailability).toBe(false)

    const team = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'organization' }), 'user-1', 'enabled',
    )
    expect(team.detailKind).toBe('organization_skill')
    expect(team.canToggleAvailability).toBe(false)
    expect(team.canShowUninstall).toBe(false)

    const marketplace = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'public' }), 'user-1', 'enabled',
    )
    expect(marketplace.detailKind).toBe('marketplace_installed')
    expect(marketplace.canToggleAvailability).toBe(false)
    expect(marketplace.canShowUninstall).toBe(true)

    const builtin = getSkillDetailProductState(
      skill({ source: 'platform', owner_user_id: '' }), 'user-1', 'enabled',
    )
    expect(builtin.detailKind).toBe('builtin')
    expect(builtin.canToggleAvailability).toBe(false)

    const marketplaceApp = getSkillDetailProductState(
      skill({
        source: 'app',
        distribution: 'marketplace',
        skill_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
        owner_user_id: '',
      }),
      'user-1',
      'enabled',
    )
    expect(marketplaceApp.detailKind).toBe('marketplace_installed')
    expect(marketplaceApp.canToggleAvailability).toBe(false)
    expect(marketplaceApp.canShowUninstall).toBe(true)
  })

  it('技能库详情各 tab 均不暴露用户总闸开关', () => {
    expect(getSkillDetailProductState(skill({}), 'user-1', 'mine').canToggleAvailability).toBe(false)
    const org = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'organization' }), 'user-1', 'organization',
    )
    expect(org.detailKind).toBe('organization_skill')
    expect(org.canToggleAvailability).toBe(false)
    expect(org.canShowSaveAsCopy).toBe(true)
    expect(org.canShowForkToMine).toBe(false)
    const notOwner = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'organization' }), 'user-1', 'mine',
    )
    expect(notOwner.canToggleAvailability).toBe(false)
    expect(notOwner.canShowDelete).toBe(false)
    expect(notOwner.canShowRemoveFromMine).toBe(false)
    expect(notOwner.canShowSaveAsCopy).toBe(true)
  })

  it('Mine tab：从组织精选获取的非本人 Skill 可删除自己的接入，不影响原件', () => {
    const acquired = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'organization', acquired: true }),
      'user-1',
      'mine',
    )

    expect(acquired.canShowDelete).toBe(false)
    expect(acquired.canShowRemoveFromMine).toBe(true)
    expect(acquired.canShowRemoveFromOrg).toBe(false)

    const builtin = getSkillDetailProductState(
      skill({ source: 'platform', owner_user_id: '', acquired: true }),
      'user-1',
      'mine',
    )
    expect(builtin.canShowRemoveFromMine).toBe(false)
  })

  it('Mine tab：已获取的市场压缩包可从我的删除，原件仍留在货架', () => {
    const marketPack = getSkillDetailProductState(
      skill({
        source: 'app',
        distribution: 'marketplace',
        skill_key: 'app:tabtin-business-analysis-pack/legal-risk-analyzer',
        owner_user_id: '',
        acquired: true,
      }),
      'user-1',
      'mine',
    )
    expect(marketPack.detailKind).toBe('marketplace_installed')
    expect(marketPack.canShowDelete).toBe(false)
    expect(marketPack.canShowUninstall).toBe(false)
    expect(marketPack.canShowRemoveFromMine).toBe(true)

    const unacquired = getSkillDetailProductState(
      skill({
        source: 'app',
        distribution: 'marketplace',
        skill_key: 'app:tabtin-business-analysis-pack/legal-risk-analyzer',
        owner_user_id: '',
        acquired: false,
      }),
      'user-1',
      'mine',
    )
    expect(unacquired.canShowRemoveFromMine).toBe(false)
  })

  it('删除：owner 在 Mine 只能删除私有原件；组织快照即使误入 Mine 也无管理动作', () => {
    const orgVisible = getSkillDetailProductState(
      skill({ has_published: true, visibility: 'organization' }), 'user-1', 'mine',
    )
    expect(orgVisible.detailKind).toBe('organization_skill')
    expect(orgVisible.canShowDelete).toBe(false)
    expect(orgVisible.canShowRemoveFromOrg).toBe(false)
    expect(orgVisible.canShowMakeTeamVisible).toBe(false)

    const unversioned = getSkillDetailProductState(skill({ has_published: false }), 'user-1', 'mine')
    expect(unversioned.canShowDelete).toBe(true)
  })

  it('已发布 owner skill 在 Mine 始终可删（owner id 规范化后匹配）', () => {
    const published = getSkillDetailProductState(
      skill({ has_published: true, owner_user_id: 'USER-1', visibility: 'private' }),
      'user-1',
      'mine',
    )
    expect(published.detailKind).toBe('my_skill')
    expect(published.canShowDelete).toBe(true)
  })

  it('文件编辑：Mine 中本人创建的 Skill 可编辑，组织精选浏览场景只读', () => {
    expect(canEditSkillFiles(skill({}), 'user-1', 'mine', 'wt-1')).toBe(true)
    expect(canEditSkillFiles(skill({}), '', 'mine', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ owner_user_id: '' }), 'user-1', 'mine', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ owner_user_id: 'user-2' }), 'user-1', 'mine', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({}), 'user-1', 'enabled', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({}), '', 'enabled', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ owner_user_id: 'user-2' }), 'user-1', 'enabled', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({}), 'user-1', 'organization', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ owner_user_id: 'user-2' }), 'user-1', 'organization', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ visibility: 'organization' }), 'user-1', 'mine', 'wt-1')).toBe(false)
    expect(canEditSkillFiles(skill({ source: 'platform', skill_key: 'platform:demo' }), 'user-1', 'mine', 'wt-1')).toBe(false)
  })

  it('可见性：私有原件可创建快照；组织快照可移除但不可再次共享', () => {
    const priv = getSkillDetailProductState(skill({ visibility: 'private', has_published: false }), 'user-1', 'mine')
    expect(priv.canShowMakeTeamVisible).toBe(true)
    expect(priv.canShowRemoveFromOrg).toBe(false)
    expect(priv.canShowDelete).toBe(true)

    const team = getSkillDetailProductState(skill({ visibility: 'organization', has_published: true }), 'user-1', 'mine')
    expect(team.canShowMakeTeamVisible).toBe(false)
    expect(team.canShowRemoveFromOrg).toBe(false)
    expect(team.canShowDelete).toBe(false)
    expect(team.canShowChangeCategory).toBe(false)
  })

  it('Organization tab：owner 自己共享的快照也不暴露编辑或管理动作', () => {
    const ownedOrg = getSkillDetailProductState(
      skill({ visibility: 'organization', owner_user_id: 'user-1' }),
      'user-1',
      'organization',
    )
    expect(ownedOrg.canShowDelete).toBe(false)
    expect(ownedOrg.canShowRemoveFromOrg).toBe(true)
    expect(ownedOrg.canShowChangeCategory).toBe(false)
    expect(canEditSkillFiles(
      skill({ visibility: 'organization', owner_user_id: 'user-1' }),
      'user-1',
      'organization',
      'wt-1',
    )).toBe(false)

    const teammateSkill = getSkillDetailProductState(
      skill({ visibility: 'organization', owner_user_id: 'user-2' }),
      'user-1',
      'organization',
    )
    expect(teammateSkill.canShowDelete).toBe(false)
    expect(teammateSkill.canShowRemoveFromOrg).toBe(false)
    expect(teammateSkill.canShowChangeCategory).toBe(false)
  })

  it('个人团队隐藏「设为团队可见」；多人团队才显示（owner 已发布的私有 my_skill）', () => {
    const base = skill({ visibility: 'private', has_published: true })

    // 多人团队（isPersonalOrganization=false）：显示——真有团队可分享。
    const team = getSkillDetailProductState(base, 'user-1', 'mine', false)
    expect(team.canShowMakeTeamVisible).toBe(true)

    // 个人团队（isPersonalOrganization=true）：隐藏——「团队可见」与「仅我可见」等价、是噪音。
    const personal = getSkillDetailProductState(base, 'user-1', 'mine', true)
    expect(personal.canShowMakeTeamVisible).toBe(false)

    // 默认不传第 4 参 → 向后兼容按多人团队对待 → 显示（避免信号缺失时误隐藏真团队功能）。
    const legacy = getSkillDetailProductState(base, 'user-1', 'mine')
    expect(legacy.canShowMakeTeamVisible).toBe(true)
  })

  it('Installed tab：他人组织 skill 可另存；删除仍只在 Mine / Organization 管理视角', () => {
    const installed = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'organization' }),
      'user-1',
      'enabled',
    )
    expect(installed.canShowDelete).toBe(false)
    expect(installed.canShowMakeTeamVisible).toBe(false)
    expect(installed.canShowSaveAsCopy).toBe(true)
    expect(installed.canShowDelete).toBe(false)
    expect(installed.canShowChangeCategory).toBe(false)
  })

  it('市场已装 / 内置：不提供另存为我的再编辑，也不提供另存为（无 user UUID 源）', () => {
    const marketplace = getSkillDetailProductState(
      skill({ owner_user_id: 'user-2', visibility: 'public' }),
      'user-1',
      'enabled',
    )
    expect(marketplace.detailKind).toBe('marketplace_installed')
    expect(marketplace.canShowSaveAsCopy).toBe(false)
    expect(marketplace.canShowForkToMine).toBe(false)

    const builtin = getSkillDetailProductState(
      skill({ source: 'platform', owner_user_id: '', skill_key: 'platform:demo' }),
      'user-1',
      'enabled',
    )
    expect(builtin.detailKind).toBe('builtin')
    expect(builtin.canShowSaveAsCopy).toBe(false)
    expect(builtin.canShowForkToMine).toBe(false)
  })

  it('#4140 本机互操作发现：当前 Space 可启停；可共享建组织副本；不另存、不安装', () => {
    const device = getSkillDetailProductState(
      skill({
        source: 'device',
        skill_key: 'device:local-demo',
        skill_id: 'local-demo',
        owner_user_id: '',
        path: '/Users/demo/.agents/skills/local-demo',
      }),
      'user-1',
      'mine',
    )
    expect(device.detailKind).toBe('device_local')
    expect(device.canToggleAvailability).toBe(false)
    expect(device.canShowUninstall).toBe(false)
    expect(device.canShowDelete).toBe(false)
    expect(device.canShowSaveAsCopy).toBe(false)
    expect(device.canShowForkToMine).toBe(false)
    expect(device.canShowImportToSpace).toBe(false)
    expect(device.canShowMakeTeamVisible).toBe(true)

    const devicePersonalOrg = getSkillDetailProductState(
      skill({
        source: 'device',
        skill_key: 'device:local-demo',
        skill_id: 'local-demo',
        owner_user_id: '',
        path: '/Users/demo/.agents/skills/local-demo',
      }),
      'user-1',
      'mine',
      true,
    )
    expect(devicePersonalOrg.canShowMakeTeamVisible).toBe(false)
  })

  it('首发分身预装的官方 Pack 算内置起步包，普通市场 Pack 仍是市场货', () => {
    const starter = skill({
      source: 'app',
      distribution: 'marketplace',
      skill_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
      app_id: 'tabtin-workflow-skills-pack',
      owner_user_id: '',
    })
    const starterByKeyOnly = skill({
      source: 'app',
      distribution: 'marketplace',
      skill_key: 'app:ponytail/ponytail',
      owner_user_id: '',
    })
    const starterMissingSource = {
      skill_id: 'grill-before-build',
      name: '开干前拷问',
      skill_key: 'app:tabtin-workflow-skills-pack/grill-before-build',
      distribution: 'marketplace',
    } as SkillIndexEntry
    const marketPack = skill({
      source: 'app',
      distribution: 'marketplace',
      skill_key: 'app:tabtin-office-skills-pack/meeting-notes-to-actions',
      app_id: 'tabtin-office-skills-pack',
      owner_user_id: '',
    })

    expect(isFirstPartyStarterPackSkill(starter)).toBe(true)
    expect(isFirstPartyStarterPackSkill(starterByKeyOnly)).toBe(true)
    expect(isFirstPartyStarterPackSkill(starterMissingSource)).toBe(true)
    expect(isFirstPartyStarterPackSkill(marketPack)).toBe(false)
    expect(isBuiltinCatalogSkill(starter)).toBe(true)
    expect(isBuiltinCatalogSkill(starterByKeyOnly)).toBe(true)
    expect(isBuiltinCatalogSkill(marketPack)).toBe(false)
    expect(getSkillDetailKind(starter, 'user-1')).toBe('builtin')
    expect(getSkillDetailKind(marketPack, 'user-1')).toBe('marketplace_installed')
  })
})
