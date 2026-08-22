import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { guardedHandle } from '../utils/guarded-handle'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  LocalMcpCandidateSummary,
  LocalMcpConnectionDetail,
  LocalMcpConnectionSummary,
  LocalMcpDiscoveryResult,
  LocalMcpHttpConfig,
  LocalMcpManualConnectionInput,
  LocalMcpOrganizationMirrorInput,
  LocalMcpProbeSummary,
  LocalMcpPromptSummary,
  LocalMcpPromptReadResult,
  LocalMcpResourceReadResult,
  LocalMcpResourceSummary,
  LocalMcpServerRuntimeSummary,
  LocalMcpSourceKind,
  LocalMcpSourceRef,
  LocalMcpToolCallResult,
  LocalMcpToolSummary,
  LocalMcpTransportConfig,
} from '@shared/types/mcp'
import { McpErrorCode } from '@shared/types/mcp'
import { normalizeTransportConfig } from '@shared/mcp/parse-mcp-config'
import {
  buildOrgSharePayloadFromHttpDetail,
  redactTransportSecrets,
} from '@shared/mcp/org-share-payload'
import { assertCurrentUserCanAccessAgent, AgentAccessDeniedError } from '../security/agent-access-guard'
import { createLogger } from '../logger'
import { atomicWriteFileSync } from '@tabtin/terminal-core'
import { registerStorageBucket } from '@tabtin/storage-manager'
import { stat } from 'node:fs/promises'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import {
  closeConnectorOAuthWindow,
  createOAuthAuthorizeUrlParser,
  openConnectorOAuthWindow,
  restoreConnectorOAuthClient,
  waitForPlatformOAuthTicket,
  withMcpOpenShimPath,
} from './mcp-oauth-window'
import {
  ensureMcpRemoteClientName,
  extractMcpRemoteServerUrl,
} from './mcp-remote-client'
import { API_BASE_URL } from '../config/api'
import { TokenManager } from '../auth'
import {
  BundledMcpRemoteTransport,
  extractBundledMcpRemoteArgs,
} from './bundled-mcp-remote-transport'

const log = createLogger('LocalMcp')
const HOME = homedir()
const CONTENT_TEXT_MAX_CHARS = 50_000
const STRUCTURED_CONTENT_MAX_CHARS = 100_000
const SESSION_IDLE_MS = 10 * 60 * 1000
const SESSION_POOL_MAX = 20

function safeUrlHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'invalid'
  }
}

function isMcpRemoteStdioTransport(transport: LocalMcpTransportConfig): boolean {
  return (
    transport.kind === 'stdio'
    && (transport.args ?? []).some(arg => /(^|\/)mcp-remote(@|$)/.test(arg))
  )
}

function authorizationRequiredError(connectionName: string): Error {
  return new Error(JSON.stringify({
    code: McpErrorCode.AUTHORIZATION_REQUIRED,
    params: { name: connectionName },
  }))
}

type StoredSourceRef = LocalMcpSourceRef & {
  path?: string
}

type StoredConnection = {
  id: string
  name: string
  description?: string
  source: StoredSourceRef
  transport: LocalMcpTransportConfig
  /** 组织精选的成员本机覆盖层；不回写组织，也不包含组织下发的密钥。 */
  organizationOverrides?: {
    name?: string
    description?: string
    transport?: LocalMcpHttpConfig
  }
  enabled: boolean
  attachedAgentIds: string[]
  /** v1 遗留，仅用于提示用户重新授权，不参与 listing/call 权限。 */
  legacyAttachedSpaceIds?: string[]
  createdAt: string
  updatedAt: string
  lastProbe?: LocalMcpProbeSummary
}

function effectiveConnectionName(connection: StoredConnection): string {
  return connection.organizationOverrides?.name ?? connection.name
}

function effectiveConnectionDescription(connection: StoredConnection): string | undefined {
  return connection.organizationOverrides?.description ?? connection.description
}

function effectiveStoredTransport(connection: StoredConnection): LocalMcpTransportConfig {
  const override = connection.organizationOverrides?.transport
  if (connection.source.kind !== 'organization' || !override || connection.transport.kind !== 'http') {
    return connection.transport
  }
  return {
    kind: 'http',
    url: override.url || connection.transport.url,
    headers: {
      ...(connection.transport.headers ?? {}),
      ...(override.headers ?? {}),
    },
  }
}

type StoredData = {
  version: 2
  connections: StoredConnection[]
}

type DiscoverySource = {
  kind: LocalMcpSourceKind
  label: string
  path: string
}

type DiscoveryCandidate = {
  id: string
  name: string
  source: StoredSourceRef
  transport: LocalMcpTransportConfig
}

type ActiveSession = {
  key: string
  connectionId: string
  agentId: string
  lifecycle: SessionLifecycle
  client: Client
  createdAt: number
  lastUsedAt: number
}

type SessionLifecycle = {
  key: string
  connectionId: string
  agentId: string
  controller: AbortController
}

type PendingSession = {
  lifecycle: SessionLifecycle
  client: Client
  promise: Promise<ActiveSession>
}

type ProbeLifecycle = {
  controller: AbortController
  finished: Promise<void>
  finish: () => void
  discardResult: boolean
}

export type McpToolCacheInvalidation = {
  agentIds?: readonly string[]
  mode: 'drop' | 'stale'
  reason: 'configuration-changed' | 'server-list-changed' | 'dispose'
}

type McpToolCacheInvalidationListener = (event: McpToolCacheInvalidation) => void

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b))
}

/**
 * SS-20: 按平台解析 Claude Desktop 配置路径
 * macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 * Windows: %APPDATA%/Claude/claude_desktop_config.json
 * Linux:   ~/.config/Claude/claude_desktop_config.json
 */
function resolveClaudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(HOME, 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  const configDir = process.env.XDG_CONFIG_HOME || join(HOME, '.config')
  return join(configDir, 'Claude', 'claude_desktop_config.json')
}

function resolveWindsurfConfigPath(): string {
  if (process.platform === 'win32') {
    return join(HOME, '.codeium', 'windsurf', 'mcp_config.json')
  }
  return join(HOME, '.codeium', 'windsurf', 'mcp_config.json')
}

type DiscoverySourceDef = DiscoverySource & {
  serversKey?: string
}

const DISCOVERY_SOURCES: DiscoverySourceDef[] = [
  {
    kind: 'cursor',
    label: 'Cursor',
    path: join(HOME, '.cursor', 'mcp.json'),
  },
  {
    kind: 'claude',
    label: 'Claude Desktop',
    path: resolveClaudeDesktopConfigPath(),
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    path: join(HOME, '.claude.json'),
  },
  {
    kind: 'windsurf',
    label: 'Windsurf',
    path: resolveWindsurfConfigPath(),
  },
  {
    kind: 'vscode',
    label: 'VS Code',
    path: join(HOME, '.vscode', 'mcp.json'),
    serversKey: 'servers',
  },
]

function stripJsonComments(raw: string): string {
  let result = ''
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '"') {
      result += '"'
      i++
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === '\\') {
          result += raw[i] + (raw[i + 1] ?? '')
          i += 2
        } else {
          result += raw[i]
          i++
        }
      }
      if (i < raw.length) {
        result += '"'
        i++
      }
      continue
    }
    if (raw[i] === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++
      continue
    }
    if (raw[i] === '/' && raw[i + 1] === '*') {
      i += 2
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++
      i += 2
      continue
    }
    result += raw[i]
    i++
  }
  return result
}

function readJsonWithComments(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  } catch (error) {
    log.warn(`读取 MCP 配置失败: ${path}`, error)
    return null
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => typeof item === 'string' && item.trim().length > 0)
    .map(item => String(item))
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      result[key] = entry
    }
  }
  return result
}

function sanitizeTransportConfig(transport: LocalMcpTransportConfig): LocalMcpTransportConfig {
  if (transport.kind === 'http') {
    const url = transport.url?.trim()
    if (!url) {
      throw new Error(McpErrorCode.HTTP_URL_REQUIRED)
    }
    return {
      kind: 'http',
      url,
      headers: normalizeStringMap(transport.headers),
    }
  }

  const command = transport.command?.trim()
  if (!command) {
    throw new Error(McpErrorCode.STDIO_COMMAND_REQUIRED)
  }
  return {
    kind: 'stdio',
    command,
    args: normalizeStringArray(transport.args),
    cwd: typeof transport.cwd === 'string' && transport.cwd.trim() ? transport.cwd.trim() : undefined,
    env: normalizeStringMap(transport.env),
  }
}

