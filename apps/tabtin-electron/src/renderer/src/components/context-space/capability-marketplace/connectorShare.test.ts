import { describe, expect, it } from 'vitest'
import type { LocalMcpConnectionDetail } from '@shared/types/mcp'
import {
  assertHttpShareable,
  buildOrgSharePayloadFromHttpDetail,
  canCurrentUserUnshareOrgConnection,
  findMatchingMineConnectionForOrg,
  findOrgConnectionShareConflict,
  findOrgShareForLocalConnection,
  isOrgConnectionSharedByCurrentUser,
  mergeAttachedAgentIdsForDisplay,
  selectMineShelfConnections,
} from './connectorShare'
import type { OrgMcpConnection } from '@/services/mcpApi'

function httpDetail(
  partial: Partial<LocalMcpConnectionDetail> & {
    transport: LocalMcpConnectionDetail['transport']
  },
): LocalMcpConnectionDetail {
  return {
    id: 'conn-1',
    name: 'Remote Docs',
    source: { kind: 'manual', label: 'Manual' },
    transportKind: 'http',
    envKeys: [],
    headerKeys: [],
    enabled: true,
    attachedAgentIds: [],
    requiresAgentSelection: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

describe('connectorShare', () => {
  it('rejects non-http transports', () => {
    expect(() => assertHttpShareable('stdio')).toThrow('MCP_ERR:ONLY_HTTP_SHAREABLE')
  })

  it('moves Authorization into credential_value and keeps other headers in config', () => {
    const payload = buildOrgSharePayloadFromHttpDetail(httpDetail({
      name: 'Remote Docs',
      description: '团队文档 MCP',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/v1',
        headers: {
          Authorization: 'Bearer secret-token',
          'X-Tenant': 'acme',
        },
      },
    }))

    expect(payload).toEqual({
      name: 'Remote Docs',
      description: '团队文档 MCP',
      endpoint: 'https://mcp.example.com/v1',
      config: {
        headers: { 'X-Tenant': 'acme' },
        credential_header: 'Authorization',
      },
      credential_value: 'Bearer secret-token',
      enabled: true,
    })
  })

  it('shares http without credentials', () => {
    const payload = buildOrgSharePayloadFromHttpDetail(httpDetail({
      name: 'Public MCP',
      transport: {
        kind: 'http',
        url: 'https://mcp.example.com/public',
      },
    }))

    expect(payload.endpoint).toBe('https://mcp.example.com/public')
    expect(payload.credential_value).toBeUndefined()
    expect(payload.config).toEqual({})
  })

  it('matches org share by endpoint first, then name', () => {
    const orgRows = [
      {
        id: 'org-1',
        name: 'Remote Docs',
        description: '',
        scope: 'remote',
        organization_id: 'org',
        transport: 'http',
        endpoint: 'https://mcp.example.com/v1',
        config: {},
        has_credential: true,
        enabled: true,
        last_probe: {},
        created_at: '',
        updated_at: '',
      },
      {
        id: 'org-2',
        name: 'Other',
        description: '',
        scope: 'remote',
        organization_id: 'org',
        transport: 'http',
        endpoint: 'https://other.example.com',
        config: {},
        has_credential: false,
        enabled: true,
        last_probe: {},
        created_at: '',
        updated_at: '',
      },
    ] as OrgMcpConnection[]

    expect(findOrgShareForLocalConnection({
      name: 'Renamed',
      transportKind: 'http',
      url: 'https://mcp.example.com/v1',
    }, orgRows)?.id).toBe('org-1')

    expect(findOrgShareForLocalConnection({
      name: 'Other',
      transportKind: 'http',
      url: 'https://missing.example.com',
    }, orgRows)?.id).toBe('org-2')

    expect(findOrgShareForLocalConnection({
      name: 'stdio',
      transportKind: 'stdio',
      url: undefined,
    }, orgRows)).toBeNull()
  })

  it('resolves mine connection for org pick and merges agent assignments for display', () => {
    const mine = httpDetail({
      id: 'local-1',
      name: 'mcp-test1',
      attachedAgentIds: [],
      transport: { kind: 'http', url: 'https://mcp.example.com/v1' },
    })
    const mirror = httpDetail({
      id: 'mirror-1',
      name: 'mcp-test1',
      attachedAgentIds: ['agent-a'],
      source: { kind: 'organization', label: 'Organization', orgConnectionId: 'org-1' },
      transport: { kind: 'http', url: 'https://mcp.example.com/v1' },
    })

    expect(findMatchingMineConnectionForOrg({
      name: 'mcp-test1',
      endpoint: 'https://mcp.example.com/v1',
    }, [mine])?.id).toBe('local-1')

    expect(mergeAttachedAgentIdsForDisplay(mine, mirror).attachedAgentIds).toEqual(['agent-a'])
  })

  it('shows an imported organization connector in Mine without duplicating a local original', () => {
    const mirror = httpDetail({
      id: 'mirror-1',
      name: 'Team Search',
      source: { kind: 'organization', label: 'Organization', orgConnectionId: 'org-1' },
      transport: { kind: 'http', url: 'https://search.example.com/mcp' },
    })

    expect(selectMineShelfConnections([mirror]).map(item => item.id)).toEqual(['mirror-1'])

    const local = httpDetail({
      id: 'local-1',
      name: 'Team Search',
      transport: { kind: 'http', url: 'https://search.example.com/mcp' },
    })
    expect(selectMineShelfConnections([local, mirror]).map(item => item.id)).toEqual(['local-1'])
  })

  it('recognizes the exact sharer instead of guessing from a matching mine connection', () => {
    const mine = httpDetail({
      id: 'local-1',
      name: 'shared',
      transport: { kind: 'http', url: 'https://shared.example.com' },
    })
    const org = {
      name: 'shared',
      endpoint: 'https://shared.example.com',
      created_by_user_id: 'user-1',
    }

    expect(isOrgConnectionSharedByCurrentUser(org, 'user-1')).toBe(true)
    expect(isOrgConnectionSharedByCurrentUser(org, 'user-2', [mine])).toBe(false)
    expect(isOrgConnectionSharedByCurrentUser({
      name: 'shared',
      endpoint: 'https://shared.example.com',
    }, 'user-1', [mine])).toBe(true)

    expect(canCurrentUserUnshareOrgConnection({
      canManage: true,
      isPersonalOrganization: false,
      organizationId: 'org-1',
      orgConnection: org,
      currentUserId: 'user-1',
      mineConnections: [mine],
    })).toBe(true)

    expect(canCurrentUserUnshareOrgConnection({
      canManage: true,
      isPersonalOrganization: false,
      organizationId: 'org-1',
      orgConnection: org,
      currentUserId: 'user-2',
      mineConnections: [mine],
    })).toBe(false)

    expect(canCurrentUserUnshareOrgConnection({
      canManage: false,
      isPersonalOrganization: false,
      organizationId: 'org-1',
      orgConnection: org,
      currentUserId: 'user-1',
      mineConnections: [mine],
    })).toBe(false)
  })

  it('共享前按名称 / endpoint 对照组织精选拦截', () => {
    const orgRows = [
      {
        id: 'org-1',
        name: 'Remote Docs',
        description: '',
        scope: 'remote',
        organization_id: 'org',
        transport: 'http',
        endpoint: 'https://mcp.example.com/v1',
        config: {},
        has_credential: true,
        enabled: true,
        last_probe: {},
        created_at: '',
        updated_at: '',
      },
    ] as OrgMcpConnection[]

    expect(findOrgConnectionShareConflict({
      name: 'Remote Docs',
      transportKind: 'http',
      url: 'https://other.example.com',
    }, orgRows)).toEqual({ kind: 'name', value: 'Remote Docs' })

    expect(findOrgConnectionShareConflict({
      name: 'Different Name',
      transportKind: 'http',
      url: 'https://mcp.example.com/v1',
    }, orgRows)).toEqual({ kind: 'endpoint', value: 'https://mcp.example.com/v1' })

    expect(findOrgConnectionShareConflict({
      name: 'Fresh',
      transportKind: 'http',
      url: 'https://fresh.example.com',
    }, orgRows)).toBeNull()
  })
})
