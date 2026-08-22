export const MCP_ERR_PREFIX = 'MCP_ERR:'

export const McpErrorCode = {
  CONNECTION_NOT_FOUND: 'MCP_ERR:CONNECTION_NOT_FOUND',
  CANDIDATE_NOT_FOUND: 'MCP_ERR:CANDIDATE_NOT_FOUND',
  NAME_REQUIRED: 'MCP_ERR:NAME_REQUIRED',
  HTTP_URL_REQUIRED: 'MCP_ERR:HTTP_URL_REQUIRED',
  STDIO_COMMAND_REQUIRED: 'MCP_ERR:STDIO_COMMAND_REQUIRED',
  ONLY_MANUAL_EDITABLE: 'MCP_ERR:ONLY_MANUAL_EDITABLE',
  NO_ATTACHED_CONNECTIONS: 'MCP_ERR:NO_ATTACHED_CONNECTIONS',
  CONNECTION_NOT_ATTACHED: 'MCP_ERR:CONNECTION_NOT_ATTACHED',
  DUPLICATE_SERVER_NAME: 'MCP_ERR:DUPLICATE_SERVER_NAME',
  SERVER_NAME_NOT_FOUND: 'MCP_ERR:SERVER_NAME_NOT_FOUND',
  MULTIPLE_SERVERS: 'MCP_ERR:MULTIPLE_SERVERS',
  OPERATION_TIMEOUT: 'MCP_ERR:OPERATION_TIMEOUT',
  PROBE_TIMEOUT: 'MCP_ERR:PROBE_TIMEOUT',
  AUTHORIZATION_REQUIRED: 'MCP_ERR:AUTHORIZATION_REQUIRED',
  AGENT_ACCESS_DENIED: 'MCP_ERR:AGENT_ACCESS_DENIED',
  SESSION_REVOKED: 'MCP_ERR:SESSION_REVOKED',
} as const

export type McpErrorCodeValue = typeof McpErrorCode[keyof typeof McpErrorCode]

export function parseMcpError(message: string): { code: string; params?: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(message)
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.code === 'string'
      && parsed.code.startsWith(MCP_ERR_PREFIX)
    ) {
      return { code: parsed.code.replace(MCP_ERR_PREFIX, ''), params: parsed.params }
    }
  } catch {
    // plain code string, not JSON
  }
  if (!message.startsWith(MCP_ERR_PREFIX)) return null
  return { code: message.replace(MCP_ERR_PREFIX, '') }
}

export type LocalMcpSourceKind =
  | 'cursor'
  | 'claude'
  | 'claude-code'
  | 'windsurf'
  | 'vscode'
  | 'manual'
  | 'organization'

export type LocalMcpTransportKind = 'stdio' | 'http'

export interface LocalMcpSourceRef {
  kind: LocalMcpSourceKind
  label: string
  path?: string
  /** scope=remote 时对应后端 MCPConnection.id */
  orgConnectionId?: string
}

export interface LocalMcpStdioConfig {
  kind: 'stdio'
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface LocalMcpHttpConfig {
  kind: 'http'
  url: string
  headers?: Record<string, string>
}

export type LocalMcpTransportConfig =
  | LocalMcpStdioConfig
  | LocalMcpHttpConfig

export interface LocalMcpToolSummary {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  readOnly?: boolean
  destructive?: boolean
  openWorld?: boolean
}

export interface LocalMcpResourceSummary {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface LocalMcpPromptSummary {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

export interface LocalMcpProbeSummary {
  ok: boolean
  probedAt: string
  tools: LocalMcpToolSummary[]
  resources: LocalMcpResourceSummary[]
  prompts: LocalMcpPromptSummary[]
  error?: string
}

export interface LocalMcpCandidateSummary {
  id: string
  name: string
  source: LocalMcpSourceRef
  transportKind: LocalMcpTransportKind
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envKeys: string[]
  headerKeys: string[]
  importedConnectionId?: string
  attachedAgentIds?: string[]
}

export interface LocalMcpConnectionSummary {
  id: string
  name: string
  /** 用户填写的可选描述；卡片优先展示，空则回退传输摘要 */
  description?: string
  source: LocalMcpSourceRef
  transportKind: LocalMcpTransportKind
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  envKeys: string[]
  headerKeys: string[]
  enabled: boolean
  attachedAgentIds: string[]
  /** v1 Space 绑定无法安全映射时为 true，设置页应要求用户重新选择 Agent。 */
  requiresAgentSelection: boolean
  createdAt: string
  updatedAt: string
  lastProbe?: LocalMcpProbeSummary
}

export interface LocalMcpConnectionDetail extends LocalMcpConnectionSummary {
  transport: LocalMcpTransportConfig
}

export interface LocalMcpManualConnectionInput {
  connectionId?: string
  name: string
  description?: string
  transport: LocalMcpTransportConfig
  attachToAgentId?: string
  enabled?: boolean
}

/** 将组织 remote 连接镜像到本机（不含明文凭据） */
export interface LocalMcpOrganizationMirrorInput {
  orgConnectionId: string
  name: string
  description?: string
  url: string
  headerKeys?: string[]
  enabled?: boolean
}

export interface LocalMcpDiscoveryResult {
  timestamp: number
  candidates: LocalMcpCandidateSummary[]
}

export interface LocalMcpServerRuntimeSummary {
  connectionId: string
  serverName: string
  sourceLabel: string
  transportKind: LocalMcpTransportKind
}

export interface LocalMcpToolCallResult {
  server: LocalMcpServerRuntimeSummary
  toolName: string
  isError: boolean
  content: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  contentTruncated?: boolean
  structuredContentTruncated?: boolean
}

export interface LocalMcpResourceReadResult {
  server: LocalMcpServerRuntimeSummary
  uri: string
  contents: Array<Record<string, unknown>>
  contentsTruncated?: boolean
}

export interface LocalMcpPromptReadResult {
  server: LocalMcpServerRuntimeSummary
  promptName: string
  description?: string
  messages: Array<Record<string, unknown>>
  messagesTruncated?: boolean
}
