import { afterEach, describe, expect, it } from 'vitest'
import {
  clearOrganizationSettingsKnown,
  getFrontendContextReady,
  isFrontendContextReady,
  isFrontendContextReadyFor,
  isFrontendShellContextReady,
  markAgentConfigKnown,
  notifyAgentContextChanged,
  notifyOrganizationSettingsKnown,
  notifyWorkspaceContextChanged,
  resetFrontendContextReady,
  subscribeFrontendContextReady,
} from './frontend-context-ready.js'

afterEach(() => {
  resetFrontendContextReady()
})

describe('frontend-context-ready', () => {
  it('初始未 ready，allowMemberYolo 为 null', () => {
    expect(isFrontendContextReady()).toBe(false)
    expect(getFrontendContextReady()).toMatchObject({
      organizationSettingsKnown: false,
      allowMemberYolo: null,
      agentConfigKnown: false,
      approvalGrantKnown: false,
      ready: false,
    })
  })

  it('三项权威齐备后 ready', () => {
    notifyOrganizationSettingsKnown({
      id: 'org-1',
      settings: { allow_member_yolo: true },
    })
    notifyAgentContextChanged({ id: 'agent-1', agent_config: { security: {} } })
    notifyWorkspaceContextChanged({ id: 'ws-1', approval_grant: 'full_access' })
    expect(isFrontendContextReady()).toBe(true)
    expect(getFrontendContextReady().allowMemberYolo).toBe(true)
  })

  it('组织已知但未开放时 allowMemberYolo=false，不是 null', () => {
    notifyOrganizationSettingsKnown({
      id: 'org-1',
      settings: { allow_member_yolo: false },
    })
    expect(getFrontendContextReady()).toMatchObject({
      organizationSettingsKnown: true,
      allowMemberYolo: false,
    })
  })

  it('切组织 clear 后不允许用缺省 false 冒充已知', () => {
    notifyOrganizationSettingsKnown({
      id: 'org-1',
      settings: { allow_member_yolo: true },
    })
    clearOrganizationSettingsKnown('org-2')
    expect(getFrontendContextReady()).toMatchObject({
      organizationId: 'org-2',
      organizationSettingsKnown: false,
      allowMemberYolo: null,
      ready: false,
    })
  })

  it('agent 无 agent_config 时不算 known', () => {
    notifyAgentContextChanged({ id: 'agent-1' })
    expect(getFrontendContextReady().agentConfigKnown).toBe(false)
  })

  it('workspace grant 非法时不算 known', () => {
    notifyWorkspaceContextChanged({ id: 'ws-1', approval_grant: 'yolo' as 'always_ask' })
    expect(getFrontendContextReady().approvalGrantKnown).toBe(false)
  })

  it('subscribe 在状态变化时触发', () => {
    let hits = 0
    const unsub = subscribeFrontendContextReady(() => {
      hits += 1
    })
    notifyOrganizationSettingsKnown({ id: 'org-1', settings: {} })
    expect(hits).toBe(1)
    unsub()
    notifyOrganizationSettingsKnown({ id: 'org-1', settings: { allow_member_yolo: true } })
    expect(hits).toBe(1)
  })

  it('reset 清空全部', () => {
    notifyOrganizationSettingsKnown({ id: 'org-1', settings: { allow_member_yolo: true } })
    notifyAgentContextChanged({ id: 'agent-1', agent_config: {} })
    notifyWorkspaceContextChanged({ id: 'ws-1', approval_grant: 'auto' })
    resetFrontendContextReady()
    expect(isFrontendContextReady()).toBe(false)
    expect(getFrontendContextReady().organizationId).toBeNull()
    expect(getFrontendContextReady().agentId).toBeNull()
    expect(getFrontendContextReady().workspaceId).toBeNull()
  })

  it('shell ready 不要求 agent；发送可用 mark + For(agentId)', () => {
    notifyOrganizationSettingsKnown({ id: 'org-1', settings: { allow_member_yolo: true } })
    notifyWorkspaceContextChanged({ id: 'ws-1', approval_grant: 'full_access' })
    expect(isFrontendShellContextReady()).toBe(true)
    expect(isFrontendContextReady()).toBe(false)
    markAgentConfigKnown({ id: 'session-agent', agent_config: { security: {} } })
    expect(isFrontendContextReadyFor({ agentId: 'session-agent' })).toBe(true)
  })
})
