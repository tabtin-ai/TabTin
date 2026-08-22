import { describe, expect, it } from 'vitest'
import zhSpace from '@/i18n/locales/zh-CN/space.json'
import enSpace from '@/i18n/locales/en-US/space.json'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import type { RecommendedConnectorCatalogEntry } from './recommendedConnectorCatalog'
import {
  connectorIsOAuthReady,
  connectorIsOAuthVendorGated,
  connectorNeedsCredentialForm,
  findConnectionForRecommendedConnector,
  findRecommendedCatalogEntryForConnection,
  normalizeConnectorEndpointUrl,
  RECOMMENDED_CONNECTOR_CATALOG,
  resolveRecommendedCredentialUrl,
  stdioServerIdentity,
} from './recommendedConnectorCatalog'

function connection(overrides: Partial<LocalMcpConnectionSummary>): LocalMcpConnectionSummary {
  return {
    id: 'conn-1',
    name: 'Demo',
    source: { kind: 'manual', label: 'Manual' },
    transportKind: 'http',
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

describe('recommendedConnectorCatalog', () => {
  // 产品明确不上推荐：Superpowers / Obsidian / WPS / 邮件 / 飞书 / 百度网盘 / 万得
  // 正典：https://xcnq4wynfm4c.feishu.cn/docx/LLSIdfNdIot7duxkKSUc1lCwnVY
  const EXCLUDED_IDS = [
    'wind',
    'superpowers',
    'obsidian',
    'email',
    'wps',
    'feishu',
    'baidu-netdisk',
  ] as const

  it('ships first-batch ids without excluded connectors', () => {
    const ids = RECOMMENDED_CONNECTOR_CATALOG.map(entry => entry.id)
    expect(ids).toContain('vercel')
    expect(ids).toContain('github')
    expect(ids).toContain('dingtalk')
    for (const excluded of EXCLUDED_IDS) {
      expect(ids).not.toContain(excluded)
    }
  })

  it('defaults recommended entries to stdio, except platform OAuth HTTP (GitHub)', () => {
    for (const entry of RECOMMENDED_CONNECTOR_CATALOG) {
      expect(entry.docsUrl).toBeTruthy()
      expect(entry.credentialUrl).toBeTruthy()
      expect(entry.authKind).toBeTruthy()
      if (entry.id === 'github') {
        expect(entry.transport.kind).toBe('http')
        expect(entry.oauthHost).toBe('tabtin_backend')
        expect(entry.oauthGate).toBe('ready')
      } else {
        expect(entry.transport.kind).toBe('stdio')
      }
    }
  })

  it('classifies product auth into four buckets', () => {
    const ready = RECOMMENDED_CONNECTOR_CATALOG.filter(connectorIsOAuthReady).map(e => e.id)
    const gated = RECOMMENDED_CONNECTOR_CATALOG.filter(connectorIsOAuthVendorGated).map(e => e.id)
    const keys = RECOMMENDED_CONNECTOR_CATALOG.filter(e => e.authKind === 'api_key').map(e => e.id)
    const apps = RECOMMENDED_CONNECTOR_CATALOG.filter(e => e.authKind === 'app_credentials').map(
      e => e.id,
    )

    expect(ready.sort()).toEqual(
      ['cloudflare', 'github', 'neon', 'notion', 'stripe', 'supabase', 'tianyancha'].sort(),
    )
    expect(gated.sort()).toEqual(['canva', 'vercel'].sort())
    expect(keys.sort()).toEqual(['hithink-a-share'].sort())
    expect(apps).toEqual(['dingtalk'])
    expect(connectorNeedsCredentialForm({ authKind: 'api_key' })).toBe(true)
    expect(connectorNeedsCredentialForm({ authKind: 'app_credentials' })).toBe(true)
    expect(connectorNeedsCredentialForm({ authKind: 'oauth' })).toBe(false)
  })

  it('uses hosted OAuth endpoints for supabase/neon/tianyancha', () => {
    const supabase = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'supabase')!
    const neon = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'neon')!
    const tianyancha = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'tianyancha')!
    expect(supabase.transport).toMatchObject({
      kind: 'stdio',
      args: expect.arrayContaining([
        expect.stringMatching(/^mcp-remote(@|$)/),
        'https://mcp.supabase.com/mcp',
        '--static-oauth-client-metadata',
      ]),
    })
    expect(neon.transport).toMatchObject({
      kind: 'stdio',
      args: expect.arrayContaining([
        expect.stringMatching(/^mcp-remote(@|$)/),
        'https://mcp.neon.tech/mcp',
      ]),
    })
    expect(tianyancha.authKind).toBe('oauth')
    expect(tianyancha.oauthGate).toBe('ready')
    expect(tianyancha.transport).toMatchObject({
      kind: 'stdio',
      args: [
        '-y',
        'mcp-remote@0.1.38',
        'https://mcp.tianyancha.com/mcp',
        '--static-oauth-client-metadata',
        '{"client_name":"TabTin","scope":"mcp:tools.call mcp:quota.read"}',
        '--auth-timeout',
        '180',
      ],
    })
  })

  it('treats legacy tianyancha /v1 api-key installs as already connected', () => {
    const tianyancha = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'tianyancha')!
    const matched = findConnectionForRecommendedConnector(tianyancha, [
      connection({
        id: 'local-tyc-v1',
        name: '天眼查',
        transportKind: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          'https://mcp.tianyancha.com/v1',
          '--header',
          'Authorization:tyc_old_key',
        ],
      }),
    ])
    expect(matched?.id).toBe('local-tyc-v1')
  })

  it('never lists excluded product names on the shelf', () => {
    const names = RECOMMENDED_CONNECTOR_CATALOG.map(entry => entry.name)
    expect(names.some(name => /万得|Wind/i.test(name))).toBe(false)
    expect(names.some(name => /Superpowers/i.test(name))).toBe(false)
    expect(names.some(name => /Obsidian/i.test(name))).toBe(false)
    expect(names.some(name => /WPS/i.test(name))).toBe(false)
    expect(names.some(name => name === '邮件' || /email/i.test(name))).toBe(false)
    expect(names.some(name => name === '飞书' || /Feishu|Lark/i.test(name))).toBe(false)
    expect(names.some(name => /百度网盘|Baidu/i.test(name))).toBe(false)
  })

  it('normalizes trailing slash for http endpoint matching', () => {
    expect(normalizeConnectorEndpointUrl('https://mcp.vercel.com/')).toBe(
      normalizeConnectorEndpointUrl('https://mcp.vercel.com'),
    )
  })

  it('matches legacy http install of the same remote endpoint', () => {
    const vercel = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'vercel')!
    const matched = findConnectionForRecommendedConnector(vercel, [
      connection({
        id: 'local-vercel',
        name: 'Vercel',
        url: 'https://mcp.vercel.com/',
        transportKind: 'http',
      }),
    ])
    expect(matched?.id).toBe('local-vercel')
  })

  it('pins mcp-remote and declares Stripe OAuth scope metadata', () => {
    const stripe = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'stripe')!
    expect(stripe.transport).toMatchObject({
      kind: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'mcp-remote@0.1.38',
        'https://mcp.stripe.com',
        '--static-oauth-client-metadata',
        '{"client_name":"TabTin","scope":"mcp"}',
        '--auth-timeout',
        '180',
      ],
    })
  })

  it('matches stdio mcp-remote by command+args', () => {
    const vercel = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'vercel')!
    const matched = findConnectionForRecommendedConnector(vercel, [
      connection({
        id: 'local-vercel-stdio',
        name: 'Vercel',
        transportKind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.vercel.com'],
      }),
    ])
    expect(matched?.id).toBe('local-vercel-stdio')
  })

  it('matches stripe regardless of mcp-remote version pin or scope metadata', () => {
    const stripe = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'stripe')!
    const matched = findConnectionForRecommendedConnector(stripe, [
      connection({
        id: 'local-stripe-old',
        name: 'Stripe',
        transportKind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.stripe.com'],
      }),
    ])
    expect(matched?.id).toBe('local-stripe-old')
  })

  it('stdio identity ignores package version and static oauth metadata', () => {
    expect(
      stdioServerIdentity('npx', [
        '-y',
        'mcp-remote@0.1.38',
        'https://mcp.stripe.com',
        '--static-oauth-client-metadata',
        '{"scope":"mcp"}',
      ]),
    ).toBe(stdioServerIdentity('npx', ['-y', 'mcp-remote', 'https://mcp.stripe.com']))
  })

  it('still matches neon after user replaces API key arg on legacy local package', () => {
    const neon = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'neon')!
    const matched = findConnectionForRecommendedConnector(neon, [
      connection({
        id: 'local-neon',
        name: 'Neon',
        transportKind: 'stdio',
        command: 'npx',
        args: ['-y', '@neondatabase/mcp-server-neon', 'start', 'neon_api_key_real'],
      }),
    ])
    expect(matched?.id).toBe('local-neon')
  })

  it('matches neon hosted mcp-remote install', () => {
    const neon = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'neon')!
    const matched = findConnectionForRecommendedConnector(neon, [
      connection({
        id: 'local-neon-remote',
        name: 'Neon',
        transportKind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.neon.tech/mcp'],
      }),
    ])
    expect(matched?.id).toBe('local-neon-remote')
  })

  it('still matches hithink after user replaces X-api-key header', () => {
    const hithink = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'hithink-a-share')!
    const matched = findConnectionForRecommendedConnector(hithink, [
      connection({
        id: 'local-hithink',
        name: '同花顺',
        transportKind: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'mcp-remote',
          'https://fuyao.aicubes.cn/mcp/a-share',
          '--header',
          'X-api-key:real-key-from-user',
        ],
      }),
    ])
    expect(matched?.id).toBe('local-hithink')
  })

  it('stdio identity ignores credential flags', () => {
    const entry: RecommendedConnectorCatalogEntry = {
      id: 'stdio-creds',
      name: 'Cred Demo',
      descriptionKey: 'stdioCreds',
      category: 'collab',
      transport: {
        kind: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@example/mcp',
          'mcp',
          '-a',
          'YOUR_APP_ID',
          '-s',
          'YOUR_APP_SECRET',
        ],
      },
      authKind: 'app_credentials',
      auth: 'env',
    }
    const matched = findConnectionForRecommendedConnector(entry, [
      connection({
        id: 'local-creds',
        name: 'Cred Demo',
        transportKind: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@example/mcp',
          'mcp',
          '-a',
          'cli_real_app_id',
          '-s',
          'real_app_secret',
        ],
      }),
    ])
    expect(matched?.id).toBe('local-creds')
    expect(
      stdioServerIdentity('npx', ['-y', '@example/mcp', 'mcp', '-a', 'a', '-s', 'b']),
    ).toBe(stdioServerIdentity('npx', ['-y', '@example/mcp', 'mcp', '-a', 'x', '-s', 'y']))
  })

  it('does not mis-attribute Stripe mcp-remote to GitHub via bare mcp-remote legacy match', () => {
    const github = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'github')!
    const stripeConn = connection({
      id: 'local-stripe',
      name: 'Stripe',
      transportKind: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-remote@0.1.38', 'https://mcp.stripe.com', '--auth-timeout', '180'],
    })
    expect(findConnectionForRecommendedConnector(github, [stripeConn])).toBeUndefined()
    expect(findRecommendedCatalogEntryForConnection(stripeConn)?.id).toBe('stripe')
  })

  it('still matches old GitHub mcp-remote installs by remote URL', () => {
    const github = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'github')!
    const matched = findConnectionForRecommendedConnector(github, [
      connection({
        id: 'local-github-remote',
        name: 'GitHub',
        transportKind: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://api.githubcopilot.com/mcp/'],
      }),
    ])
    expect(matched?.id).toBe('local-github-remote')
  })

  it('resolves credential urls for marketplace shelves', () => {
    const vercel = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === 'vercel')!
    expect(
      resolveRecommendedCredentialUrl({
        name: 'Vercel',
        endpoint: 'https://mcp.vercel.com/',
      }),
    ).toBe(vercel.credentialUrl)
    expect(resolveRecommendedCredentialUrl({ name: '同花顺 · A股数据' })).toBe(
      'https://fuyao.aicubes.cn/admin/',
    )
  })
})

