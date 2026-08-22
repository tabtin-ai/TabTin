/**
 * 能力市场「连接器 → 推荐」首批货架。
 *
 * 筛选口径（正典：[connector marketplace 飞书调研](https://xcnq4wynfm4c.feishu.cn/docx/LLSIdfNdIot7duxkKSUc1lCwnVY)）：
 * - **标题带橙色高亮 = 不上推荐货架**
 * - 明确不上：Superpowers、Obsidian、WPS、邮件、飞书、百度网盘、万得
 * - **默认 stdio 接入**：官方以远程 HTTP/SSE 发布的，用 `mcp-remote` 桥成本地 stdio
 *   （与 Notion / Vercel 官方「仅支持 stdio 的客户端」文档一致）；本地 npm 包按 GitHub README
 *
 * 产品授权分类（官网核对后）：
 * - `oauth` + `oauthGate: ready`：标准 MCP OAuth，可直接做引导流（Stripe / Notion / Supabase / Neon / Cloudflare / 天眼查）
 * - `oauth` + `oauthGate: ready` + `oauthHost: tabtin_backend`：须平台注册 App，后端保管 secret（GitHub）
 * - `oauth` + `oauthGate: vendor_pending`：支持 OAuth，但 TabTin 须先完成厂商注册/审核（Vercel / Canva）
 * - `api_key`：主路径粘贴密钥（同花顺）
 * - `app_credentials`：管理员建企业应用后填 Client ID/Secret（钉钉）
 */

import type { LocalMcpConnectionSummary, LocalMcpTransportConfig } from '@shared/types/mcp'
import type { ConnectorMarketCategory } from './connectorMarketTaxonomy'

/** @deprecated 使用 RecommendedConnectorAuthKind；保留供过渡期测试夹具 */
export type RecommendedConnectorAuth =
  | 'oauth'
  | 'api_key'
  | 'env'
  | 'none'

export type RecommendedConnectorAuthKind =
  | 'oauth'
  | 'api_key'
  | 'app_credentials'

/** 仅 authKind=oauth 时有意义 */
export type RecommendedConnectorOAuthGate = 'ready' | 'vendor_pending'

/** OAuth 宿主：mcp-remote 本机动态注册，或 TabTin 后端代理（保管 client_secret） */
export type RecommendedConnectorOAuthHost = 'mcp_remote' | 'tabtin_backend'

export type RecommendedConnectorVendorGate =
  | 'github_app'
  | 'vercel_approval'
  | 'canva_callback'

export interface RecommendedConnectorCatalogEntry {
  id: string
  name: string
  /** i18n key under mcpConnections.marketplace.recommendedCatalog.<id> */
  descriptionKey: string
  category: ConnectorMarketCategory
  /** stdio（含 mcp-remote）或 HTTP（平台 Bearer，如 GitHub）。 */
  transport: LocalMcpTransportConfig
  authKind: RecommendedConnectorAuthKind
  /** authKind=oauth 时必填 */
  oauthGate?: RecommendedConnectorOAuthGate
  /** oauth ready 时默认 mcp_remote；GitHub 等走 tabtin_backend */
  oauthHost?: RecommendedConnectorOAuthHost
  /** authKind=oauth 且 oauthGate=vendor_pending 时说明准入原因 */
  vendorGate?: RecommendedConnectorVendorGate
  /**
   * 兼容旧分支：oauth→oauth，api_key→api_key，app_credentials→env。
   * 新代码请读 authKind。
   */
  auth: RecommendedConnectorAuth
  /** 官方文档或 GitHub，便于用户核对 JSON。 */
  docsUrl?: string
  /** 官方签发 / 申请密钥或完成验证的页面。 */
  credentialUrl?: string
  /**
   * 旧版本地 npm 包名（仍算「已接入该推荐项」），避免用户升级货架后卡片又变可接入。
   */
  legacyStdioPackages?: readonly string[]
  /**
   * 旧版远程 MCP URL（如天眼查曾用 /v1 API Key 端点），升级到 OAuth /mcp 后仍算已接入。
   */
  legacyRemoteUrls?: readonly string[]
}

function stdio(
  command: string,
  args: string[],
  env?: Record<string, string>,
): LocalMcpTransportConfig {
  return env
    ? { kind: 'stdio', command, args, env }
    : { kind: 'stdio', command, args }
}

/**
 * 钉版本：裸 `mcp-remote` 会随 npx 缓存漂移；0.1.38 仍会把无 scopes 的服务器
 * 默认成 `openid email profile`，Stripe 等会直接拒绝（见 --static-oauth-client-metadata）。
 */