function displayPath(path?: string): string | undefined {
  if (!path) return undefined
  if (path.startsWith(HOME)) {
    return `~${path.slice(HOME.length)}`
  }
  return path
}

function transportSummary(transport: LocalMcpTransportConfig): Pick<
  LocalMcpConnectionSummary,
  'transportKind' | 'command' | 'args' | 'cwd' | 'url' | 'envKeys' | 'headerKeys'
> {
  if (transport.kind === 'stdio') {
    return {
      transportKind: 'stdio',
      command: transport.command,
      args: transport.args ?? [],
      cwd: transport.cwd,
      envKeys: Object.keys(transport.env ?? {}).sort((a, b) => a.localeCompare(b)),
      headerKeys: [],
    }
  }

  return {
    transportKind: 'http',
    url: transport.url,
    envKeys: [],
    headerKeys: Object.keys(transport.headers ?? {}).sort((a, b) => a.localeCompare(b)),
  }
}

function candidateIdOf(kind: string, path: string, name: string): string {
  return createHash('sha1').update(`${kind}:${path}:${name}`).digest('hex')
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // OAuth 网页授权超过 SDK 默认 60s 时常见；给用户可读提示（技术原文仍保留在后半）
    if (/Request timed out|-32001/i.test(error.message)) {
      return `浏览器授权或连接确认超时。请重新授权，并在系统浏览器完成登录后尽快回到 TabTin。（${error.message}）`
    }
    return error.message
  }
  return String(error)
}

function normalizeToolSummary(tool: Record<string, any>): LocalMcpToolSummary {
  return {
    name: String(tool.name ?? ''),
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema as Record<string, unknown>
      : undefined,
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true,
    openWorld: tool.annotations?.openWorldHint === true,
  }
}

function normalizeResourceSummary(resource: Record<string, any>): LocalMcpResourceSummary {
  return {
    uri: String(resource.uri ?? ''),
    name: String(resource.name ?? resource.uri ?? ''),
    description: typeof resource.description === 'string' ? resource.description : undefined,
    mimeType: typeof resource.mimeType === 'string' ? resource.mimeType : undefined,
  }
}

function normalizePromptSummary(prompt: Record<string, any>): LocalMcpPromptSummary {
  const args = Array.isArray(prompt.arguments)
    ? prompt.arguments
        .filter(item => item && typeof item === 'object')
        .map((item: any) => ({
          name: String(item.name ?? ''),
          description: typeof item.description === 'string' ? item.description : undefined,
          required: item.required === true,
        }))
    : undefined
  return {
    name: String(prompt.name ?? ''),
    description: typeof prompt.description === 'string' ? prompt.description : undefined,
    arguments: args,
  }
}

export class LocalMcpService {
  private readonly sessionPool = new Map<string, ActiveSession>()
  private readonly sessionCreationPool = new Map<string, PendingSession>()
  private readonly sessionLifecyclePool = new Map<string, SessionLifecycle>()
  private readonly probeLifecycles = new Map<string, ProbeLifecycle>()
  private readonly toolCacheInvalidationListeners = new Set<McpToolCacheInvalidationListener>()
  private disposed = false
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null

  onToolCacheInvalidated(listener: McpToolCacheInvalidationListener): () => void {
    this.toolCacheInvalidationListeners.add(listener)
    return () => {
      this.toolCacheInvalidationListeners.delete(listener)
    }
  }

  private invalidateToolCache(event: McpToolCacheInvalidation): void {
    for (const listener of this.toolCacheInvalidationListeners) {
      try {
        listener(event)
      } catch (error) {
        log.warn('MCP 工具缓存失效监听器执行失败', error)
      }
    }
  }

  private invalidateConfiguredAgents(agentIds: Iterable<string>): void {
    const uniqueAgentIds = [...new Set(agentIds)].filter(Boolean)
    if (uniqueAgentIds.length === 0) return
    this.invalidateToolCache({
      agentIds: uniqueAgentIds,
      mode: 'drop',
      reason: 'configuration-changed',
    })
  }

  /**
   * 暴露给 storage-manager bucket 注册使用：拿到 connections.json 真实路径
   * 才能 stat 文件大小作 sizeFn。public 化只为打通注册边界，业务调用方仍
   * 不应直接使用——请走 listConnections / saveManualConnection 等 API。
   */
  public getStorePath(): string {
    return join(app.getPath('userData'), 'mcp', 'connections.json')
  }

  private ensureStoreDir(): void {
    // 单源派生：从 store 路径反推目录，避免硬编码"userData/mcp"二次出现。
    const dir = dirname(this.getStorePath())
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }

  private loadStore(): StoredData {
    try {
      const storePath = this.getStorePath()
      if (!existsSync(storePath)) {
        return { version: 2, connections: [] }
      }
      const raw = readFileSync(storePath, 'utf8')
      const parsed = JSON.parse(raw) as {
        version?: unknown
        connections?: Array<Record<string, unknown>>
      }
      const rawConnections = Array.isArray(parsed.connections)
        ? parsed.connections.filter(item => item && typeof item === 'object')
        : []

      if (parsed.version === 2) {
        return {
          version: 2,
          connections: rawConnections.map((item) => ({
            ...item,
            attachedAgentIds: uniqueStrings(item.attachedAgentIds),
            legacyAttachedSpaceIds: uniqueStrings(item.legacyAttachedSpaceIds),
          })) as StoredConnection[],
        }
      }

      const migrated: StoredData = {
        version: 2,
        connections: rawConnections.map((item) => {
          const { attachedSpaceIds: _legacyField, ...rest } = item
          const legacyAttachedSpaceIds = uniqueStrings(item.attachedSpaceIds)
          return {
            ...rest,
            attachedAgentIds: [],
            legacyAttachedSpaceIds: legacyAttachedSpaceIds.length > 0
              ? legacyAttachedSpaceIds
              : undefined,
          } as unknown as StoredConnection
        }),
      }
      try {
        this.saveStore(migrated)
      } catch (error) {
        // 迁移落盘失败不能把已成功解析的数据丢成空 store；本轮仍按 fail-closed v2 使用。
        log.warn('本地 MCP v1→v2 迁移落盘失败', error)
      }
      return migrated
    } catch (error) {
      log.warn('加载本地 MCP 连接失败', error)
      return { version: 2, connections: [] }
    }
  }

  private saveStore(data: StoredData): void {
    this.ensureStoreDir()
    atomicWriteFileSync(this.getStorePath(), JSON.stringify(data, null, 2), 0o600)
  }

  private discoveryCandidates(): DiscoveryCandidate[] {
    const candidates: DiscoveryCandidate[] = []
    for (const source of DISCOVERY_SOURCES) {
      const json = readJsonWithComments(source.path)
      if (!json) continue
      const servers = json[source.serversKey ?? 'mcpServers']
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue

      for (const [name, config] of Object.entries(servers)) {
        const transport = normalizeTransportConfig(config)
        if (!transport) continue
        candidates.push({
          id: candidateIdOf(source.kind, source.path, name),
          name,
          source: {
            kind: source.kind,
            label: source.label,
            path: source.path,
          },
          transport,
        })
      }
    }
    return candidates
  }

  private toCandidateSummary(
    candidate: DiscoveryCandidate,
    connections: StoredConnection[],
  ): LocalMcpCandidateSummary {
    const matched = connections.find(connection =>
      connection.source.kind === candidate.source.kind
      && connection.source.path === candidate.source.path
      && connection.name === candidate.name,
    )

    return {
      id: candidate.id,
      name: candidate.name,
      source: {
        kind: candidate.source.kind,
        label: candidate.source.label,
        path: displayPath(candidate.source.path),
      },
      ...transportSummary(candidate.transport),
      importedConnectionId: matched?.id,
      attachedAgentIds: matched?.attachedAgentIds ?? [],
    }
  }

  private toConnectionSummary(connection: StoredConnection): LocalMcpConnectionSummary {
    const effectiveDescription = effectiveConnectionDescription(connection)
    const description = typeof effectiveDescription === 'string'
      ? effectiveDescription.trim()
      : ''
    const transport = effectiveStoredTransport(connection)
    return {
      id: connection.id,
      name: effectiveConnectionName(connection),
      ...(description ? { description } : {}),
      source: {
        kind: connection.source.kind,
        label: connection.source.label,
        path: displayPath(connection.source.path),
        ...(connection.source.orgConnectionId
          ? { orgConnectionId: connection.source.orgConnectionId }
          : {}),
      },
      ...transportSummary(transport),
      enabled: connection.enabled,
      attachedAgentIds: [...connection.attachedAgentIds],
      requiresAgentSelection: (connection.legacyAttachedSpaceIds?.length ?? 0) > 0,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      lastProbe: connection.lastProbe,
    }
  }

