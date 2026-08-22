import { describe, expect, it } from 'vitest'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import { resolveConnectorAuthGate } from './connectorAuthGate'
import type { RecommendedConnectorCatalogEntry } from './recommendedConnectorCatalog'

function connection(
  overrides: Partial<LocalMcpConnectionSummary> = {},
): LocalMcpConnectionSummary {
  return {
    id: 'c1',
    name: 'Stripe',
    source: { kind: 'manual', label: 'Manual' },
    transportKind: 'stdio',
    envKeys: [],
    headerKeys: [],
    enabled: true,
    attachedAgentIds: [],
    requiresAgentSelection: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function entry(
  overrides: Partial<RecommendedConnectorCatalogEntry>,
): RecommendedConnectorCatalogEntry {
  return {
    id: 'stripe',
    name: 'Stripe',
    descriptionKey: 'stripe',
    category: 'system',
    transport: { kind: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.stripe.com'] },
    authKind: 'oauth',
    oauthGate: 'ready',
    auth: 'oauth',
    ...overrides,
  }
}

describe('resolveConnectorAuthGate', () => {
  it('returns null when probe already ok', () => {
    expect(
      resolveConnectorAuthGate({
        connection: connection({
          lastProbe: {
            ok: true,
            probedAt: '2026-01-01T00:00:00.000Z',
            tools: [],
            resources: [],
            prompts: [],
          },
        }),
        catalogEntry: entry({}),
      }),
    ).toBe(null)
  })

  it('gates oauth-ready connectors before successful probe', () => {
    expect(
      resolveConnectorAuthGate({
        connection: connection(),
        catalogEntry: entry({}),
      }),
    ).toBe('oauth')
    expect(
      resolveConnectorAuthGate({
        connection: connection({
          lastProbe: {
            ok: false,
            probedAt: '2026-01-01T00:00:00.000Z',
            tools: [],
            resources: [],
            prompts: [],
            error: 'denied',
          },
        }),
        catalogEntry: entry({}),
      }),
    ).toBe('oauth')
  })

  it('gates api_key and app_credentials separately', () => {
    expect(
      resolveConnectorAuthGate({
        connection: connection({ name: '天眼查' }),
        catalogEntry: entry({
          id: 'tianyancha',
          name: '天眼查',
          authKind: 'api_key',
          auth: 'api_key',
          oauthGate: undefined,
        }),
      }),
    ).toBe('api_key')
    expect(
      resolveConnectorAuthGate({
        connection: connection({ name: '钉钉' }),
        catalogEntry: entry({
          id: 'dingtalk',
          name: '钉钉',
          authKind: 'app_credentials',
          auth: 'env',
          oauthGate: undefined,
        }),
      }),
    ).toBe('app_credentials')
  })

  it('does not gate unknown manual connectors', () => {
    expect(
      resolveConnectorAuthGate({
        connection: connection(),
        catalogEntry: null,
      }),
    ).toBe(null)
  })
})