const MCP_REMOTE_PACKAGE = 'mcp-remote@0.1.38'

/** 官方远程 MCP → 本地 stdio（npx mcp-remote）。 */
function remoteStdio(url: string, extraArgs: string[] = []): LocalMcpTransportConfig {
  return stdio('npx', ['-y', MCP_REMOTE_PACKAGE, url, ...extraArgs])
}

/**
 * OAuth 远程 MCP。部分授权服不接受 mcp-remote 默认 OIDC scope，
 * 需用 `--static-oauth-client-metadata` 显式声明（Stripe 为正典样板：`{"scope":"mcp"}`）。
 * `client_name: TabTin` 对齐原型授权页「允许 TabTin 访问…」。
 * `--auth-timeout` 与探测预算对齐（秒），避免网页授权中途 long-poll 过早结束。
 */
function remoteOAuthStdio(
  url: string,
  clientMetadata?: Record<string, unknown>,
  extraArgs: string[] = [],
): LocalMcpTransportConfig {
  const metadata = {
    client_name: 'TabTin',
    ...(clientMetadata ?? {}),
  }
  return remoteStdio(url, [
    '--static-oauth-client-metadata',
    JSON.stringify(metadata),
    '--auth-timeout',
    '180',
    ...extraArgs,
  ])
}

function withAuth(
  authKind: RecommendedConnectorAuthKind,
  oauth?: {
    gate: RecommendedConnectorOAuthGate
    vendorGate?: RecommendedConnectorVendorGate
    oauthHost?: RecommendedConnectorOAuthHost
  },
): Pick<
  RecommendedConnectorCatalogEntry,
  'authKind' | 'auth' | 'oauthGate' | 'vendorGate' | 'oauthHost'
> {
  const auth: RecommendedConnectorAuth =
    authKind === 'app_credentials' ? 'env' : authKind === 'api_key' ? 'api_key' : 'oauth'
  return {
    authKind,
    auth,
    ...(oauth
      ? {
          oauthGate: oauth.gate,
          ...(oauth.vendorGate ? { vendorGate: oauth.vendorGate } : {}),
          ...(oauth.oauthHost ? { oauthHost: oauth.oauthHost } : {}),
        }
      : {}),
  }
}

/** GitHub 远程 MCP：HTTP + Bearer（平台 OAuth 注入）。 */
function githubHttpTransport(): LocalMcpTransportConfig {
  return {
    kind: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: {
      Authorization: 'Bearer YOUR_GITHUB_TOKEN',
    },
  }
}

/**
 * 首批上架清单。顺序即推荐货架默认排序。
 * JSON 形态对齐各厂商 GitHub / 官方文档的 Claude Desktop / Cursor stdio 示例。
 */