  discover(): LocalMcpDiscoveryResult {
    const store = this.loadStore()
    const candidates = this.discoveryCandidates()
      .map(candidate => this.toCandidateSummary(candidate, store.connections))
      .sort((a, b) => a.name.localeCompare(b.name))

    return {
      timestamp: Date.now(),
      candidates,
    }
  }

  listConnections(): LocalMcpConnectionSummary[] {
    const store = this.loadStore()
    // 按 createdAt 倒序：新建靠前；挂载/启停只改 updatedAt，不能把条目顶到列表头。
    return store.connections
      .map(connection => this.toConnectionSummary(connection))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  getConnectionDetail(
    connectionId: string,
    options?: { includeSecrets?: boolean },
  ): LocalMcpConnectionDetail {
    const store = this.loadStore()
    const connection = store.connections.find(item => item.id === connectionId)
    if (!connection) {
      throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
    }
    const transport = sanitizeTransportConfig(effectiveStoredTransport(connection))
    return {
      ...this.toConnectionSummary(connection),
      transport: options?.includeSecrets ? transport : redactTransportSecrets(transport),
    }
  }

  /**
   * 在 main 内读取本机连接并 POST 组织 remote MCP，避免明文凭据进入 renderer。
   */
  async shareConnectionToOrganization(
    connectionId: string,
    organizationId: string,
  ): Promise<{ id: string; name: string }> {
    const orgId = organizationId?.trim()
    if (!orgId) {
      throw new Error('MCP_ERR:ORGANIZATION_REQUIRED')
    }
    const detail = this.getConnectionDetail(connectionId, { includeSecrets: true })
    const payload = buildOrgSharePayloadFromHttpDetail(detail)
    const token = await TokenManager.getAccessToken()
    if (!token) {
      throw new Error('MCP_ERR:ORG_SHARE_AUTH_REQUIRED')
    }
    const url = joinApiPath(API_BASE_URL, API_ENDPOINTS.MCP_CONNECTION.CREATE_ORG(orgId))
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const body = await resp.json().catch(() => ({})) as {
      success?: boolean
      data?: { id?: string; name?: string }
      message?: string
      code?: string
    }
    if (!resp.ok) {
      const detailMsg = body?.message || body?.code || `HTTP ${resp.status}`
      const err = new Error(detailMsg) as Error & { status?: number }
      err.status = resp.status
      throw err
    }
    const id = typeof body?.data?.id === 'string' ? body.data.id : ''
    const name = typeof body?.data?.name === 'string' && body.data.name.trim()
      ? body.data.name.trim()
      : payload.name
    if (!id) {
      throw new Error('MCP_ERR:ORG_SHARE_INVALID_RESPONSE')
    }
    return { id, name }
  }

  async saveManualConnection(input: LocalMcpManualConnectionInput): Promise<LocalMcpConnectionSummary> {
    if (input.attachToAgentId) {
      await this.assertAgentAttachable(input.attachToAgentId)
    }
    const store = this.loadStore()
    const now = new Date().toISOString()
    const name = input.name?.trim()
    if (!name) {
      throw new Error(McpErrorCode.NAME_REQUIRED)
    }
    const transport = sanitizeTransportConfig(input.transport)

    if (input.connectionId) {
      const connection = store.connections.find(item => item.id === input.connectionId)
      if (!connection) {
        throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
      }
      if (connection.source.kind !== 'manual' && connection.source.kind !== 'organization') {
        throw new Error(McpErrorCode.ONLY_MANUAL_EDITABLE)
      }

      if (connection.source.kind === 'organization') {
        if (transport.kind !== 'http' || connection.transport.kind !== 'http') {
          throw new Error(McpErrorCode.ONLY_MANUAL_EDITABLE)
        }
        const overrideHeaders = Object.fromEntries(
          Object.entries(transport.headers ?? {}).filter(([, value]) => value.trim().length > 0),
        )
        connection.organizationOverrides = {
          ...(name !== connection.name ? { name } : {}),
          ...((input.description?.trim() || '') !== (connection.description?.trim() || '')
            ? { description: input.description?.trim() || '' }
            : {}),
          ...(
            transport.url !== connection.transport.url || Object.keys(overrideHeaders).length > 0
              ? {
                  transport: {
                    kind: 'http' as const,
                    url: transport.url,
                    headers: overrideHeaders,
                  },
                }
              : {}
          ),
        }
        const previouslyAttachedAgentIds = [...connection.attachedAgentIds]
        connection.enabled = input.enabled ?? connection.enabled
        connection.updatedAt = now
        connection.lastProbe = undefined
        this.saveStore(store)
        await this.closeConnectionSessions(connection.id)
        this.invalidateConfiguredAgents(previouslyAttachedAgentIds)
        return this.toConnectionSummary(connection)
      }

      const previouslyAttachedAgentIds = [...connection.attachedAgentIds]
      const wasEnabled = connection.enabled
      const previousTransport = JSON.stringify(connection.transport)
      const nextTransport = JSON.stringify(transport)
      connection.name = name
      connection.description = input.description?.trim() || ''
      connection.transport = transport
      connection.enabled = input.enabled ?? connection.enabled
      connection.updatedAt = now
      if (input.attachToAgentId && !connection.attachedAgentIds.includes(input.attachToAgentId)) {
        connection.attachedAgentIds.push(input.attachToAgentId)
        connection.attachedAgentIds.sort((a, b) => a.localeCompare(b))
        connection.legacyAttachedSpaceIds = undefined
      }
      let closing = Promise.resolve()
      if (previousTransport !== nextTransport || (wasEnabled && !connection.enabled)) {
        connection.lastProbe = undefined
        closing = this.closeConnectionSessions(connection.id)
      }
      this.saveStore(store)
      await closing
      this.invalidateConfiguredAgents([
        ...previouslyAttachedAgentIds,
        ...connection.attachedAgentIds,
      ])
      return this.toConnectionSummary(connection)
    }

    const created: StoredConnection = {
      id: randomUUID(),
      name,
      description: input.description?.trim() || '',
      source: {
        kind: 'manual',
        label: 'Manual',
      },
      transport,
      enabled: input.enabled ?? true,
      attachedAgentIds: input.attachToAgentId ? [input.attachToAgentId] : [],
      createdAt: now,
      updatedAt: now,
    }
    store.connections.push(created)
    this.saveStore(store)
    this.invalidateConfiguredAgents(created.attachedAgentIds)
    return this.toConnectionSummary(created)
  }

  /**
   * 将组织 remote MCP 镜像到本机（不含明文凭据）。
   * 同一 orgConnectionId 幂等更新摘要；Agent 绑定保留。
   */
  upsertOrganizationMirror(input: LocalMcpOrganizationMirrorInput): LocalMcpConnectionSummary {
    const orgConnectionId = input.orgConnectionId?.trim()
    const name = input.name?.trim()
    const url = input.url?.trim()
    if (!orgConnectionId || !name || !url) {
      throw new Error(McpErrorCode.HTTP_URL_REQUIRED)
    }
    const store = this.loadStore()
    const now = new Date().toISOString()
    const existing = store.connections.find(
      item => item.source.kind === 'organization' && item.source.orgConnectionId === orgConnectionId,
    )
    const headerKeys = (input.headerKeys ?? []).map(key => key.trim()).filter(Boolean)
    const transport: LocalMcpTransportConfig = {
      kind: 'http',
      url,
      // 明文凭据不落本地；仅保留 header 键名供 UI 展示，spawn 前通过 runtime-config 注入
      headers: Object.fromEntries(headerKeys.map(key => [key, ''])),
    }
    if (existing) {
      existing.name = name
      existing.description = input.description?.trim() || ''
      existing.transport = transport
      existing.enabled = input.enabled ?? existing.enabled
      existing.updatedAt = now
      this.saveStore(store)
      this.invalidateConfiguredAgents(existing.attachedAgentIds)
      return this.toConnectionSummary(existing)
    }
    const created: StoredConnection = {
      id: randomUUID(),
      name,
      description: input.description?.trim() || '',
      source: {
        kind: 'organization',
        label: 'Organization',
        orgConnectionId,
      },
      transport,
      enabled: input.enabled ?? true,
      attachedAgentIds: [],
      createdAt: now,
      updatedAt: now,
    }
    store.connections.push(created)
    this.saveStore(store)
    return this.toConnectionSummary(created)
  }

  async importCandidate(candidateId: string, options?: { attachToAgentId?: string; name?: string }): Promise<LocalMcpConnectionSummary> {
    if (options?.attachToAgentId) {
      await this.assertAgentAttachable(options.attachToAgentId)
    }
    const store = this.loadStore()
    const candidate = this.discoveryCandidates().find(item => item.id === candidateId)
    if (!candidate) {
      throw new Error(McpErrorCode.CANDIDATE_NOT_FOUND)
    }

    const existing = store.connections.find(connection =>
      connection.source.kind === candidate.source.kind
      && connection.source.path === candidate.source.path
      && connection.name === candidate.name,
    )

    const now = new Date().toISOString()
    if (existing) {
      const previouslyAttachedAgentIds = [...existing.attachedAgentIds]
      const previousTransport = JSON.stringify(existing.transport)
      const nextTransport = JSON.stringify(candidate.transport)
      existing.enabled = true
      existing.source = candidate.source
      existing.transport = candidate.transport
      existing.updatedAt = now
      if (options?.attachToAgentId && !existing.attachedAgentIds.includes(options.attachToAgentId)) {
        existing.attachedAgentIds.push(options.attachToAgentId)
        existing.attachedAgentIds.sort((a, b) => a.localeCompare(b))
        existing.legacyAttachedSpaceIds = undefined
      }
      let closing = Promise.resolve()
      if (previousTransport !== nextTransport) {
        existing.lastProbe = undefined
        closing = this.closeConnectionSessions(existing.id)
      }
      this.saveStore(store)
      await closing
      this.invalidateConfiguredAgents([
        ...previouslyAttachedAgentIds,
        ...existing.attachedAgentIds,
      ])
      return this.toConnectionSummary(existing)
    }

    const created: StoredConnection = {
      id: randomUUID(),
      name: options?.name?.trim() || candidate.name,
      source: candidate.source,
      transport: candidate.transport,
      enabled: true,
      attachedAgentIds: options?.attachToAgentId ? [options.attachToAgentId] : [],
      createdAt: now,
      updatedAt: now,
    }
    store.connections.push(created)
    this.saveStore(store)
    this.invalidateConfiguredAgents(created.attachedAgentIds)
    return this.toConnectionSummary(created)
  }

  /**
   * 把本机 MCP connection 启用给某个 Agent。Agent detail 以后端 owner 权限为权威；
   * sender guard 只证明调用来自 first-party UI，不能证明 renderer 传来的 agentId 合法。
   * 解绑不需要联网校验，保证用户始终能收窄已有授权。
   */
  private async assertAgentAttachable(agentId: string): Promise<void> {
    try {
      await assertCurrentUserCanAccessAgent(agentId)
    } catch (err) {
      if (err instanceof AgentAccessDeniedError) {
        throw new Error(McpErrorCode.AGENT_ACCESS_DENIED)
      }
      throw err
    }
  }

  async attachConnection(connectionId: string, agentId: string, attached: boolean): Promise<LocalMcpConnectionSummary> {
    if (attached) {
      await this.assertAgentAttachable(agentId)
    }
    const store = this.loadStore()
    const connection = store.connections.find(item => item.id === connectionId)
    if (!connection) {
      throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
    }

    const next = new Set(connection.attachedAgentIds)
    let closing = Promise.resolve()
    if (attached) {
      next.add(agentId)
      connection.legacyAttachedSpaceIds = undefined
    } else {
      next.delete(agentId)
      closing = this.closeConnectionSessions(connectionId, agentId)
    }

    connection.attachedAgentIds = Array.from(next).sort((a, b) => a.localeCompare(b))
    connection.updatedAt = new Date().toISOString()
    this.saveStore(store)
    await closing
    this.invalidateConfiguredAgents([agentId])
    return this.toConnectionSummary(connection)
  }

  async setConnectionEnabled(connectionId: string, enabled: boolean): Promise<LocalMcpConnectionSummary> {
    const store = this.loadStore()
    const connection = store.connections.find(item => item.id === connectionId)
    if (!connection) {
      throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
    }
    const attachedAgentIds = [...connection.attachedAgentIds]
    connection.enabled = enabled
    connection.updatedAt = new Date().toISOString()
    let closing = Promise.resolve()
    if (!enabled) {
      closing = this.closeConnectionSessions(connectionId)
    }
    this.saveStore(store)
    await closing
    this.invalidateConfiguredAgents(attachedAgentIds)
    return this.toConnectionSummary(connection)
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const store = this.loadStore()
    const deleted = store.connections.find(item => item.id === connectionId)
    const nextConnections = store.connections.filter(item => item.id !== connectionId)
    if (nextConnections.length === store.connections.length) {
      throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
    }
    store.connections = nextConnections
    const closing = this.closeConnectionSessions(connectionId)
    this.saveStore(store)
    await closing
    this.invalidateConfiguredAgents(deleted?.attachedAgentIds ?? [])
  }

  async probeConnection(
    connectionId: string,
    options?: { timeoutMs?: number; openOAuthWindow?: boolean },
  ): Promise<LocalMcpProbeSummary> {
    const store = this.loadStore()
    const connection = store.connections.find(item => item.id === connectionId)
    if (!connection) {
      throw new Error(McpErrorCode.CONNECTION_NOT_FOUND)
    }

    // 同一连接只允许一个探测。旧生命周期留在 map 中充当串行门闩，直到子进程
    // 彻底关闭；这样快速连续重试时永远由最后一次操作生效。
    while (true) {
      const previousProbe = this.probeLifecycles.get(connectionId)
      if (!previousProbe) break
      previousProbe.discardResult = true
      previousProbe.controller.abort()
      await previousProbe.finished
      if (this.probeLifecycles.get(connectionId) === previousProbe) {
        this.probeLifecycles.delete(connectionId)
      }
    }

    const probedAt = new Date().toISOString()
    const controller = new AbortController()
    let finishProbe!: () => void
    const finished = new Promise<void>(resolve => { finishProbe = resolve })
    const lifecycle = { controller, finished, finish: finishProbe, discardResult: false }
    this.probeLifecycles.set(connectionId, lifecycle)
    const timeoutMs =
      typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
        ? Math.min(options.timeoutMs, 300_000)
        : 30_000
    let summary: LocalMcpProbeSummary

    try {
      summary = await this.withEphemeralClient(
        connection,
        async client => {
        const requestOptions = { timeout: timeoutMs }
        const tools = await client.listTools(undefined, requestOptions).then(
          result => result.tools.map(tool => normalizeToolSummary(tool as Record<string, any>)),
          () => [],
        )
        const resources = await client.listResources(undefined, requestOptions).then(
          result => result.resources.map(resource => normalizeResourceSummary(resource as Record<string, any>)),
          () => [],
        )
        const prompts = await client.listPrompts(undefined, requestOptions).then(
          result => result.prompts.map(prompt => normalizePromptSummary(prompt as Record<string, any>)),
          () => [],
        )
        return {
          ok: true,
          probedAt,
          tools,
          resources,
          prompts,
        }
      },
        timeoutMs,
        {
          openOAuthWindow: options?.openOAuthWindow === true,
          signal: controller.signal,
        },
      )
    } catch (error) {
      summary = {
        ok: false,
        probedAt,
        tools: [],
        resources: [],
        prompts: [],
        error: safeErrorMessage(error),
      }
    }

    lifecycle.finish()
    if (lifecycle.discardResult || this.probeLifecycles.get(connectionId) !== lifecycle) {
      return summary
    }
    this.probeLifecycles.delete(connectionId)

    const latestStore = this.loadStore()
    const latestConnection = latestStore.connections.find(item => item.id === connectionId)
    if (!latestConnection) {
      return summary
    }
    latestConnection.lastProbe = summary
    latestConnection.updatedAt = new Date().toISOString()
    this.saveStore(latestStore)
    return summary
  }

  async cancelProbe(connectionId: string): Promise<boolean> {
    const lifecycle = this.probeLifecycles.get(connectionId)
    if (!lifecycle) return false
    lifecycle.discardResult = true
    lifecycle.controller.abort()
    await lifecycle.finished
    if (this.probeLifecycles.get(connectionId) === lifecycle) {
      this.probeLifecycles.delete(connectionId)
    }
    return true
  }

  listAttachedServers(agentId: string): LocalMcpServerRuntimeSummary[] {
    return this.getAttachedConnections(agentId).map(connection => this.toServerRuntimeSummary(connection))
  }

  async listAttachedTools(
    agentId: string,
    selector?: { connectionId?: string; serverName?: string },
  ): Promise<Array<{ server: LocalMcpServerRuntimeSummary; tools: LocalMcpToolSummary[] }>> {
    const connections = selector
      ? [this.resolveAttachedConnection(agentId, selector)]
      : this.getAttachedConnections(agentId)

    if (connections.length === 0) {
      throw new Error(McpErrorCode.NO_ATTACHED_CONNECTIONS)
    }

    const settled = await Promise.allSettled(
      connections.map(connection =>
        this.runWithConnectionSession(
          agentId,
          connection,
          client => client.listTools(),
          { retryOnFailure: true },
        ).then(response => ({
          server: this.toServerRuntimeSummary(connection),
          tools: response.tools.map(tool => normalizeToolSummary(tool as Record<string, any>)),
        })),
      ),
    )
    const results: Array<{ server: LocalMcpServerRuntimeSummary; tools: LocalMcpToolSummary[] }> = []
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results.push(entry.value)
      }
    }
    if (results.length === 0 && settled.some(e => e.status === 'rejected')) {
      const first = settled.find(e => e.status === 'rejected') as PromiseRejectedResult
      throw first.reason
    }
    return results
  }

  async listAttachedResources(
    agentId: string,
    selector?: { connectionId?: string; serverName?: string },
  ): Promise<Array<{ server: LocalMcpServerRuntimeSummary; resources: LocalMcpResourceSummary[] }>> {
    const connections = selector
      ? [this.resolveAttachedConnection(agentId, selector)]
      : this.getAttachedConnections(agentId)

    if (connections.length === 0) {
      throw new Error(McpErrorCode.NO_ATTACHED_CONNECTIONS)
    }

    const settled = await Promise.allSettled(
      connections.map(connection =>
        this.runWithConnectionSession(
          agentId,
          connection,
          client => client.listResources().catch(() => ({ resources: [] as Array<Record<string, any>> })),
          { retryOnFailure: true },
        ).then(response => ({
          server: this.toServerRuntimeSummary(connection),
          resources: response.resources.map(resource => normalizeResourceSummary(resource as Record<string, any>)),
        })),
      ),
    )
    const results: Array<{ server: LocalMcpServerRuntimeSummary; resources: LocalMcpResourceSummary[] }> = []
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results.push(entry.value)
      }
    }
    if (results.length === 0 && settled.some(e => e.status === 'rejected')) {
      const first = settled.find(e => e.status === 'rejected') as PromiseRejectedResult
      throw first.reason
    }
    return results
  }

  async listAttachedPrompts(
    agentId: string,
    selector?: { connectionId?: string; serverName?: string },
  ): Promise<Array<{ server: LocalMcpServerRuntimeSummary; prompts: LocalMcpPromptSummary[] }>> {
    const connections = selector
      ? [this.resolveAttachedConnection(agentId, selector)]
      : this.getAttachedConnections(agentId)

    if (connections.length === 0) {
      throw new Error(McpErrorCode.NO_ATTACHED_CONNECTIONS)
    }

    const settled = await Promise.allSettled(
      connections.map(connection =>
        this.runWithConnectionSession(
          agentId,
          connection,
          client => client.listPrompts().catch(() => ({ prompts: [] as Array<Record<string, any>> })),
          { retryOnFailure: true },
        ).then(response => ({
          server: this.toServerRuntimeSummary(connection),
          prompts: response.prompts.map(prompt => normalizePromptSummary(prompt as Record<string, any>)),
        })),
      ),
    )
    const results: Array<{ server: LocalMcpServerRuntimeSummary; prompts: LocalMcpPromptSummary[] }> = []
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        results.push(entry.value)
      }
    }
    if (results.length === 0 && settled.some(e => e.status === 'rejected')) {
      const first = settled.find(e => e.status === 'rejected') as PromiseRejectedResult
      throw first.reason
    }
    return results
  }

  async callTool(
    agentId: string,
    selector: { connectionId?: string; serverName?: string },
    toolName: string,
    argumentsPayload?: Record<string, unknown>,
  ): Promise<LocalMcpToolCallResult> {
    const connection = this.resolveAttachedConnection(agentId, selector)
    const result = await this.runWithConnectionSession(
      agentId,
      connection,
      client => client.callTool({
        name: toolName,
        arguments: argumentsPayload ?? {},
      }),
      { retryOnFailure: true },
    )

    let contentTruncated = false
    const truncatedContent = Array.isArray(result.content)
      ? result.content.map(item => {
          const mapped = { ...(item as Record<string, unknown>) }
          if (typeof mapped.text === 'string' && mapped.text.length > CONTENT_TEXT_MAX_CHARS) {
            mapped.text = mapped.text.slice(0, CONTENT_TEXT_MAX_CHARS)
            contentTruncated = true
          }
          return mapped
        })
      : []

    let structuredContentTruncated = false
    let structuredContent: Record<string, unknown> | undefined
    if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
      const serialized = JSON.stringify(result.structuredContent)
      if (serialized.length > STRUCTURED_CONTENT_MAX_CHARS) {
        structuredContent = undefined
        structuredContentTruncated = true
      } else {
        structuredContent = result.structuredContent as Record<string, unknown>
      }
    }

    return {
      server: this.toServerRuntimeSummary(connection),
      toolName,
      isError: result.isError === true,
      content: truncatedContent,
      structuredContent,
      contentTruncated: contentTruncated || undefined,
      structuredContentTruncated: structuredContentTruncated || undefined,
    }
  }

  async readResource(
    agentId: string,
    selector: { connectionId?: string; serverName?: string },
    uri: string,
  ): Promise<LocalMcpResourceReadResult> {
    const connection = this.resolveAttachedConnection(agentId, selector)
    const result = await this.runWithConnectionSession(
      agentId,
      connection,
      client => client.readResource({ uri }),
      { retryOnFailure: true },
    )

    return {
      server: this.toServerRuntimeSummary(connection),
      uri,
      contents: Array.isArray(result.contents)
        ? result.contents.map(item => ({ ...(item as Record<string, unknown>) }))
        : [],
    }
  }

  async getPrompt(
    agentId: string,
    selector: { connectionId?: string; serverName?: string },
    promptName: string,
    argumentsPayload?: Record<string, string>,
  ): Promise<LocalMcpPromptReadResult> {
    const connection = this.resolveAttachedConnection(agentId, selector)
    const result = await this.runWithConnectionSession(
      agentId,
      connection,
      client => client.getPrompt({
        name: promptName,
        arguments: argumentsPayload ?? {},
      }),
      { retryOnFailure: true },
    )

    return {
      server: this.toServerRuntimeSummary(connection),
      promptName,
      description: typeof result.description === 'string' ? result.description : undefined,
      messages: Array.isArray(result.messages)
        ? result.messages.map(item => ({ ...(item as Record<string, unknown>) }))
        : [],
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval)
      this.idleCheckInterval = null
    }
    const activeProbes = [...this.probeLifecycles.values()]
    this.probeLifecycles.clear()
    for (const lifecycle of activeProbes) {
      lifecycle.discardResult = true
      lifecycle.controller.abort()
    }
    await Promise.allSettled(
      activeProbes.map(lifecycle => lifecycle.finished),
    )
    await this.closeAllSessions()
    this.invalidateToolCache({ mode: 'drop', reason: 'dispose' })
    this.toolCacheInvalidationListeners.clear()
  }

  /**
   * 查询某 Agent 已挂载且 enabled 的 MCP 安全摘要（不含凭据）。
   * 供 device action `mcp.list_agent_attachments` 等只读同步使用。
   */
  listAgentAttachedSummaries(agentId: string): LocalMcpConnectionSummary[] {
    return this.getAttachedConnections(agentId).map(connection => this.toConnectionSummary(connection))
  }

  private getAttachedConnections(agentId: string): StoredConnection[] {
    return this.loadStore().connections.filter(connection =>
      connection.enabled
      && connection.attachedAgentIds.includes(agentId),
    )
  }

  private resolveAttachedConnection(
    agentId: string,
    selector: { connectionId?: string; serverName?: string },
  ): StoredConnection {
    const attached = this.getAttachedConnections(agentId)
    if (attached.length === 0) {
      throw new Error(McpErrorCode.NO_ATTACHED_CONNECTIONS)
    }

    if (selector.connectionId) {
      const matched = attached.find(connection => connection.id === selector.connectionId)
      if (!matched) {
        throw new Error(McpErrorCode.CONNECTION_NOT_ATTACHED)
      }
      return matched
    }

    if (selector.serverName) {
      const normalized = selector.serverName.trim().toLowerCase()
      const matches = attached.filter(connection => connection.name.trim().toLowerCase() === normalized)
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) {
        throw new Error(McpErrorCode.DUPLICATE_SERVER_NAME)
      }
      throw new Error(McpErrorCode.SERVER_NAME_NOT_FOUND)
    }

    if (attached.length === 1) {
      return attached[0]
    }

    throw new Error(McpErrorCode.MULTIPLE_SERVERS)
  }

  private startIdleCheck(): void {
    if (this.idleCheckInterval) return
    this.idleCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const [key, session] of this.sessionPool.entries()) {
        if (now - session.lastUsedAt > SESSION_IDLE_MS) {
          this.sessionPool.delete(key)
          session.client.close().catch(() => undefined)
        }
      }
    }, 60_000)
  }

  private sessionKey(agentId: string, connectionId: string): string {
    return `${agentId}:${connectionId}`
  }

  private getOrCreateSessionLifecycle(
    agentId: string,
    connectionId: string,
  ): SessionLifecycle {
    const key = this.sessionKey(agentId, connectionId)
    const existing = this.sessionLifecyclePool.get(key)
    if (existing) return existing
    const created: SessionLifecycle = {
      key,
      agentId,
      connectionId,
      controller: new AbortController(),
    }
    this.sessionLifecyclePool.set(key, created)
    return created
  }

  private acquireAuthorizedSession(
    agentId: string,
    connectionId: string,
  ): { lifecycle: SessionLifecycle; connection: StoredConnection } {
    const connection = this.loadStore().connections.find(item =>
      item.id === connectionId
      && item.enabled
      && item.attachedAgentIds.includes(agentId),
    )
    if (!connection) {
      throw new Error(McpErrorCode.SESSION_REVOKED)
    }
    // 授权检查和 lifecycle 创建之间没有 await：撤销要么发生在这之前并使
    // 校验失败，要么发生在这之后并 abort 当前 lifecycle。
    return {
      lifecycle: this.getOrCreateSessionLifecycle(agentId, connectionId),
      connection,
    }
  }

  private async raceWithLifecycle<T>(
    promise: Promise<T>,
    lifecycle: SessionLifecycle,
    timeout?: { ms: number; error: Error },
  ): Promise<T> {
    const signal = lifecycle.controller.signal
    if (signal.aborted) {
      throw new Error(McpErrorCode.SESSION_REVOKED)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const revoked = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(McpErrorCode.SESSION_REVOKED))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const racers: Promise<T>[] = [promise, revoked]
    if (timeout) {
      racers.push(new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout.error), timeout.ms)
      }))
    }

    try {
      return await Promise.race(racers)
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  private closeClients(clients: Iterable<Client>): Promise<void> {
    return Promise.allSettled(
      Array.from(new Set(clients), client =>
        Promise.resolve().then(() => client.close()),
      ),
    ).then(() => undefined)
  }

  private async ensureSession(
    lifecycle: SessionLifecycle,
    connection: StoredConnection,
  ): Promise<ActiveSession> {
    const { key, agentId } = lifecycle

    if (!this.idleCheckInterval) {
      this.startIdleCheck()
    }

    const existing = this.sessionPool.get(key)
    if (existing?.lifecycle === lifecycle) {
      existing.lastUsedAt = Date.now()
      return existing
    }
    if (existing) {
      this.sessionPool.delete(key)
      void existing.client.close().catch(() => undefined)
    }

    const pending = this.sessionCreationPool.get(key)
    if (pending?.lifecycle === lifecycle) {
      return pending.promise
    }
    if (pending) {
      this.sessionCreationPool.delete(key)
      void pending.client.close().catch(() => undefined)
    }

    if (this.sessionPool.size >= SESSION_POOL_MAX) {
      const oldest = Array.from(this.sessionPool.values())
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (oldest) {
        this.sessionPool.delete(oldest.key)
        oldest.client.close().catch(() => undefined)
      }
    }

    const client = new Client(
      {
        name: 'tabtin-electron',
        version: app.getVersion(),
      },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 100,
            onChanged: () => {
              this.invalidateToolCache({
                agentIds: [agentId],
                mode: 'stale',
                reason: 'server-list-changed',
              })
            },
          },
        },
      },
    )
    const creationPromise = (async () => {
      const resolved = await this.resolveRuntimeTransport(connection)
      const looksLikeMcpRemote = isMcpRemoteStdioTransport(resolved)
      if (looksLikeMcpRemote && resolved.kind === 'stdio') {
        const remoteUrl = extractMcpRemoteServerUrl(resolved.args)
        if (remoteUrl) {
          ensureMcpRemoteClientName(remoteUrl, 'TabTin')
        }
      }
      // 后台建连禁止弹授权窗 / 系统浏览器；未授权则快速失败，留给用户主动「前往授权」。
      let authRequiredError: Error | undefined
      const authWaiters: Array<(error: Error) => void> = []
      const rejectAuthRequired = (error: Error) => {
        if (authRequiredError) return
        authRequiredError = error
        for (const waiter of authWaiters) waiter(error)
        authWaiters.length = 0
      }
      const parseAuthorizeUrl = createOAuthAuthorizeUrlParser(url => {
        log.info('mcp-remote requires authorization; suppressing browser for background session', {
          connectionId: connection.id,
          host: safeUrlHost(url),
        })
        rejectAuthRequired(authorizationRequiredError(connection.name))
      })
      const transport = this.createTransport(resolved, {
        interceptSystemBrowserOpen: looksLikeMcpRemote,
        onStderrLine: looksLikeMcpRemote
          ? line => {
              parseAuthorizeUrl(line)
              if (/^Fatal error:/i.test(line) || /InvalidClientMetadataError:/i.test(line)) {
                rejectAuthRequired(
                  new Error(line.replace(/^Fatal error:\s*/i, '').trim() || line),
                )
              }
            }
          : undefined,
      })
      const authPromise = new Promise<never>((_, reject) => {
        if (authRequiredError) {
          reject(authRequiredError)
          return
        }
        authWaiters.push(reject)
      })
      try {
        await this.raceWithLifecycle(
          Promise.race([client.connect(transport), authPromise]),
          lifecycle,
        )
      } catch (error) {
        await client.close().catch(() => undefined)
        throw error
      }

      if (
        lifecycle.controller.signal.aborted
        || this.sessionLifecyclePool.get(key) !== lifecycle
      ) {
        await client.close().catch(() => undefined)
        throw new Error(McpErrorCode.SESSION_REVOKED)
      }

      const created: ActiveSession = {
        key,
        connectionId: connection.id,
        agentId,
        lifecycle,
        client,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      }
      this.sessionPool.set(key, created)
      return created
    })()

    const pendingSession: PendingSession = {
      lifecycle,
      client,
      promise: creationPromise,
    }
    this.sessionCreationPool.set(key, pendingSession)
    try {
      return await creationPromise
    } finally {
      if (this.sessionCreationPool.get(key)?.promise === creationPromise) {
        this.sessionCreationPool.delete(key)
      }
    }
  }

  private async runWithConnectionSession<T>(
    agentId: string,
    connection: StoredConnection,
    run: (client: Client) => Promise<T>,
    options?: { retryOnFailure?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const attempts = options?.retryOnFailure ? 2 : 1
    // SS-22: 默认 60s 超时，防止 MCP server 无响应时 IPC handler 永久挂起
    const timeoutMs = options?.timeoutMs ?? 60_000
    let lastError: unknown
    const authorized = this.acquireAuthorizedSession(agentId, connection.id)
    const lifecycle = authorized.lifecycle
    const runtimeConnection = authorized.connection

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (lifecycle.controller.signal.aborted) {
        throw new Error(McpErrorCode.SESSION_REVOKED)
      }
      const session = await this.ensureSession(lifecycle, runtimeConnection)
      session.lastUsedAt = Date.now()
      try {
        return await this.raceWithLifecycle(
          run(session.client),
          lifecycle,
          {
            ms: timeoutMs,
            error: new Error(JSON.stringify({
              code: McpErrorCode.OPERATION_TIMEOUT,
              params: { seconds: timeoutMs / 1000, name: runtimeConnection.name },
            })),
          },
        )
      } catch (error) {
        lastError = error
        if (lifecycle.controller.signal.aborted) {
          throw new Error(McpErrorCode.SESSION_REVOKED)
        }
        await this.discardSession(lifecycle)
        if (attempt + 1 >= attempts) {
          throw error
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async resolveRuntimeTransport(
    connection: StoredConnection,
  ): Promise<LocalMcpTransportConfig> {
    if (connection.source.kind !== 'organization' || !connection.source.orgConnectionId) {
      return connection.transport
    }
    const token = await TokenManager.getAccessToken()
    if (!token) {
      throw new Error('MCP_ERR:ORG_RUNTIME_AUTH_REQUIRED')
    }
    const url = joinApiPath(
      API_BASE_URL,
      API_ENDPOINTS.MCP_CONNECTION.RUNTIME_CONFIG(connection.source.orgConnectionId),
    )
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const body = await resp.json().catch(() => ({})) as {
      success?: boolean
      data?: {
        endpoint?: string
        headers?: Record<string, string>
        env?: Record<string, string>
        enabled?: boolean
      }
      message?: string
      code?: string
    }
    if (!resp.ok || !body?.data?.endpoint) {
      const detail = body?.code || body?.message || 'MCP_ERR:ORG_RUNTIME_CONFIG_FAILED'
      throw new Error(detail)
    }
    // 组织 remote 仅支持 HTTP：StreamableHTTP 只吃 headers。后端对 http 会把
    // credential_env 同步注入 headers；此处仍只拼 header，避免把密钥写进本地 JSON。
    const localOverride = connection.organizationOverrides?.transport
    return {
      kind: 'http',
      url: localOverride?.url || body.data.endpoint,
      headers: {
        ...(body.data.headers ?? {}),
        ...(localOverride?.headers ?? {}),
      },
    }
  }

  private createTransport(
    transport: LocalMcpTransportConfig,
    options?: { onStderrLine?: (line: string) => void; interceptSystemBrowserOpen?: boolean },
  ) {
    if (transport.kind === 'stdio') {
      const mergedEnv =
        transport.env && Object.keys(transport.env).length > 0
          ? { ...process.env, ...transport.env }
          : { ...process.env }
      const env = options?.interceptSystemBrowserOpen
        ? withMcpOpenShimPath(mergedEnv)
        : (Object.fromEntries(
            Object.entries(mergedEnv).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ) as Record<string, string>)
      const bundledMcpRemoteArgs = extractBundledMcpRemoteArgs(
        transport.command,
        transport.args,
      )
      if (bundledMcpRemoteArgs) {
        const bundledTransport = new BundledMcpRemoteTransport({
          args: bundledMcpRemoteArgs,
          cwd: transport.cwd,
          env: Object.keys(env).length > 0 ? env : undefined,
        }, join(app.getAppPath(), 'out', 'main', 'mcp-remote-host-process.mjs'))
        bundledTransport.stderr.on('data', chunk => {
          const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            log.debug('[MCP:mcp-remote] stderr:', trimmed)
            options?.onStderrLine?.(trimmed)
          }
        })
        return bundledTransport
      }
      const clientTransport = new StdioClientTransport({
        command: transport.command,
        args: transport.args ?? [],
        cwd: transport.cwd,
        env: Object.keys(env).length > 0 ? env : undefined,
        stderr: 'pipe',
      })
      const stderr = clientTransport.stderr
      if (stderr) {
        stderr.on('data', chunk => {
          const text = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk)
          for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            log.debug(`[MCP:${transport.command}] stderr: ${trimmed}`)
            options?.onStderrLine?.(trimmed)
          }
        })
      }
      return clientTransport
    }

    return new StreamableHTTPClientTransport(new URL(transport.url), {
      requestInit: {
        headers: transport.headers,
      },
    })
  }

  private async withEphemeralClient<T>(
    connection: StoredConnection,
    run: (client: Client) => Promise<T>,
    timeoutMs = 30_000,
    options?: { openOAuthWindow?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const openOAuthWindow = options?.openOAuthWindow === true
    const client = new Client(
      { name: 'tabtin-electron-probe', version: app.getVersion() },
      { capabilities: {} },
    )
    const resolved = await this.resolveRuntimeTransport(connection)
    let fatalError: Error | undefined
    const fatalWaiters: Array<(error: Error) => void> = []
    const rejectFatal = (error: Error) => {
      if (fatalError) return
      fatalError = error
      for (const waiter of fatalWaiters) waiter(error)
      fatalWaiters.length = 0
    }
    const parseAuthorizeUrl = createOAuthAuthorizeUrlParser(url => {
      const host = safeUrlHost(url)
      if (openOAuthWindow) {
        log.info('opening connector oauth in system browser from mcp-remote stderr', { host })
        openConnectorOAuthWindow(url)
        return
      }
      // 自动探测 / 普通 probe：拦截授权 URL，禁止弹窗与系统浏览器
      log.info('mcp-remote requires authorization; suppressing oauth window for probe', {
        connectionId: connection.id,
        host,
      })
      rejectFatal(authorizationRequiredError(connection.name))
    })
    const looksLikeMcpRemote = isMcpRemoteStdioTransport(resolved)
    if (looksLikeMcpRemote && resolved.kind === 'stdio') {
      const remoteUrl = extractMcpRemoteServerUrl(resolved.args)
      if (remoteUrl) {
        // 旧动态注册常叫「MCP CLI Proxy」；清掉后按货架 client_name=TabTin 重注册
        ensureMcpRemoteClientName(remoteUrl, 'TabTin')
      }
    }
    const transport = this.createTransport(resolved, {
      interceptSystemBrowserOpen: looksLikeMcpRemote,
      onStderrLine: line => {
        parseAuthorizeUrl(line)
        // mcp-remote 等在 Fatal 后未必立刻让 client.connect reject，探测会空转到超时。
        if (/^Fatal error:/i.test(line) || /InvalidClientMetadataError:/i.test(line)) {
          rejectFatal(new Error(line.replace(/^Fatal error:\s*/i, '').trim() || line))
        }
      },
    })
    let timer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(JSON.stringify({ code: McpErrorCode.PROBE_TIMEOUT, params: { seconds: timeoutMs / 1000 } }))), timeoutMs)
    })
    const fatalPromise = new Promise<never>((_, reject) => {
      if (fatalError) {
        reject(fatalError)
        return
      }
      fatalWaiters.push(reject)
    })
    let rejectCancelled: (() => void) | undefined
    const cancelledPromise = new Promise<never>((_, reject) => {
      rejectCancelled = () => reject(new Error(McpErrorCode.SESSION_REVOKED))
      if (options?.signal?.aborted) {
        rejectCancelled()
        return
      }
      options?.signal?.addEventListener('abort', rejectCancelled, { once: true })
    })
    try {
      // OAuth 网页授权常超过 SDK 默认 60s；把 initialize 超时对齐到探测预算，否则会先报 -32001。
      await Promise.race([
        client.connect(transport, { timeout: timeoutMs }),
        timeoutPromise,
        fatalPromise,
        cancelledPromise,
      ])
      // mcp-remote 只有在 OAuth 回调、令牌交换与 MCP initialize 都完成后
      // 才会让 connect resolve。此时授权已经成功，应立即把客户端带回前台；
      // 不能等 tools/resources/prompts 能力枚举，部分远端会让这一阶段长时间挂起。
      if (openOAuthWindow) {
        restoreConnectorOAuthClient()
      }
      return await Promise.race([run(client), timeoutPromise, fatalPromise, cancelledPromise])
    } finally {
      clearTimeout(timer!)
      if (rejectCancelled) {
        options?.signal?.removeEventListener('abort', rejectCancelled)
      }
      // 仅主动授权流会开窗；后台 probe 关窗会误关正在进行的用户授权。
      if (openOAuthWindow) {
        closeConnectorOAuthWindow()
      }
      await client.close().catch(() => undefined)
    }
  }

  private toServerRuntimeSummary(connection: StoredConnection): LocalMcpServerRuntimeSummary {
    return {
      connectionId: connection.id,
      serverName: connection.name,
      sourceLabel: connection.source.label,
      transportKind: connection.transport.kind,
    }
  }

  private discardSession(lifecycle: SessionLifecycle): Promise<void> {
    const clients = new Set<Client>()
    const active = this.sessionPool.get(lifecycle.key)
    if (active?.lifecycle === lifecycle) {
      this.sessionPool.delete(lifecycle.key)
      clients.add(active.client)
    }
    const pending = this.sessionCreationPool.get(lifecycle.key)
    if (pending?.lifecycle === lifecycle) {
      this.sessionCreationPool.delete(lifecycle.key)
      clients.add(pending.client)
    }
    return this.closeClients(clients)
  }

  private closeAllSessions(): Promise<void> {
    const clients = new Set<Client>()
    for (const session of this.sessionPool.values()) clients.add(session.client)
    for (const pending of this.sessionCreationPool.values()) clients.add(pending.client)
    for (const lifecycle of this.sessionLifecyclePool.values()) {
      lifecycle.controller.abort()
    }
    this.sessionPool.clear()
    this.sessionCreationPool.clear()
    this.sessionLifecyclePool.clear()
    return this.closeClients(clients)
  }

  private closeConnectionSessions(
    connectionId: string,
    agentId?: string,
  ): Promise<void> {
    const matches = (target: {
      connectionId: string
      agentId: string
    }) =>
      target.connectionId === connectionId
      && (agentId ? target.agentId === agentId : true)

    const clients = new Set<Client>()
    const lifecycles = new Set<SessionLifecycle>()
    for (const lifecycle of this.sessionLifecyclePool.values()) {
      if (matches(lifecycle)) lifecycles.add(lifecycle)
    }
    for (const session of this.sessionPool.values()) {
      if (matches(session)) {
        lifecycles.add(session.lifecycle)
        clients.add(session.client)
      }
    }
    for (const pending of this.sessionCreationPool.values()) {
      if (matches(pending.lifecycle)) {
        lifecycles.add(pending.lifecycle)
        clients.add(pending.client)
      }
    }

    // 先同步撤销全部 lifecycle，再清池和关闭 client。这样所有正在等待的调用
    // 会立即收到 SESSION_REVOKED，且连接完成回调无法把旧 session 写回池中。
    for (const lifecycle of lifecycles) {
      lifecycle.controller.abort()
      if (this.sessionLifecyclePool.get(lifecycle.key) === lifecycle) {
        this.sessionLifecyclePool.delete(lifecycle.key)
      }
      if (this.sessionPool.get(lifecycle.key)?.lifecycle === lifecycle) {
        this.sessionPool.delete(lifecycle.key)
      }
      if (this.sessionCreationPool.get(lifecycle.key)?.lifecycle === lifecycle) {
        this.sessionCreationPool.delete(lifecycle.key)
      }
    }

    return this.closeClients(clients)
  }
}