describe('recommended connector marketplace copy', () => {
  const INSTALL_JARGON = /mcp-remote|stdio|OAuth|PAT|API Key|npx|Personal Access Token/i

  it('推荐货架介绍能力，不讲安装方法', () => {
    expect(zhSpace.mcpConnections.marketplace.intro).toMatch(/Agent/)
    expect(zhSpace.mcpConnections.marketplace.intro).toMatch(/查|读|操作/)
    expect(enSpace.mcpConnections.marketplace.intro).toMatch(/Agent/)
    expect(zhSpace.mcpConnections.marketplace.intro).not.toMatch(INSTALL_JARGON)
    expect(enSpace.mcpConnections.marketplace.intro).not.toMatch(INSTALL_JARGON)

    const zhCatalog = zhSpace.mcpConnections.marketplace.recommendedCatalog as Record<string, string>
    const enCatalog = enSpace.mcpConnections.marketplace.recommendedCatalog as Record<string, string>
    for (const entry of RECOMMENDED_CONNECTOR_CATALOG) {
      const zh = zhCatalog[entry.descriptionKey]
      const en = enCatalog[entry.descriptionKey]
      expect(zh, entry.descriptionKey).toMatch(/Agent/)
      expect(en, entry.descriptionKey).toMatch(/Agent/)
      expect(zh, entry.descriptionKey).not.toMatch(INSTALL_JARGON)
      expect(en, entry.descriptionKey).not.toMatch(INSTALL_JARGON)
    }
  })
})
