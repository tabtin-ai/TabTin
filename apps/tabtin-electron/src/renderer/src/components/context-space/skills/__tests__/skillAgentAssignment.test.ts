import { describe, expect, it } from 'vitest'
import {
  buildAgentIdsBySkillKey,
  buildSkillImportRequestItems,
  isAgentCarryingSkill,
  resolveAgentIdForOrganization,
  resolveEnableAgentIdsForSpaces,
  resolveAgentLabel,
  resolveLockedAssignedAgentIds,
  shouldSeedSelectionFromAssignments,
  withImplicitDefaultAgentDeviceAssignments,
} from '../skillAgentAssignment'

describe('创建后按工作空间启用', () => {
  it('把勾选的工作空间解析为其执行 Agent，而不是只使用当前选中的 Agent', () => {
    expect(resolveEnableAgentIdsForSpaces({
      spaces: [
        { id: 'workspace-default', agent_id: 'agent-default' },
        { id: 'workspace-project', execution_agent_id: 'agent-project' },
      ],
      selectedSpaceIds: ['workspace-default', 'workspace-project'],
      currentSpaceId: 'workspace-default',
      selectedAgentId: 'agent-stale',
    })).toEqual(['agent-default', 'agent-project'])
  })

  it('Skill 市场页没有全局选中 Agent 时，仍使用当前工作空间已绑定的 Agent', () => {
    expect(resolveEnableAgentIdsForSpaces({
      spaces: [{ id: 'workspace-default', agent_id: 'agent-default' }],
      selectedSpaceIds: ['workspace-default'],
      currentSpaceId: 'workspace-default',
      selectedAgentId: null,
    })).toEqual(['agent-default'])
  })

  it('当前工作空间尚未回填绑定字段时，允许回退到当前选中的 Agent', () => {
    expect(resolveEnableAgentIdsForSpaces({
      spaces: [{ id: 'workspace-default' }],
      selectedSpaceIds: ['workspace-default'],
      currentSpaceId: 'workspace-default',
      selectedAgentId: 'agent-current',
    })).toEqual(['agent-current'])
  })

  it('任一勾选工作空间没有可用 Agent 时返回 blocked，不能假装启用成功', () => {
    expect(resolveEnableAgentIdsForSpaces({
      spaces: [
        { id: 'workspace-default', agent_id: 'agent-default' },
        { id: 'workspace-unconfigured' },
      ],
      selectedSpaceIds: ['workspace-default', 'workspace-unconfigured'],
      currentSpaceId: 'workspace-default',
      selectedAgentId: 'agent-default',
    })).toBeNull()
  })
})

describe('导入后启用请求契约', () => {
  it('为每个导入项携带已解析的 enable_agent_ids', () => {
    expect(buildSkillImportRequestItems([
      { url: 'https://example.com/SKILL.md' },
      { name: 'local-skill', files: [{ path: 'SKILL.md', content: '# Skill' }] },
    ], ['agent-a'])).toEqual([
      {
        url: 'https://example.com/SKILL.md',
        enable_agent_ids: ['agent-a'],
      },
      {
        name: 'local-skill',
        files: [{ path: 'SKILL.md', content: '# Skill' }],
        enable_agent_ids: ['agent-a'],
      },
    ])
  })

  it('没有启用目标时不向请求写入 enable_agent_ids', () => {
    expect(buildSkillImportRequestItems([
      { url: 'https://example.com/SKILL.md' },
    ])).toEqual([
      { url: 'https://example.com/SKILL.md' },
    ])
  })
})

describe('resolveAgentIdForOrganization', () => {
  it('切换组织后不复用旧组织的 selectedAgent', () => {
    expect(resolveAgentIdForOrganization({
      id: 'agent-a',
      organization_id: 'org-a',
    }, 'org-b')).toBeNull()
  })

  it('当前组织的 selectedAgent 可以用于 Skill 变更', () => {
    expect(resolveAgentIdForOrganization({
      id: 'agent-a',
      organization_id: 'org-a',
    }, 'org-a')).toBe('agent-a')
  })
})

describe('resolveAgentLabel', () => {
  it('启用结果优先显示 Agent 展示名，而不是原始 ID', () => {
    expect(resolveAgentLabel({
      id: 'effcba33-3c3b-4b1e-b644-fdd9a1d5fa11',
      organization_id: 'org-a',
      name: 'general-assistant',
      display_name: '小Tin',
    }, 'effcba33-3c3b-4b1e-b644-fdd9a1d5fa11')).toBe('小Tin')
  })
})