let singleton: LocalMcpService | null = null

export function getLocalMcpService(): LocalMcpService {
  if (!singleton) {
    singleton = new LocalMcpService()
  }
  return singleton
}

// ── storage-manager 注册（W2.2 G1，business-app）────────────────
//
// 数据落盘：{userData}/mcp/connections.json（atomic write 0o600）。
// 数据语义：用户配置的本地 MCP 连接（manual + 从 IDE 配置导入），
// data 类弱依赖——清掉后可从 IDE mcp.json 重新发现，但用户编辑过的
// attachedAgentIds / enabled / 自定义 manual 连接会丢。
// 注册函数幂等：重复调用会因 storage-manager 抛 BucketAlreadyRegisteredError，
// 在 try/catch 里吞掉，HMR / 测试场景下都安全。

async function _aggregateMcpConnectionsSize(): Promise<{
  bytes: number
  itemCount: number
  connections: LocalMcpConnectionSummary[]
}> {
  const service = getLocalMcpService()
  let bytes = 0
  try {
    const st = await stat(service.getStorePath())
    bytes = st.size
  } catch {
    bytes = 0
  }
  let connections: LocalMcpConnectionSummary[] = []
  try {
    connections = service.listConnections()
  } catch {
    // service 未初始化 / store 损坏：保持空列表
  }
  return { bytes, itemCount: connections.length, connections }
}