export const RECOMMENDED_CONNECTOR_CATALOG: readonly RecommendedConnectorCatalogEntry[] = [
  {
    id: 'vercel',
    name: 'Vercel',
    descriptionKey: 'vercel',
    category: 'dev',
    // https://vercel.com/docs/agent-resources/vercel-mcp — 须先成为批准的 MCP 客户端
    transport: remoteStdio('https://mcp.vercel.com'),
    ...withAuth('oauth', { gate: 'vendor_pending', vendorGate: 'vercel_approval' }),
    docsUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp',
    credentialUrl: 'https://vercel.com/account',
  },
  {
    id: 'github',
    name: 'GitHub',
    descriptionKey: 'github',
    category: 'dev',
    // 官方远程 MCP；须 TabTin 注册的 GitHub OAuth App（不支持动态客户端注册）
    transport: githubHttpTransport(),
    ...withAuth('oauth', { gate: 'ready', oauthHost: 'tabtin_backend' }),
    docsUrl: 'https://github.com/github/github-mcp-server',
    credentialUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    descriptionKey: 'stripe',
    category: 'system',
    // Stripe 动态注册拒绝 openid/email/profile，只接受 scope=mcp
    transport: remoteOAuthStdio('https://mcp.stripe.com', { scope: 'mcp' }),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://docs.stripe.com/mcp',
    credentialUrl: 'https://dashboard.stripe.com/apikeys',
  },
  {
    id: 'notion',
    name: 'Notion',
    descriptionKey: 'notion',
    category: 'collab',
    // https://developers.notion.com/guides/mcp/get-started-with-mcp — STDIO (via mcp-remote)
    // PRM scopes_supported=["default"]；显式声明避免落到 OIDC 默认
    transport: remoteOAuthStdio('https://mcp.notion.com/mcp', { scope: 'default' }),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
    credentialUrl: 'https://www.notion.so/my-integrations',
  },
  {
    id: 'canva',
    name: 'Canva',
    descriptionKey: 'canva',
    category: 'collab',
    transport: remoteStdio('https://mcp.canva.com/mcp'),
    ...withAuth('oauth', { gate: 'vendor_pending', vendorGate: 'canva_callback' }),
    docsUrl: 'https://www.canva.dev/docs/mcp/',
    credentialUrl: 'https://www.canva.com/developers/',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    descriptionKey: 'supabase',
    category: 'storage',
    // https://supabase.com/docs/guides/ai-tools/mcp — 托管 MCP + 动态客户端注册 OAuth
    // PRM 列出细粒度 scope；拼进 metadata，避免 mcp-remote 默认 OIDC 被拒
    transport: remoteOAuthStdio('https://mcp.supabase.com/mcp', {
      scope:
        'organizations:read projects:read projects:write database:write database:read analytics:read secrets:read edge_functions:read edge_functions:write environment:read environment:write storage:read storage:write',
    }),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
    credentialUrl: 'https://supabase.com/dashboard/account/tokens',
    legacyStdioPackages: ['@supabase/mcp-server-supabase'],
  },
  {
    id: 'neon',
    name: 'Neon',
    descriptionKey: 'neon',
    category: 'storage',
    // https://neon.com/docs/ai/neon-mcp-server — 托管 MCP OAuth 主路径
    transport: remoteStdio('https://mcp.neon.tech/mcp'),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://neon.com/docs/ai/neon-mcp-server',
    credentialUrl: 'https://console.neon.tech/app/settings/api-keys',
    legacyStdioPackages: ['@neondatabase/mcp-server-neon'],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    descriptionKey: 'cloudflare',
    category: 'dev',
    transport: remoteStdio('https://mcp.cloudflare.com/mcp'),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://developers.cloudflare.com/agents/model-context-protocol/',
    credentialUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  },
  {
    id: 'tianyancha',
    name: '天眼查',
    descriptionKey: 'tianyancha',
    category: 'system',
    // 官方推荐 Remote MCP OAuth：https://mcp.tianyancha.com/mcp
    // PRM scopes_supported=["mcp:tools.call","mcp:quota.read"]；/v1 为 API Key 兼容路径
    transport: remoteOAuthStdio('https://mcp.tianyancha.com/mcp', {
      scope: 'mcp:tools.call mcp:quota.read',
    }),
    ...withAuth('oauth', { gate: 'ready' }),
    docsUrl: 'https://ai.tianyancha.com/guide',
    credentialUrl: 'https://ai.tianyancha.com/guide',
    legacyRemoteUrls: ['https://mcp.tianyancha.com/v1'],
  },
  {
    id: 'hithink-a-share',
    name: '同花顺 · A股数据',
    descriptionKey: 'hithinkAShare',
    category: 'storage',
    // https://github.com/HiThink-Tech/Financial-API — 官方为 HTTP + X-api-key；stdio 用 mcp-remote 带 header
    transport: remoteStdio('https://fuyao.aicubes.cn/mcp/a-share', [
      '--header',
      'X-api-key:YOUR_HITHINK_API_KEY',
    ]),
    ...withAuth('api_key'),
    docsUrl: 'https://github.com/HiThink-Tech/Financial-API',
    // 官方「API Key 管理」：登录同花顺账号后签发 X-api-key
    credentialUrl: 'https://fuyao.aicubes.cn/admin/',
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    descriptionKey: 'dingtalk',
    category: 'collab',
    transport: stdio('npx', ['-y', 'dingtalk-mcp@latest'], {
      DINGTALK_Client_ID: '',
      DINGTALK_Client_Secret: '',
      ACTIVE_PROFILES: 'dingtalk-contacts,dingtalk-calendar',
    }),
    ...withAuth('app_credentials'),
    docsUrl: 'https://open.dingtalk.com/document/ai-dev/dingtalk-server-api-mcp-overview',
    credentialUrl: 'https://open-dev.dingtalk.com/',
  },
]

export function connectorNeedsCredentialForm(
  entry: Pick<RecommendedConnectorCatalogEntry, 'authKind'>,
): boolean {
  return entry.authKind === 'api_key' || entry.authKind === 'app_credentials'
}