describe('isAgentCarryingSkill', () => {
  it('以 agent_enabled 为准：总闸关但子开关开仍算已配置给 Agent', () => {
    expect(isAgentCarryingSkill({
      enabled: false,
      agent_enabled: true,
      skill_canonical_key: 'user:demo',
    })).toBe(true)
  })

  it('agent_enabled=false 时不算携带，即使合成 enabled 为 true', () => {
    expect(isAgentCarryingSkill({
      enabled: true,
      agent_enabled: false,
      skill_canonical_key: 'user:demo',
    })).toBe(false)
  })

  it('旧响应缺 agent_enabled 时回退 enabled', () => {
    expect(isAgentCarryingSkill({
      enabled: true,
      skill_canonical_key: 'user:demo',
    })).toBe(true)
    expect(isAgentCarryingSkill({
      enabled: false,
      skill_canonical_key: 'user:demo',
    })).toBe(false)
  })
})

describe('buildAgentIdsBySkillKey', () => {
  it('按 agent_enabled 聚合，不被合成 enabled=false 滤掉', () => {
    const map = buildAgentIdsBySkillKey(
      [{ id: 'a1' }, { id: 'a2' }],
      [
        [{ skill_canonical_key: 'user:demo', enabled: false, agent_enabled: true }],
        [{ skill_canonical_key: 'user:demo', enabled: true, agent_enabled: true }],
      ],
    )
    expect(map.get('user:demo')).toEqual(['a1', 'a2'])
  })
})

describe('resolveLockedAssignedAgentIds', () => {
  const agents = [
    { id: 'default-agent', is_default: true },
    { id: 'custom-agent', is_default: false },
  ]

  it('只锁定已配置给默认 Agent 的平台 / App / 本机 Skill', () => {
    expect(resolveLockedAssignedAgentIds(
      agents,
      ['default-agent', 'custom-agent'],
      'app:tabtin-dev-toolkit-pack/code-safety-audit',
      'app',
    )).toEqual(new Set(['default-agent']))

    expect(resolveLockedAssignedAgentIds(
      agents,
      ['default-agent'],
      'platform:built-in',
      'user',
    )).toEqual(new Set(['default-agent']))
  })

  it('用户 Skill 和尚未配置的默认 Agent 不锁定', () => {
    expect(resolveLockedAssignedAgentIds(
      agents,
      ['default-agent'],
      'user:custom-skill',
      'user',
    )).toEqual(new Set())

    expect(resolveLockedAssignedAgentIds(
      agents,
      ['custom-agent'],
      'app:tabtin-dev-toolkit-pack/code-safety-audit',
      'app',
    )).toEqual(new Set())
  })

  it('默认 Agent 已携带的本机 Skill 也锁定', () => {
    expect(resolveLockedAssignedAgentIds(
      agents,
      ['default-agent', 'custom-agent'],
      'device:local-helper',
      'device',
    )).toEqual(new Set(['default-agent']))
  })
})

describe('withImplicitDefaultAgentDeviceAssignments', () => {
  const agents = [
    { id: 'default-agent', is_default: true },
    { id: 'custom-agent', is_default: false },
  ]

  it('把未携带的本机 Skill 算到小Tin 身上', () => {
    const map = withImplicitDefaultAgentDeviceAssignments(
      new Map(),
      agents,
      [{ source: 'device', skill_key: 'device:local-helper' }],
    )
    expect(map.get('device:local-helper')).toEqual(['default-agent'])
  })

  it('默认 Agent 已有携带行时不回填', () => {
    const map = withImplicitDefaultAgentDeviceAssignments(
      new Map(),
      agents,
      [{ source: 'device', skill_key: 'device:local-helper' }],
      new Set(['device:local-helper']),
    )
    expect(map.get('device:local-helper')).toBeUndefined()
  })
})

describe('shouldSeedSelectionFromAssignments', () => {
  it('仅在弹窗打开且尚未用服务端携带集初始化过时播种', () => {
    expect(shouldSeedSelectionFromAssignments({
      open: true,
      assignmentsLoading: false,
      seededForOpen: false,
    })).toBe(true)
  })

  it('加载中不播种，避免用空列表清空勾选', () => {
    expect(shouldSeedSelectionFromAssignments({
      open: true,
      assignmentsLoading: true,
      seededForOpen: false,
    })).toBe(false)
  })

  it('同一次打开期间不因 props 刷新再次覆盖本地勾选', () => {
    expect(shouldSeedSelectionFromAssignments({
      open: true,
      assignmentsLoading: false,
      seededForOpen: true,
    })).toBe(false)
  })

  it('关闭后允许下次打开重新播种', () => {
    expect(shouldSeedSelectionFromAssignments({
      open: false,
      assignmentsLoading: false,
      seededForOpen: true,
    })).toBe(false)
  })
})
