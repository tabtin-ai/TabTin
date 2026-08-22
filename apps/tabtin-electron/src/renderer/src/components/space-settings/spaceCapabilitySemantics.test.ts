import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import type { SubAgentTemplate } from '@/services/subagentTemplateApi'
import type { ExtensionConnection, ExtensionManifest } from '@/services/extensionApi'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import { buildSpaceCapabilitySemantics } from './spaceCapabilitySemantics'

describe('spaceCapabilitySemantics', () => {
  it('按 visible / enabled 语义聚合 skill 和 subagent', () => {
    const skills: SkillIndexEntry[] = [
      {
        skill_id: 'skill.search',
        name: 'Search',
        description: '搜索技能',
        source: 'managed',
        emoji: '🔎',
      },
    ]

    const subagents: SubAgentTemplate[] = [
      {
        id: 'sub-1',
        space_id: 'space-1',
        name: 'Planner',
        description: '计划模板',
        icon: '🧠',
        system_prompt: 'plan',
        subagent_type: 'plan',
        allowed_tools: [],
        denied_tools: [],
        model_id: 'gpt-5',
        thinking_level: 'medium',
        default_mode: 'wait',
        is_enabled: true,
        order: 0,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
      {
        id: 'sub-2',
        space_id: 'space-1',
        name: 'Executor',
        description: '执行模板',
        icon: '⚙️',
        system_prompt: 'execute',
        subagent_type: 'execute',
        allowed_tools: [],
        denied_tools: [],
        model_id: 'gpt-5',
        thinking_level: 'medium',
        default_mode: 'background',
        is_enabled: false,
        order: 1,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
    ]

    const summary = buildSpaceCapabilitySemantics({
      spaceId: 'space-1',
      skills,
      subagents,
      extensions: [],
      connections: [],
      localMcpConnections: [],
    })

    expect(summary.visibleSkills).toHaveLength(1)
    expect(summary.visibleSkills[0]).toMatchObject({
      namespace: 'skill',
      capability_id: 'skill:skill.search',
      mount_state: 'mounted',
      availability_state: 'available',
      title: '🔎 Search',
    })

    expect(summary.enabledSubagents.map(item => item.name)).toEqual(['sub-1'])
    expect(summary.disabledSubagents.map(item => item.name)).toEqual(['sub-2'])
  })

  it('对 extension 区分 inherited connection 与 space override', () => {
    const extensions: ExtensionManifest[] = [
      {
        id: 'ext-a',
        name: 'GitHub',
        description: 'GitHub 扩展',
        icon: '🐙',
        type: 'integration',
        capabilities: {
          has_tools: true,
          has_cli: true,
          has_events: false,
          has_inbound_webhook: false,
          has_ui: false,
          supports_oauth: true,
          supports_polling: false,
        },
        config_schema: {},
        event_types: [],
      },
      {
        id: 'ext-b',
        name: 'Slack',
        description: 'Slack 扩展',
        icon: '💬',
        type: 'integration',
        capabilities: {
          has_tools: true,
          has_cli: false,
          has_events: false,
          has_inbound_webhook: false,
          has_ui: false,
          supports_oauth: true,
          supports_polling: false,
        },
        config_schema: {},
        event_types: [],
      },
      {
        id: 'ext-c',
        name: 'Linear',
        description: 'Linear 扩展',
        icon: '📐',
        type: 'integration',
        capabilities: {
          has_tools: true,
          has_cli: false,
          has_events: false,
          has_inbound_webhook: false,
          has_ui: false,
          supports_oauth: true,
          supports_polling: false,
        },
        config_schema: {},
        event_types: [],
      },
    ]

    const connections: ExtensionConnection[] = [
      {
        id: 'conn-organization-a',
        extension_id: 'ext-a',
        organization_id: 'ws-1',
        space_id: null,
        name: 'GitHub organization',
        enabled: true,
        status: 'connected',
        auth_type: 'oauth',
        config_masked: {},
        last_error: null,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
      {
        id: 'conn-organization-b',
        extension_id: 'ext-b',
        organization_id: 'ws-1',
        space_id: null,
        name: 'Slack organization',
        enabled: true,
        status: 'connected',
        auth_type: 'oauth',
        config_masked: {},
        last_error: null,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
      {
        id: 'conn-space-b',
        extension_id: 'ext-b',
        organization_id: 'ws-1',
        space_id: 'space-1',
        name: 'Slack override',
        enabled: false,
        status: 'disconnected',
        auth_type: 'oauth',
        config_masked: {},
        last_error: null,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
      {
        id: 'conn-space-c',
        extension_id: 'ext-c',
        organization_id: 'ws-1',
        space_id: 'space-1',
        name: 'Linear direct',
        enabled: true,
        status: 'disconnected',
        auth_type: 'oauth',
        config_masked: {},
        last_error: 'network down',
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      },
    ]

    const summary = buildSpaceCapabilitySemantics({
      spaceId: 'space-1',
      skills: [],
      subagents: [],
      extensions,
      connections,
      localMcpConnections: [],
    })

    expect(summary.connectedExtensions).toHaveLength(1)
    expect(summary.connectedExtensions[0]).toMatchObject({
      name: 'ext-a',
      mount_state: 'mounted',
      availability_state: 'available',
    })
    expect(summary.connectedExtensions[0].metadata?.inherited).toBe(true)

    const extB = summary.extensions.find(item => item.name === 'ext-b')
    expect(extB).toMatchObject({
      mount_state: 'unmounted',
      availability_state: 'unavailable',
    })
    expect(extB?.metadata?.connection_scope).toBe('space')

    const extC = summary.extensions.find(item => item.name === 'ext-c')
    expect(extC).toMatchObject({
      mount_state: 'partial',
      availability_state: 'degraded',
    })
    expect(summary.partiallyConnectedExtensions.map(item => item.name)).toEqual(['ext-c'])
  })

  it('对 MCP 连接区分 attached 与 availability', () => {
    const localMcpConnections: LocalMcpConnectionSummary[] = [
      {
        id: 'mcp-1',
        name: 'Playwright',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        command: 'playwright-mcp',
        args: [],
        cwd: undefined,
        url: undefined,
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-03-09T00:00:00.000Z',
        updatedAt: '2026-03-09T00:00:00.000Z',
        lastProbe: {
          ok: true,
          probedAt: '2026-03-09T00:00:00.000Z',
          tools: [{ name: 'browse' }],
          resources: [],
          prompts: [],
        },
      },
      {
        id: 'mcp-2',
        name: 'Files',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'http',
        command: undefined,
        args: [],
        cwd: undefined,
        url: 'http://localhost:9000/mcp',
        envKeys: [],
        headerKeys: [],
        enabled: false,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-03-09T00:00:00.000Z',
        updatedAt: '2026-03-09T00:00:00.000Z',
      },
      {
        id: 'mcp-3',
        name: 'Crawler',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        command: 'crawler-mcp',
        args: [],
        cwd: undefined,
        url: undefined,
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: [],
        requiresAgentSelection: false,
        createdAt: '2026-03-09T00:00:00.000Z',
        updatedAt: '2026-03-09T00:00:00.000Z',
        lastProbe: {
          ok: false,
          probedAt: '2026-03-09T00:00:00.000Z',
          tools: [],
          resources: [],
          prompts: [],
          error: 'boom',
        },
      },
      {
        id: 'mcp-4',
        name: 'Fresh Import',
        source: { kind: 'manual', label: 'Manual' },
        transportKind: 'stdio',
        command: 'fresh-mcp',
        args: [],
        cwd: undefined,
        url: undefined,
        envKeys: [],
        headerKeys: [],
        enabled: true,
        attachedAgentIds: ['agent-1'],
        requiresAgentSelection: false,
        createdAt: '2026-03-09T00:00:00.000Z',
        updatedAt: '2026-03-09T00:00:00.000Z',
      },
    ]

    const summary = buildSpaceCapabilitySemantics({
      spaceId: 'space-1',
      agentId: 'agent-1',
      skills: [],
      subagents: [],
      extensions: [],
      connections: [],
      localMcpConnections,
    })

    expect(summary.attachedMcpAttachments.map(item => item.name)).toEqual(['mcp-1', 'mcp-2', 'mcp-4'])
    expect(summary.activeAttachedMcpAttachments.map(item => item.name)).toEqual(['mcp-1'])
    expect(summary.inactiveAttachedMcpAttachments.map(item => item.name)).toEqual(['mcp-2', 'mcp-4'])

    const unattached = summary.mcpAttachments.find(item => item.name === 'mcp-3')
    expect(unattached).toMatchObject({
      mount_state: 'unmounted',
      availability_state: 'degraded',
    })
    expect(unattached?.reason_codes).toContain('attachment_missing')

    const pendingProbe = summary.mcpAttachments.find(item => item.name === 'mcp-4')
    expect(pendingProbe?.availability_state).toBe('unknown')
  })
})
