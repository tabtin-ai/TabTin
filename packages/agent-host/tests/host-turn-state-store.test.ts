import { beforeEach, describe, expect, it } from 'vitest'
import { createStateRoot, HostTurnStore } from '../src/state/index.js'

describe('HostTurnStore (StateRoot.turn)', () => {
  let turn: HostTurnStore

  beforeEach(() => {
    turn = new HostTurnStore()
  })

  it('有 agent_config 但组织 YOLO 未知时不可 compose（禁止当未开放）', () => {
    turn.upsertAgent({
      agentId: 'a1',
      customRules: '说中文',
      agentConfigRaw: { schema_version: 3, security: { approval_grant: 'auto' } },
    })
    turn.upsertWorkspace({
      workspaceId: 'w1',
      approvalGrant: 'full_access',
    })
    expect(turn.canCompose('a1', 'w1')).toBe(false)
    expect(turn.compose('a1', 'w1')).toBeNull()

    turn.upsertAgent({
      agentId: 'a1',
      organizationAllowMemberYolo: false,
    })
    expect(turn.canCompose('a1', 'w1')).toBe(true)
    const bundle = turn.compose('a1', 'w1')
    expect(bundle?.resolvedAgentId).toBe('a1')
    expect(bundle?.agentConfig.security.allow_yolo_mode).not.toBe(true)
    expect(bundle?.profile.customRules).toBe('说中文')
  })

  it('hydrate 后可 compose，且后续规则推送零 HTTP 语义下仍可用', () => {
    turn.ingestDetails({
      agentId: 'a1',
      workspaceId: 'w1',
      agentData: {
        display_name: 'Tin',
        custom_rules: '旧规则',
        personal_rules: '简洁',
        organization_allow_member_yolo: true,
        agent_config: {
          schema_version: 3,
          runtime_plane: 'local',
          security: { approval_grant: 'auto' },
        },
      },
      workspaceData: {
        custom_rules: '禁止 force push',
        approval_grant: 'full_access',
        execution_limits: { enabled: true, max_iterations_per_run: 10 },
      },
    })

    expect(turn.canCompose('a1', 'w1')).toBe(true)
    const before = turn.compose('a1', 'w1')
    expect(before?.profile.customRules).toBe('旧规则')
    expect(before?.agentConfig.security.approval_grant).toBe('full_access')

    turn.upsertAgent({ agentId: 'a1', customRules: '新规则' })
    const after = turn.compose('a1', 'w1')
    expect(after?.profile.customRules).toBe('新规则')
    expect(after?.agentConfig.security.approval_grant).toBe('full_access')
  })

  it('clear 指定 agent 后不可再 compose', () => {
    turn.ingestDetails({
      agentId: 'a1',
      workspaceId: 'w1',
      agentData: {
        organization_allow_member_yolo: false,
        agent_config: { schema_version: 3, security: {} },
      },
      workspaceData: { approval_grant: 'always_ask' },
    })
    turn.clear({ agentId: 'a1' })
    expect(turn.canCompose('a1', 'w1')).toBe(false)
  })

  it('局部 upsert 不覆盖未提供字段', () => {
    turn.ingestDetails({
      agentId: 'a1',
      workspaceId: 'w1',
      agentData: {
        custom_rules: 'agent-rule',
        personal_rules: 'personal',
        organization_allow_member_yolo: true,
        agent_config: { schema_version: 3, security: { approval_grant: 'auto' } },
      },
      workspaceData: {
        custom_rules: 'ws-rule',
        approval_grant: 'auto',
      },
    })

    turn.upsertWorkspace({
      workspaceId: 'w1',
      approvalGrant: 'full_access',
    })
    turn.upsertAgent({
      agentId: 'a1',
      personalRules: 'new-personal',
    })

    const bundle = turn.compose('a1', 'w1')
    expect(bundle?.profile.customRules).toBe('agent-rule')
    expect(bundle?.profile.workspaceRules).toBe('ws-rule')
    expect(bundle?.profile.personalRules).toBe('new-personal')
    expect(bundle?.agentConfig.security.approval_grant).toBe('full_access')
  })

  it('显式清空 organization_allow_member_yolo 后不可 compose（未知≠未开放）', () => {
    turn.ingestDetails({
      agentId: 'a1',
      workspaceId: 'w1',
      agentData: {
        organization_allow_member_yolo: true,
        agent_config: {
          schema_version: 3,
          security: { allow_yolo_mode: true, approval_grant: 'auto' },
        },
      },
      workspaceData: { approval_grant: 'full_access' },
    })
    expect(turn.canCompose('a1', 'w1')).toBe(true)
    expect(turn.compose('a1', 'w1')?.agentConfig.security.approval_grant)
      .toBe('full_access')

    turn.upsertAgent({
      agentId: 'a1',
      organizationAllowMemberYolo: null,
    })
    expect(turn.canCompose('a1', 'w1')).toBe(false)
    expect(turn.compose('a1', 'w1')).toBeNull()
  })

  it('两个 StateRoot 互不串 turn 状态', () => {
    const a = createStateRoot()
    const b = createStateRoot()
    a.turn.upsertAgent({
      agentId: 'a1',
      organizationAllowMemberYolo: false,
      agentConfigRaw: { schema_version: 3, security: {} },
    })
    a.turn.upsertWorkspace({ workspaceId: 'w1' })
    expect(a.turn.canCompose('a1', 'w1')).toBe(true)
    expect(b.turn.canCompose('a1', 'w1')).toBe(false)
  })

  it('原子应用完整权威快照', () => {
    turn.applySnapshot({
      organizationId: 'o1',
      organizationDetail: { id: 'o1', name: 'Organization' },
      agentDetail: {
        id: 'a1',
        organization_id: 'o1',
        agent_config: { schema_version: 3, security: {} },
        organization_allow_member_yolo: false,
        custom_rules: '规则',
        goal: '完整详情中的目标',
      },
      workspaceDetail: {
        id: 'w1',
        organization_id: 'o1',
        working_dir: '/tmp/w1',
        working_dir_type: 'code',
        approval_grant: 'always_ask',
        custom_rules: 'Workspace 规则',
      },
      runtimeConfig: {
        operationSwitches: { git_push: 'confirm' },
        memoryCapability: true,
        enabledApps: [{ key: 'tabdoc', displayName: '文档', capability: 'document' }],
      },
    })
    const bundle = turn.compose('a1', 'w1')
    expect(bundle?.profile.customRules).toBe('规则')
    expect(bundle?.profile.workspaceRules).toBe('Workspace 规则')
    expect(bundle?.workspaceDetail?.working_dir).toBe('/tmp/w1')
    expect(bundle?.organizationDetail?.name).toBe('Organization')
    expect(bundle?.runtimeConfig?.operationSwitches).toEqual({ git_push: 'confirm' })
    expect(bundle?.runtimeConfig?.memoryCapability).toBe(true)
    expect(bundle?.runtimeConfig?.enabledApps?.[0]?.key).toBe('tabdoc')
    expect(turn.getAgent('a1')?.detail?.goal).toBe('完整详情中的目标')
  })

  it('同一 Workspace 的多个 Agent 各自保留 operation switches', () => {
    const snapshot = {
      organizationId: 'o1',
      organizationDetail: { id: 'o1', name: 'Organization' },
      workspaceDetail: {
        id: 'w1',
        organization_id: 'o1',
        working_dir: '/tmp/w1',
        working_dir_type: 'code',
        approval_grant: 'always_ask' as const,
      },
    }
    turn.replaceSnapshots([
      {
        ...snapshot,
        agentDetail: {
          id: 'strict-agent',
          organization_id: 'o1',
          agent_config: {},
          organization_allow_member_yolo: false,
        },
        runtimeConfig: {
          operationSwitches: { git_push: 'block' as const },
          memoryCapability: true,
          enabledApps: [],
        },
      },
      {
        ...snapshot,
        agentDetail: {
          id: 'open-agent',
          organization_id: 'o1',
          agent_config: {},
          organization_allow_member_yolo: false,
        },
        runtimeConfig: {
          operationSwitches: { git_push: 'allow' as const },
          memoryCapability: true,
          enabledApps: [],
        },
      },
    ])

    expect(turn.compose('strict-agent', 'w1')?.runtimeConfig?.operationSwitches)
      .toEqual({ git_push: 'block' })
    expect(turn.compose('open-agent', 'w1')?.runtimeConfig?.operationSwitches)
      .toEqual({ git_push: 'allow' })
  })

  it('整批替换会移除服务端已删除的上下文', () => {
    turn.applySnapshot({
      organizationId: 'org-old',
      organizationDetail: { id: 'org-old', name: 'Old Organization' },
      agentDetail: {
        id: 'agent-old',
        organization_id: 'org-old',
        agent_config: {},
        organization_allow_member_yolo: false,
      },
      workspaceDetail: {
        id: 'workspace-old',
        organization_id: 'org-old',
        working_dir: '/tmp/old',
        working_dir_type: 'code',
        approval_grant: 'always_ask',
      },
      runtimeConfig: { operationSwitches: {}, memoryCapability: false, enabledApps: [] },
    })

    turn.replaceSnapshots([])

    expect(turn.getAgent('agent-old')).toBeUndefined()
    expect(turn.getWorkspace('workspace-old')).toBeUndefined()
  })

  it('整批快照校验失败时保留上一份可用状态', () => {
    turn.applySnapshot({
      organizationId: 'org-old',
      organizationDetail: { id: 'org-old', name: 'Old Organization' },
      agentDetail: {
        id: 'agent-old',
        organization_id: 'org-old',
        agent_config: {},
        organization_allow_member_yolo: false,
      },
      workspaceDetail: {
        id: 'workspace-old',
        organization_id: 'org-old',
        working_dir: '/tmp/old',
        working_dir_type: 'code',
        approval_grant: 'always_ask',
      },
      runtimeConfig: { operationSwitches: {}, memoryCapability: false, enabledApps: [] },
    })

    expect(() => turn.replaceSnapshots([{
      organizationId: 'org-new',
      organizationDetail: { id: 'org-new', name: 'New Organization' },
      agentDetail: {
        id: 'agent-new',
        organization_id: 'different-org',
        agent_config: {},
        organization_allow_member_yolo: false,
      },
      workspaceDetail: {
        id: 'workspace-new',
        organization_id: 'org-new',
        working_dir: '/tmp/new',
        working_dir_type: 'code',
        approval_grant: 'always_ask',
      },
      runtimeConfig: { operationSwitches: {}, memoryCapability: false, enabledApps: [] },
    }])).toThrow('incomplete security state')

    expect(turn.canCompose('agent-old', 'workspace-old')).toBe(true)
    expect(turn.canCompose('agent-new', 'workspace-new')).toBe(false)
  })

  it('拒绝缺少安全字段的快照且不留下半状态', () => {
    const incompleteSnapshot = {
      organizationId: 'o1',
      organizationDetail: { id: 'o1', name: 'Organization' },
      agentDetail: {
        id: 'a1',
        organization_id: 'o1',
        agent_config: { schema_version: 3, security: {} },
        organization_allow_member_yolo: false,
      },
      workspaceDetail: {
        id: 'w1',
        organization_id: 'o1',
        working_dir: '/tmp/w1',
        working_dir_type: 'code',
        approval_grant: 'always_ask' as const,
      },
      runtimeConfig: { operationSwitches: {}, memoryCapability: false, enabledApps: [] },
    }
    Reflect.deleteProperty(
      incompleteSnapshot.agentDetail,
      'organization_allow_member_yolo',
    )

    expect(() => turn.applySnapshot(incompleteSnapshot)).toThrow('incomplete security state')
    expect(turn.canCompose('a1', 'w1')).toBe(false)
  })
})
