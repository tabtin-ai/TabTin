import { describe, expect, it } from 'vitest'

import type { LocalMcpCandidateSummary, LocalMcpConnectionSummary } from '@shared/types/mcp'
import {
  canUninstallMarketplaceConnector,
  diffManageableAgentAssignments,
  getConnectorMarketState,
  matchesConnectorSearch,
  shouldShowMarketplaceUninstall,
} from './connectorMarketState'

function connection(overrides: Partial<LocalMcpConnectionSummary> = {}): LocalMcpConnectionSummary {
  return {
    id: 'connection-1',
    name: 'GitHub',
    source: { kind: 'manual', label: 'Manual' },
    transportKind: 'http',
    url: 'https://example.test/mcp',
    envKeys: [],
    headerKeys: [],
    enabled: true,
    attachedAgentIds: [],
    requiresAgentSelection: false,
    createdAt: '2026-07-31T00:00:00Z',
    updatedAt: '2026-07-31T00:00:00Z',
    ...overrides,
  }
}

function candidate(overrides: Partial<LocalMcpCandidateSummary> = {}): LocalMcpCandidateSummary {
  return {
    id: 'candidate-1',
    name: 'GitHub',
    source: { kind: 'cursor', label: 'Cursor' },
    transportKind: 'stdio',
    command: 'github-mcp',
    envKeys: [],
    headerKeys: [],
    ...overrides,
  }
}

describe('getConnectorMarketState', () => {
  it('把只被本机发现的候选项标成可接入', () => {
    expect(getConnectorMarketState({ candidate: candidate() })).toMatchObject({
      lifecycle: 'available',
      action: 'connect',
      statusLabel: '从本机发现',
    })
  })

  it('连接未测试时要求继续测试，不能显示可用', () => {
    expect(getConnectorMarketState({ connection: connection() })).toMatchObject({
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '待测试',
    })
  })

  it('测试成功但未绑定 Agent 时要求继续选择 Agent', () => {
    expect(
      getConnectorMarketState({
        connection: connection({
          lastProbe: {
            ok: true,
            probedAt: '2026-07-31T01:00:00Z',
            tools: [],
            resources: [],
            prompts: [],
          },
        }),
      }),
    ).toMatchObject({
      lifecycle: 'incomplete',
      action: 'continue',
      statusLabel: '待选择 Agent',
    })
  })

  it('探测失败优先显示修复', () => {
    expect(
      getConnectorMarketState({
        connection: connection({
          lastProbe: {
            ok: false,
            probedAt: '2026-07-31T01:00:00Z',
            tools: [],
            resources: [],
            prompts: [],
            error: 'Unauthorized',
          },
        }),
      }),
    ).toMatchObject({
      lifecycle: 'needs_repair',
      action: 'repair',
      statusLabel: '连接异常',
    })
  })

  it('只有启用、测试成功且绑定 Agent 的连接才是可用', () => {
    expect(
      getConnectorMarketState({
        connection: connection({
          attachedAgentIds: ['agent-1'],
          lastProbe: {
            ok: true,
            probedAt: '2026-07-31T01:00:00Z',
            tools: [],
            resources: [],
            prompts: [],
          },
        }),
      }),
    ).toMatchObject({
      lifecycle: 'ready',
      action: 'manage',
      statusLabel: '可用',
    })
  })

  it('携带集模式：空 manageable 集会误判，传入当前分身后应为可用', () => {
    const carried = connection({
      attachedAgentIds: ['agent-scope'],
      lastProbe: {
        ok: true,
        probedAt: '2026-07-31T01:00:00Z',
        tools: [],
        resources: [],
        prompts: [],
      },
    })
    expect(
      getConnectorMarketState({
        connection: carried,
        manageableAgentIds: new Set(),
      }),
    ).toMatchObject({
      statusLabel: '待选择 Agent',
      assignedAgentCount: 0,
    })
    expect(
      getConnectorMarketState({
        connection: carried,
        manageableAgentIds: new Set(['agent-scope']),
      }),
    ).toMatchObject({
      lifecycle: 'ready',
      statusLabel: '可用',
      assignedAgentCount: 1,
    })
  })

  it('不把当前组织不可见的历史 Agent 绑定计入已配置数量', () => {
    expect(
      getConnectorMarketState({
        connection: connection({ attachedAgentIds: ['deleted-agent'] }),
        manageableAgentIds: new Set(['agent-1']),
      }),
    ).toMatchObject({
      assignedAgentCount: 0,
    })
  })
})

