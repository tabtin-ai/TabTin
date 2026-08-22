import { describe, expect, it } from 'vitest'
import { SETTINGS_SIDEBAR_GROUPS } from './settingsNavigation'

describe('SETTINGS_SIDEBAR_GROUPS', () => {
  it('账号设备入口交由组织级版本灰度决定', () => {
    const profileGroup = SETTINGS_SIDEBAR_GROUPS.find(group => group.category === 'profile')
    const sections = profileGroup?.subgroups.flatMap(subgroup => (
      subgroup.items.map(item => item.section)
    )) ?? []

    expect(sections).toContain('devices')
  })

  it('设置侧栏不重复展示主导航已有的 Agent 与技能库入口', () => {
    const profileGroup = SETTINGS_SIDEBAR_GROUPS.find(group => group.category === 'profile')
    const sections = profileGroup?.subgroups.flatMap(subgroup => (
      subgroup.items.map(item => item.section)
    )) ?? []

    expect(sections).not.toContain('myAgents')
    expect(sections).not.toContain('skillLibrary')
  })

  it('设备状态侧栏隐藏 MCP 连接入口', () => {
    const deviceGroup = SETTINGS_SIDEBAR_GROUPS.find(group => group.category === 'device')
    const sections = deviceGroup?.subgroups.flatMap(subgroup => (
      subgroup.items.map(item => item.section)
    )) ?? []

    expect(sections).not.toContain('advancedConnections')
  })

  it('组织侧栏不再展示外部联系人入口', () => {
    const organizationGroup = SETTINGS_SIDEBAR_GROUPS.find(group => group.category === 'organization')
    const sections = organizationGroup?.subgroups.flatMap(subgroup => (
      subgroup.items.map(item => item.section)
    )) ?? []

    expect(sections).not.toContain('externalContacts')
  })
})