export function registerMcpLocalConnectionsBucket(): () => void {
  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'mcp:local-connections',
      category: 'data',
      group: 'business-app',
      displayName: 'AI 外部工具连接（MCP）',
      description: '连接 Claude Desktop / Cursor / Windsurf 等外部 AI 工具的配置（高级用户功能；不熟悉的话可以保留不动）。',
      warnings: [
        '所有手动添加的连接配置会被删除',
        '从 IDE 导入的连接可以重新导入，但你给每个连接调过的"启用 / 关联到哪些 Agent"等设置会丢',
        '清理时正在调用中的 AI 外部工具会话会被强制断开',
      ],
      requiresConfirmation: 'soft',
      sizeFn: async () => {
        const { bytes, itemCount } = await _aggregateMcpConnectionsSize()
        return { bytes, itemCount }
      },
      listFn: async () => {
        const { connections } = await _aggregateMcpConnectionsSize()
        return connections.map((connection) => ({
          id: connection.id,
          label: `${connection.name}（${connection.source.label}）`,
          metadata: {
            source: connection.source.kind,
            transportKind: connection.transportKind,
            enabled: connection.enabled,
            attachedAgentCount: connection.attachedAgentIds.length,
            updatedAt: connection.updatedAt,
          },
        }))
      },
      clearFn: async (options) => {
        const { bytes, itemCount, connections } = await _aggregateMcpConnectionsSize()

        // R3-7 修复：connections.json 是单文件，按记录数线性折算 freedBytes
        // 让 dryRun 在 itemIds 模式给出有意义的预估，而不是误导用户的 0。
        const perRecordBytes = connections.length > 0
          ? Math.floor(bytes / connections.length)
          : 0

        if (options?.dryRun) {
          if (options.itemIds?.length) {
            return {
              clearedItemCount: options.itemIds.length,
              freedBytes: perRecordBytes * options.itemIds.length,
            }
          }
          return { clearedItemCount: itemCount, freedBytes: bytes }
        }

        const service = getLocalMcpService()
        const target = options?.itemIds && options.itemIds.length > 0
          ? connections.filter((connection) => options.itemIds!.includes(connection.id))
          : connections

        const errors: string[] = []
        let cleared = 0
        for (const connection of target) {
          try {
            await service.deleteConnection(connection.id)
            cleared += 1
          } catch (err) {
            errors.push(`${connection.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        // 全清场景：把 store 文件本身也释放；部分清按 perRecordBytes 折算。
        const freedBytes = target.length === connections.length
          ? bytes
          : perRecordBytes * cleared
        return { clearedItemCount: cleared, freedBytes, errors: errors.length ? errors : undefined }
      },
    })
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    log.warn('storage-manager bucket registration skipped:', err)
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}

type LocalMcpIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

/**
 * Channel→handler 映射。新增/删除 channel 时必须同步更新 ipc-lazy.ts 的
 * LocalMcpIPC channels 列表。
 */
export const localMcpHandlers = {
  'localMcp:discover': (_event: IpcMainInvokeEvent) => getLocalMcpService().discover(),
  'localMcp:listConnections': (_event: IpcMainInvokeEvent) => getLocalMcpService().listConnections(),
  'localMcp:getConnectionDetail': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    options?: { includeSecrets?: boolean },
  ) => getLocalMcpService().getConnectionDetail(connectionId, options),
  'localMcp:shareConnectionToOrganization': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    organizationId: string,
  ) => getLocalMcpService().shareConnectionToOrganization(connectionId, organizationId),
  'localMcp:importCandidate': (
    _event: IpcMainInvokeEvent,
    candidateId: string,
    options?: { attachToAgentId?: string; name?: string },
  ) => getLocalMcpService().importCandidate(candidateId, options),
  'localMcp:saveManualConnection': (_event: IpcMainInvokeEvent, input: LocalMcpManualConnectionInput) =>
    getLocalMcpService().saveManualConnection(input),
  'localMcp:upsertOrganizationMirror': (
    _event: IpcMainInvokeEvent,
    input: LocalMcpOrganizationMirrorInput,
  ) => getLocalMcpService().upsertOrganizationMirror(input),
  'localMcp:attachConnection': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    agentId: string,
    attached: boolean,
  ) => getLocalMcpService().attachConnection(connectionId, agentId, attached),
  'localMcp:setConnectionEnabled': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    enabled: boolean,
  ) => getLocalMcpService().setConnectionEnabled(connectionId, enabled),
  'localMcp:deleteConnection': async (_event: IpcMainInvokeEvent, connectionId: string) => {
    await getLocalMcpService().deleteConnection(connectionId)
    return { ok: true }
  },
  'localMcp:probeConnection': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    options?: { timeoutMs?: number; openOAuthWindow?: boolean },
  ) => getLocalMcpService().probeConnection(connectionId, options),
  'localMcp:cancelProbe': (
    _event: IpcMainInvokeEvent,
    connectionId: string,
  ) => getLocalMcpService().cancelProbe(connectionId).then(cancelled => ({ cancelled })),
  'localMcp:waitForPlatformOAuthTicket': (
    _event: IpcMainInvokeEvent,
    input: { authorizeUrl: string; donePathIncludes?: string; timeoutMs?: number },
  ) => waitForPlatformOAuthTicket(input),
  'localMcp:closePlatformOAuthWindow': () => {
    closeConnectorOAuthWindow()
    return { ok: true as const }
  },
} satisfies Record<string, LocalMcpIpcHandler>

export function registerLocalMcpIPC(): void {
  for (const channel of Object.keys(localMcpHandlers)) {
    try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
  }
  for (const [channel, handler] of Object.entries(localMcpHandlers)) {
    guardedHandle(channel, handler as LocalMcpIpcHandler)
  }
}