describe('diffManageableAgentAssignments', () => {
  it('只增删当前组织可管理的 Agent，保留跨组织历史绑定', () => {
    expect(
      diffManageableAgentAssignments(
        ['org-a-agent', 'org-b-agent', 'stale-agent'],
        new Set(['org-a-agent', 'org-a-new']),
        new Set(['org-a-agent', 'org-a-new']),
      ),
    ).toEqual({
      additions: ['org-a-new'],
      removals: [],
    })
  })

  it('取消勾选时只移除可管理范围内的绑定', () => {
    expect(
      diffManageableAgentAssignments(
        ['org-a-agent', 'org-b-agent'],
        new Set(),
        new Set(['org-a-agent']),
      ),
    ).toEqual({
      additions: [],
      removals: ['org-a-agent'],
    })
  })

  it('保存前后可管理集合相同时 additions/removals 为空（勾选回正后可安全再存）', () => {
    expect(
      diffManageableAgentAssignments(
        ['org-a-agent', 'org-b-agent'],
        new Set(['org-a-agent']),
        new Set(['org-a-agent']),
      ),
    ).toEqual({
      additions: [],
      removals: [],
    })
  })
})

describe('matchesConnectorSearch', () => {
  const searchableConnector = candidate({
    name: 'GitHub Issues',
    source: { kind: 'claude', label: 'Claude Desktop' },
    command: 'npx',
    args: ['@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_TOKEN'],
  })

  it.each(['github', 'claude', 'stdio', 'server-github', 'token'])('匹配连接器元数据：%s', query => {
    expect(matchesConnectorSearch(searchableConnector, query)).toBe(true)
  })

  it('空白搜索不筛选', () => {
    expect(matchesConnectorSearch(searchableConnector, '   ')).toBe(true)
  })

  it('可按描述搜索', () => {
    expect(
      matchesConnectorSearch(
        { ...searchableConnector, description: '团队统一的 Issue 同步连接' },
        'issue 同步',
      ),
    ).toBe(true)
  })

  it('排除无关搜索词', () => {
    expect(matchesConnectorSearch(searchableConnector, 'figma')).toBe(false)
  })
})

describe('canUninstallMarketplaceConnector', () => {
  it('未接入或只读时不展示卸载', () => {
    expect(canUninstallMarketplaceConnector(undefined)).toBe(false)
    expect(canUninstallMarketplaceConnector(null)).toBe(false)
    expect(canUninstallMarketplaceConnector(connection(), false)).toBe(false)
  })

  it('本机已有连接且可管理时展示卸载', () => {
    expect(canUninstallMarketplaceConnector(connection())).toBe(true)
    expect(canUninstallMarketplaceConnector(connection({
      lastProbe: {
        ok: true,
        probedAt: '2026-07-31T01:00:00Z',
        tools: [],
        resources: [],
        prompts: [],
      },
    }))).toBe(true)
  })
})

describe('shouldShowMarketplaceUninstall', () => {
  it('已接入且按钮为管理时展示', () => {
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'manage',
    })).toBe(true)
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'continue',
      forceManageAction: true,
    })).toBe(true)
  })

  it('接入 / 即将开放 / 重新授权不展示', () => {
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'connect',
    })).toBe(false)
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'connect',
      preferGhostAction: true,
      actionLabel: '即将开放',
    })).toBe(false)
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'repair',
      actionLabel: '重新授权',
    })).toBe(false)
  })

  it('继续配置 / 修复在推荐和组织精选不展示', () => {
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'continue',
    })).toBe(false)
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      action: 'repair',
    })).toBe(false)
  })

  it('没有卸载回调或隐藏动作时不展示', () => {
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: false,
      action: 'manage',
    })).toBe(false)
    expect(shouldShowMarketplaceUninstall({
      hasUninstallHandler: true,
      hideAction: true,
      action: 'manage',
    })).toBe(false)
  })
})