export function connectorIsOAuthReady(
  entry: Pick<RecommendedConnectorCatalogEntry, 'authKind' | 'oauthGate'>,
): boolean {
  return entry.authKind === 'oauth' && entry.oauthGate === 'ready'
}

export function connectorIsPlatformOAuth(
  entry: Pick<RecommendedConnectorCatalogEntry, 'authKind' | 'oauthGate' | 'oauthHost'>,
): boolean {
  return connectorIsOAuthReady(entry) && entry.oauthHost === 'tabtin_backend'
}

export function connectorIsOAuthVendorGated(
  entry: Pick<RecommendedConnectorCatalogEntry, 'authKind' | 'oauthGate'>,
): boolean {
  return entry.authKind === 'oauth' && entry.oauthGate === 'vendor_pending'
}

export function normalizeConnectorEndpointUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    parsed.hash = ''
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/'
    return `${parsed.origin}${pathname}${parsed.search}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

/** stdio 参数里跟在这些 flag / 子命令后的值是凭据，比对「是否已接入」时跳过 flag 与下一参。 */
const STDIO_CREDENTIAL_FLAGS = new Set([
  '-a',
  '--app-id',
  '-s',
  '--app-secret',
  '-u',
  '--user-access-token',
  '--token',
  '--token-mode',
  '--scope',
  '--config',
  '--access-token',
  '--header',
  // Neon 旧本地包：`npx … start <API_KEY>`
  'start',
])

/** 非身份段：OAuth client metadata 等编排参数，版本钉扎后新旧连接仍算同一推荐项。 */
const STDIO_IDENTITY_SKIP_FLAGS = new Set([
  ...STDIO_CREDENTIAL_FLAGS,
  '--static-oauth-client-metadata',
  '--auth-timeout',
])

/** `mcp-remote@0.1.38` / `dingtalk-mcp@latest` / `@scope/pkg@1` → 去版本，便于匹配旧连接。 */
export function normalizeStdioPackageArg(arg: string): string {
  if (/^https?:\/\//i.test(arg)) return arg
  if (arg.startsWith('@')) {
    const slash = arg.indexOf('/')
    if (slash < 0) return arg
    const scope = arg.slice(0, slash)
    const nameAndVersion = arg.slice(slash + 1)
    const name = nameAndVersion.replace(/@[^@]+$/, '')
    return `${scope}/${name}`
  }
  return arg.replace(/@[^@]+$/, '')
}

/**
 * stdio 身份指纹：保留 command / 包名 / 远端 URL 等稳定段，
 * 跳过凭据 flag 及其下一参数（含 Neon 的 `start <api-key>`），
 * 避免用户填完凭证后推荐卡又变「接入」。
 */
export function stdioServerIdentity(command: string, args: readonly string[] = []): string {
  const tokens: string[] = [command]
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (STDIO_IDENTITY_SKIP_FLAGS.has(arg)) {
      i += 1
      continue
    }
    // `--header Key:Value` 已在上一支跳过；若写成单段也可能含密钥，跳过含冒号的 header 值形态
    if (/^(Authorization|X-api-key):/i.test(arg)) {
      continue
    }
    tokens.push(normalizeStdioPackageArg(arg))
  }
  return tokens.join('\0')
}

function transportFingerprint(transport: LocalMcpTransportConfig): string {
  if (transport.kind === 'http') {
    return `http\0${normalizeConnectorEndpointUrl(transport.url)}`
  }
  return `stdio\0${stdioServerIdentity(transport.command, transport.args ?? [])}`
}

function matchesLegacyStdioPackage(
  connection: LocalMcpConnectionSummary,
  packages: readonly string[] | undefined,
): boolean {
  if (!packages?.length || connection.transportKind !== 'stdio') return false
  const args = connection.args ?? []
  return packages.some(pkg =>
    args.some(arg => arg === pkg || arg.startsWith(`${pkg}@`) || arg.includes(pkg)),
  )
}

function matchesLegacyRemoteUrl(
  connection: LocalMcpConnectionSummary,
  legacyUrls: readonly string[] | undefined,
): boolean {
  if (!legacyUrls?.length) return false
  const remoteFromArgs = connection.args?.find(arg => /^https?:\/\//i.test(arg))
  const candidates = [remoteFromArgs, connection.url].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (candidates.length === 0) return false
  return candidates.some(candidate =>
    legacyUrls.some(
      legacy =>
        normalizeConnectorEndpointUrl(candidate) === normalizeConnectorEndpointUrl(legacy),
    ),
  )
}

/** 推荐货架条目是否已在本机接入（含旧 HTTP 同端点、旧本地 npm 包）。 */
export function findConnectionForRecommendedConnector(
  entry: RecommendedConnectorCatalogEntry,
  connections: readonly LocalMcpConnectionSummary[],
): LocalMcpConnectionSummary | undefined {
  const target = transportFingerprint(entry.transport)
  return connections.find(connection => {
    if (entry.transport.kind === 'http' && connection.transportKind === 'http' && connection.url) {
      return (
        transportFingerprint({ kind: 'http', url: connection.url }) === target
      )
    }
    // 兼容：货架改为 HTTP 后，旧 mcp-remote stdio 同端点仍算已接入。
    // 必须比对远端 URL：不可仅凭 `mcp-remote` 包名认领，否则 Stripe/Notion 等
    // 会被排在前面的 GitHub 条目误吃掉，保存时弹出「填写 GitHub Token」。
    if (entry.transport.kind === 'http' && connection.transportKind === 'stdio') {
      const remoteUrl = connection.args?.find(arg => /^https?:\/\//i.test(arg))
      if (!remoteUrl) return false
      return (
        normalizeConnectorEndpointUrl(remoteUrl)
        === normalizeConnectorEndpointUrl(entry.transport.url)
        || matchesLegacyRemoteUrl(connection, entry.legacyRemoteUrls)
      )
    }
    if (entry.transport.kind === 'stdio' && connection.transportKind === 'stdio') {
      if (
        transportFingerprint({
          kind: 'stdio',
          command: connection.command ?? '',
          args: connection.args,
        }) === target
      ) {
        return true
      }
      if (matchesLegacyStdioPackage(connection, entry.legacyStdioPackages)) {
        return true
      }
      return matchesLegacyRemoteUrl(connection, entry.legacyRemoteUrls)
    }
    // 兼容：用户以前按 HTTP 直接接入的同端点，仍算已接入该推荐项
    if (
      entry.transport.kind === 'stdio'
      && connection.transportKind === 'http'
      && connection.url
    ) {
      const remoteUrl = entry.transport.args?.find(arg => /^https?:\/\//i.test(arg))
      if (remoteUrl) {
        if (
          normalizeConnectorEndpointUrl(connection.url)
          === normalizeConnectorEndpointUrl(remoteUrl)
        ) {
          return true
        }
      }
      return matchesLegacyRemoteUrl(connection, entry.legacyRemoteUrls)
    }
    return false
  })
}

export function getRecommendedConnectorById(
  id: string,
): RecommendedConnectorCatalogEntry | undefined {
  return RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.id === id)
}

/** 本机连接若来自推荐货架，反查条目（用于密钥引导文案）。 */
export function findRecommendedCatalogEntryForConnection(
  connection: LocalMcpConnectionSummary,
): RecommendedConnectorCatalogEntry | undefined {
  return RECOMMENDED_CONNECTOR_CATALOG.find(
    entry => findConnectionForRecommendedConnector(entry, [connection])?.id === connection.id,
  )
}

function catalogRemoteUrl(entry: RecommendedConnectorCatalogEntry): string | undefined {
  if (entry.transport.kind === 'http') return entry.transport.url
  return entry.transport.args?.find(arg => /^https?:\/\//i.test(arg))
}

/**
 * 市场卡片密钥入口：优先本机连接指纹，其次组织 endpoint，最后按显示名兜底。
 */
export function resolveRecommendedCredentialUrl(input: {
  connection?: LocalMcpConnectionSummary | null
  endpoint?: string | null
  name?: string | null
}): string | undefined {
  if (input.connection) {
    const fromConnection = findRecommendedCatalogEntryForConnection(input.connection)?.credentialUrl
    if (fromConnection) return fromConnection
  }
  if (input.endpoint?.trim()) {
    const normalized = normalizeConnectorEndpointUrl(input.endpoint)
    const byEndpoint = RECOMMENDED_CONNECTOR_CATALOG.find(entry => {
      const remote = catalogRemoteUrl(entry)
      return remote
        ? normalizeConnectorEndpointUrl(remote) === normalized
        : false
    })
    if (byEndpoint?.credentialUrl) return byEndpoint.credentialUrl
  }
  const name = input.name?.trim()
  if (name) {
    const byName = RECOMMENDED_CONNECTOR_CATALOG.find(entry => entry.name === name)
    if (byName?.credentialUrl) return byName.credentialUrl
  }
  return undefined
}
